"""Native usage telemetry and attributed public benchmark data. No inference calls."""
import csv
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import io
import json
import math
from pathlib import Path
import re
import subprocess
import threading
import time
from urllib.request import Request, urlopen
from benchmark_sources import ARENA_URL, LCB_URL, arena_data, livecode_data, developer_data, next_payloads, walk

BENCHMARK_SCHEMA = 2

LIVEBENCH = 'https://raw.githubusercontent.com/LiveBench/livebench.github.io/main/public/'
WEIGHTS = {'default': {'Reasoning': 0.4, 'IF': 0.3, 'Coding': 0.3}, 'task': {'Coding': 0.4, 'Agentic Coding': 0.35, 'IF': 0.25}, 'smol': {'Coding': 0.35, 'IF': 0.45, 'Reasoning': 0.2}}
AA_WEIGHTS = {'default': {'AA-LCR': 0.5, 'GPQA': 0.3, 'SciCode': 0.2}, 'task': {'Terminal-Bench 4.0': 0.55, 'SciCode': 0.45}, 'smol': {'SciCode': 0.6, 'AA-LCR': 0.4}}
# No vision, visual-design or domain-specific role score from text/coding benchmarks.


def download(url, max_bytes=4_000_000):
    req = Request(url, headers={'User-Agent': 'ManaTape/1.0 (benchmark dashboard)'})
    with urlopen(req, timeout=20) as response:
        raw = response.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError('Dataset too large')
    return raw.decode('utf-8-sig')


def artificial_analysis():
    # Read only data embedded in the public model page. No gated API or private data.
    url = 'https://artificialanalysis.ai/models/claude-fable-5-1'
    html = download(url)
    found = {}
    for payload in next_payloads(html):
        for x in walk(payload):
            if 'intelligenceIndex' in x and isinstance(x.get('release'), dict) and x.get('slug') and x.get('name'):
                found[x['slug']] = x
    version = re.search(r'Intelligence Index v(\d+\.\d+(?:\.\d+)?)', html)
    if not found or not version:
        raise ValueError('Public benchmark schema changed')
    records = []
    for model in found.values():
        scores = {}
        for field, label in {'scicode': 'SciCode', 'terminalBench40': 'Terminal-Bench 4.0',
                'lcr': 'AA-LCR', 'gpqa': 'GPQA', 'hle': 'HLE', 'ifbench': 'IFBench', 'mmmuPro': 'MMMU-Pro'}.items():
            value = model.get(field)
            if isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value <= 1:
                scores[label] = round(value * 100, 2)
        if not scores:
            continue
        records.append({'id': model['name'], 'baseId': model['release']['slug'],
            'effort': (model.get('effort') or {}).get('slug', ''),
            'release': 'AA ' + version.group(1) + ' · ' + time.strftime('%Y-%m-%d', time.gmtime()),
            'scores': scores, 'source': 'Artificial Analysis', 'url': 'https://artificialanalysis.ai/models/' + model['slug'],
            'dataUrl': url, 'snapshot': time.time()})
    return records


def livebench_data():
    files = json.loads(download('https://api.github.com/repos/LiveBench/livebench.github.io/contents/public'))
    dates = sorted(m.group(1) for f in files if (m := re.fullmatch(r'table_(\d{4}_\d{2}_\d{2})\.csv', f['name'])))
    records = []
    # Latest release plus the preceding one for models no longer in the newest table.
    for date in dates[-2:]:
        categories = json.loads(download(LIVEBENCH + 'categories_' + date + '.json'))
        for row in csv.DictReader(io.StringIO(download(LIVEBENCH + 'table_' + date + '.csv'))):
            scores = {}
            for name, columns in categories.items():
                values = [float(row[c]) for c in columns if (row.get(c) or '').strip() not in ('', '-', 'N/A')]
                if len(values) == len(columns) and all(math.isfinite(v) and 0 <= v <= 100 for v in values):
                    scores[name] = round(sum(values) / len(values), 2)
            records.append({'id': row['model'], 'release': date.replace('_', '-'), 'scores': scores,
                'source': 'LiveBench', 'url': 'https://livebench.ai/', 'dataUrl': LIVEBENCH + 'table_' + date + '.csv'})
    if not records:
        raise ValueError('No benchmark rows')
    return records


def benchmark_data(previous=None):
    previous = previous or {}
    loaders = {'LiveBench': livebench_data, 'Artificial Analysis': artificial_analysis,
               'LiveCodeBench': lambda: livecode_data(json.loads(download(LCB_URL, 12_000_000))),
               'Arena': lambda: arena_data(download(ARENA_URL)), 'Розробник': developer_data}
    records, sources = [], {}
    now = time.time()
    # An unavailable source cannot discard successful updates from other sources.
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {name: pool.submit(loader) for name, loader in loaders.items()}
        for name, future in pending.items():
            try:
                rows = future.result()
                if not rows:
                    raise ValueError('Empty benchmark source')
                sources[name] = {'at': now, 'error': ''}
            except Exception:
                rows = [r for r in previous.get('records', []) if r.get('source') == name]
                sources[name] = {'at': previous.get('sources', {}).get(name, {}).get('at', previous.get('at', 0)),
                                 'error': 'Не оновилось; останній знімок.' if rows else 'Джерело недоступне.'}
            records.extend(rows)
    errors = [name for name, status in sources.items() if status['error']]
    return {'records': records, 'at': now, 'schema': BENCHMARK_SCHEMA, 'sources': sources,
            'weights': WEIGHTS, 'weightsAA': AA_WEIGHTS,
            'error': 'Не оновились: ' + ', '.join(errors) if errors else ''}


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def iso_time(value):
    """Epoch seconds from an ISO-8601 string; ValueError for anything else."""
    if not isinstance(value, str):
        raise ValueError('Expected an ISO-8601 time')
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def commandcode_report(payload):
    """Only usage numbers cross from the Mac; browser credentials stay in CodexBar."""
    rows = payload if isinstance(payload, list) else [payload]
    row = next((r for r in rows if isinstance(r, dict) and r.get('provider') == 'commandcode' and isinstance(r.get('usage'), dict)), None)
    if not row:
        raise ValueError('CommandCode usage unavailable')
    usage, limits = row['usage'], []
    for key, label in [('primary', '5 год'), ('secondary', 'Тиждень'), ('tertiary', 'Місяць')]:
        window = usage.get(key) if isinstance(usage.get(key), dict) else {}
        used = window.get('usedPercent')
        if not finite_number(used):
            continue
        reset = window.get('resetsAt')
        minutes = window.get('windowMinutes')
        limits.append({'id': key, 'label': label, 'window': label,
            'windowMinutes': minutes if finite_number(minutes) else None,
            'remaining': round(max(0, min(100, 100 - used)), 1),
            'resets': iso_time(reset) * 1000 if isinstance(reset, str) and reset else None})
    if not limits:
        raise ValueError('CommandCode returned no usage windows')
    return {'provider': 'commandcode', 'account': 1, 'limits': limits,
        'at': iso_time(usage.get('updatedAt')), 'plan': '', 'source': 'CodexBar · Mac'}


def merge_shared(limits):
    """One shared pool can arrive once per model family (Antigravity reports «Claude & GPT (shared)»
    under both anthropic and openai ids); identical readings are the same window."""
    merged = {}
    for limit in limits:
        same = tuple(limit.get(k) for k in ('label', 'window', 'remaining', 'resets', 'starts', 'durationMs', 'status', 'tier'))
        if same in merged:
            first = merged[same] = {**merged[same]}
            first['models'] = list(first.get('models') or []) + [m for m in limit.get('models') or [] if m not in (first.get('models') or [])]
        else:
            merged[same] = limit
    return list(merged.values())


def balance_of(amount):
    """What is left in the provider's own units: `remaining`, else `limit − used`, with the cap when one is reported.
    None without an absolute reading: a fraction alone is no amount."""
    left = amount.get('remaining')
    cap = amount['limit'] if finite_number(amount.get('limit')) and amount['limit'] > 0 else None
    if not finite_number(left):
        left = cap - amount['used'] if cap is not None and finite_number(amount.get('used')) else None
    if left is None:
        return None
    unit = amount.get('unit')
    return {'remaining': round(max(0, left), 4), **({'limit': cap} if cap is not None else {}),
            'unit': unit if isinstance(unit, str) else ''}


def usage_report(report, account):
    """One native `omp usage` report; a malformed one raises and is skipped alone."""
    limits = []
    for raw in report.get('limits') or []:
        amount = raw.get('amount') or {}
        value = amount.get('remainingFraction')
        if value is None and finite_number(amount.get('usedFraction')):
            value = 1 - amount['usedFraction']
        window, scope = raw.get('window') or {}, raw.get('scope') or {}
        limit = {'id': raw['id'], 'label': raw['label'],
            # NaN or true is not a measurement: unknown, never "100 % left". A balance without a fraction has no %.
            'remaining': round(max(0, min(1, value)) * 100, 1) if finite_number(value) else None,
            'resets': window.get('resetsAt'), 'starts': window.get('startsAt'),
            'durationMs': window.get('durationMs'), 'window': window.get('label', ''), 'status': raw.get('status'),
            'models': scope.get('modelIds', []), 'tier': scope.get('tier', '')}
        balance = balance_of(amount)
        if balance:
            limit['balance'] = balance
        limits.append(limit)
    limits = merge_shared(limits)
    fetched = report.get('fetchedAt', 0)
    if not finite_number(fetched):
        raise ValueError('fetchedAt')
    return {'provider': report['provider'], 'account': account, 'at': fetched / 1000,
        'plan': (report.get('metadata') or {}).get('planType', ''), 'limits': limits}


# CodexBar and OMP read the same CommandCode account when its 5 h and weekly remaining agree this closely (points).
CODEXBAR_MATCH = 0.2
FRESH = 900


def plan_cap(units, percent):
    """The roundest whole cap consistent with `units` left at `percent` (CodexBar rounds to 0.1 pt; the two readings may
    be minutes apart, hence the 2 % slack). An estimate only, shown as «~70»; None when the percentage is too coarse."""
    if not (finite_number(units) and finite_number(percent)) or units <= 0 or not 1 <= percent <= 100:
        return None
    low, high = units * 100 / (percent + .05) * .98, units * 100 / (percent - .05) * 1.02
    for grain in (100, 50, 10, 5, 1):
        cap = math.ceil(low / grain) * grain
        if cap <= high:
            return cap
    return None


def commandcode_month(limit):
    """CommandCode meters the subscription itself in plan units (`credits` in its API; nothing was bought): its
    windowless balance is what is left of the monthly plan allowance, so the panel calls it «Місяць»."""
    windowless = not limit.get('window') and (limit.get('balance') or str(limit.get('id', '')).endswith(':balance'))
    return {**limit, 'label': 'Місяць', 'window': 'Місяць'} if windowless else limit


def codexbar_account(reports, external, now):
    """The one native CommandCode account CodexBar measured: its 5 h and weekly remaining both agree with CodexBar's
    within CODEXBAR_MATCH points, and the two readings are fresh and close in time. None when stale or ambiguous."""
    if not external or not finite_number(external.get('at')) or now - external['at'] > FRESH:
        return None
    theirs = {l.get('id'): l.get('remaining') for l in external.get('limits') or []}
    found = []
    for n, report in enumerate(reports):
        if report.get('provider') != 'commandcode' or not finite_number(report.get('at')) or abs(report['at'] - external['at']) > FRESH:
            continue
        ours = {str(l.get('id', '')).rsplit(':', 1)[-1]: l.get('remaining') for l in report.get('limits') or []}
        if all(finite_number(ours.get(own)) and finite_number(theirs.get(bar)) and abs(ours[own] - theirs[bar]) <= CODEXBAR_MATCH + 1e-9
               for own, bar in (('5h', 'primary'), ('7d', 'secondary'))):
            found.append(n)
    return found[0] if len(found) == 1 else None


def commandcode_view(reports, external=None, now=None):
    """Every native CommandCode account shows its balance as «Місяць»; the account CodexBar measured (codexbar_account)
    also gets CodexBar's monthly % and reset there, and a cap estimated from that % and its own balance."""
    now = time.time() if now is None else now
    reports = [{**r, 'limits': [commandcode_month(l) for l in r['limits']]} if r.get('provider') == 'commandcode' else r
               for r in reports]
    n = codexbar_account(reports, external, now)
    month = next((l for l in (external or {}).get('limits') or [] if l.get('id') == 'tertiary' and finite_number(l.get('remaining'))), None)
    if n is None or not month:
        return reports
    limits = list(reports[n]['limits'])
    at = next((i for i, l in enumerate(limits) if l.get('window') == 'Місяць'), None)
    own = limits[at] if at is not None else {'id': 'commandcode:balance', 'starts': None, 'durationMs': None,
                                             'status': None, 'models': [], 'tier': ''}
    merged = {**own, 'label': 'Місяць', 'window': 'Місяць', 'remaining': month['remaining'], 'resets': month.get('resets'),
              'windowMinutes': month.get('windowMinutes'), 'source': external.get('source') or 'CodexBar'}
    balance = own.get('balance')
    cap = plan_cap((balance or {}).get('remaining'), month['remaining'])
    if balance and cap and 'limit' not in balance:
        merged['balance'] = {**balance, 'limit': cap, 'estimated': True}
    if at is None:
        limits.append(merged)
    else:
        limits[at] = merged
    reports[n] = {**reports[n], 'limits': limits}
    if cap:
        reports = same_plan_months(reports, n, cap)
    return reports


def plan_signature(report):
    """A CommandCode plan is identified by its 5 h and weekly caps in plan units (e.g. 14 and 35)."""
    caps = {str(l.get('id', '')).rsplit(':', 1)[-1]: (l.get('balance') or {}).get('limit') for l in report.get('limits') or []}
    return (caps.get('5h'), caps.get('7d')) if finite_number(caps.get('5h')) and finite_number(caps.get('7d')) else None


def same_plan_months(reports, n, cap):
    """Accounts on the same plan as the one CodexBar measured share its monthly cap: their % is the balance over that
    cap, marked as an estimate. Reset times stay unknown — they are per account."""
    plan = plan_signature(reports[n])
    if plan is None:
        return reports
    out = list(reports)
    for m, report in enumerate(reports):
        if m == n or report.get('provider') != 'commandcode' or plan_signature(report) != plan:
            continue
        limits = list(report['limits'])
        for i, limit in enumerate(limits):
            balance = limit.get('balance') or {}
            if limit.get('window') == 'Місяць' and not finite_number(limit.get('remaining')) and finite_number(balance.get('remaining')):
                limits[i] = {**limit, 'remaining': round(max(0, min(100, balance['remaining'] * 100 / cap)), 1),
                             'balance': {**balance, 'limit': cap, 'estimated': True}, 'planEstimate': True}
        out[m] = {**report, 'limits': limits}
    return out


class Insights:
    def __init__(self, app, write):
        self.app = app
        # The server's atomic writer, passed in rather than imported back from server.py.
        self.write = write
        self.lock = threading.Lock()
        self.path = app.state_dir / 'insights.json'
        bundled = Path(__file__).parent / 'benchmarks.json'
        self.data = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {
            'usage': {'at': 0, 'reports': [], 'error': ''}, 'stats': {'at': 0},
            'benchmarks': json.loads(bundled.read_text(encoding='utf-8')) if bundled.exists() else {'at': 0, 'records': [], 'weights': WEIGHTS}}

    def native(self, args, timeout):
        r = subprocess.run([self.app.omp, *args], cwd=self.app.state_dir, env=self.app.native_env, capture_output=True, timeout=timeout)
        if r.returncode:
            raise ValueError('Native command failed')
        out = r.stdout.decode('utf-8')
        return json.loads(out[out.index('{'):])

    def snapshot(self, app=None):
        """Telemetry as one scope shows it. One Insights serves every scope of an OMP agent directory (`omp usage` and
        `omp stats` are per agent directory); benchmark weights follow the asking scope's ui."""
        app = app or self.app
        usage = self.data['usage']
        # Snapshots stored before merge_shared existed still carry the duplicates.
        reports = [{**r, 'limits': merge_shared(r.get('limits') or [])} for r in usage['reports']]
        external, now = None, time.time()
        # The Mac launcher pushes CodexBar's snapshot into the state directory it was configured with.
        for folder in dict.fromkeys((app.state_dir, self.app.state_dir)):
            try:
                found = json.loads((folder / 'commandcode-usage.json').read_text(encoding='utf-8'))
                if found.get('provider') == 'commandcode' and found.get('limits'):
                    external = {**found, 'stale': now - found['at'] > FRESH}
                    break
            except (OSError, ValueError, KeyError, TypeError):
                pass
        if any(r['provider'] == 'commandcode' for r in reports):
            # OMP's own accounts stand; CodexBar only completes the month of the account it measured.
            reports = commandcode_view(reports, external, now)
        elif external:
            reports.append(external)
        benchmarks = {**self.data.get('benchmarks', {}), 'weights': app.ui.get('benchmarkWeights', WEIGHTS), 'weightsAA': app.ui.get('benchmarkWeightsAA', AA_WEIGHTS)}
        return {**self.data, 'benchmarks': benchmarks, 'usage': {**usage, 'reports': reports}}

    def failed(self, section, message):
        """Record a failed refresh; True only when the stored text actually changes."""
        if self.data[section].get('error') == message:
            return False
        self.data[section]['error'] = message
        return True

    def update(self, force=False):
        """Periodic refresh; `force` (the panel's «Оновити») re-reads usage right away, at most every 20 s, so a
        logged-out account disappears without waiting for the five-minute cycle."""
        if not self.lock.acquire(False):
            return
        try:
            now, changed = time.time(), False
            if now - self.data['usage'].get('at', 0) >= (20 if force else 300):
                try:
                    native = self.native(['usage', '--json', '--redact'], 60)
                    reports, skipped = [], 0
                    for n, report in enumerate(native.get('reports', [])):
                        try:
                            reports.append(usage_report(report, n + 1))
                        except Exception:
                            # One malformed provider report must not discard every other fresh one.
                            skipped += 1
                    self.data['usage'] = {'at': now, 'reports': reports,
                        'error': 'Частину звітів лімітів не прочитано; показано решту.' if skipped else ''}
                    changed = True
                except Exception:
                    changed |= self.failed('usage', 'Ліміти не оновились; збережено попередні показники.')
            if now - self.data['stats'].get('at', 0) >= 600:
                try:
                    stats = self.native(['stats', '--json'], 120)
                    self.data['stats'] = {k: stats[k] for k in ('overall', 'byModel', 'byAgentType', 'timeSeries') if k in stats}
                    self.data['stats'].update({'at': now, 'error': '', 'scope': 'Реєстр OMP · усі його проєкти'})
                    changed = True
                except Exception:
                    changed |= self.failed('stats', 'Статистика не оновилась; збережено попередній звіт.')
            if (now - self.data['benchmarks'].get('at', 0) >= 86400
                    or self.data['benchmarks'].get('schema') != BENCHMARK_SCHEMA):
                try:
                    self.data['benchmarks'] = benchmark_data(self.data['benchmarks'])
                    changed = True
                except Exception:
                    changed |= self.failed('benchmarks', 'Джерело тестів недоступне; показано останній знімок.')
            # Nothing new means no rewrite and fsync of the ~0.5 MB file every minute.
            if changed or not self.path.exists():
                self.write(self.path, json.dumps(self.data, ensure_ascii=False).encode())
        finally:
            self.lock.release()

    def loop(self):
        while True:
            self.update()
            time.sleep(60)
