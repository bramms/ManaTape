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
from benchmark_sources import ARENA_URL, LCB_URL, arena_data, livecode_data, developer_data

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


def artificial_analysis(html=None):
    # Read only data embedded in the public model page. No gated API or private data.
    url = 'https://artificialanalysis.ai/models/claude-fable-5-1'
    html = html or download(url)
    parts, found = [], {}
    for raw in re.findall(r'self\.__next_f\.push\((\[1,.*?\])\)</script>', html, re.S):
        try:
            parts.append(json.loads(raw)[1])
        except ValueError:
            continue
    def visit(x):
        if isinstance(x, dict):
            if 'intelligenceIndex' in x and isinstance(x.get('release'), dict) and x.get('slug') and x.get('name'):
                found[x['slug']] = x
            for value in x.values():
                visit(value)
        elif isinstance(x, list):
            for value in x:
                visit(value)
    for line in ''.join(parts).splitlines():
        try:
            visit(json.loads(line.split(':', 1)[1]))
        except (ValueError, IndexError):
            continue
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


def commandcode_report(payload):
    """Only usage numbers cross from the Mac; browser credentials stay in CodexBar."""
    rows = payload if isinstance(payload, list) else [payload]
    row = next((r for r in rows if r.get('provider') == 'commandcode' and r.get('usage')), None)
    if not row:
        raise ValueError('CommandCode usage unavailable')
    usage, limits = row['usage'], []
    for key, label in [('primary', '5 год'), ('secondary', 'Тиждень'), ('tertiary', 'Місяць')]:
        window = usage.get(key) or {}
        used = window.get('usedPercent')
        if not isinstance(used, (int, float)) or not math.isfinite(used):
            continue
        reset = window.get('resetsAt')
        limits.append({'id': key, 'label': label, 'window': label,
            'windowMinutes': window.get('windowMinutes'),
            'remaining': round(max(0, min(100, 100 - used)), 1),
            'resets': datetime.fromisoformat(reset.replace('Z', '+00:00')).timestamp() * 1000 if reset else None})
    if not limits:
        raise ValueError('CommandCode returned no usage windows')
    return {'provider': 'commandcode', 'account': 1, 'limits': limits,
        'at': datetime.fromisoformat(usage['updatedAt'].replace('Z', '+00:00')).timestamp(),
        'plan': '', 'source': 'CodexBar · Mac'}


class Insights:
    def __init__(self, app):
        self.app = app
        self.lock = threading.Lock()
        self.path = app.state_dir / 'insights.json'
        bundled = Path(__file__).parent / 'benchmarks.json'
        self.data = json.loads(self.path.read_text()) if self.path.exists() else {
            'usage': {'at': 0, 'reports': [], 'error': ''}, 'stats': {'at': 0},
            'benchmarks': json.loads(bundled.read_text()) if bundled.exists() else {'at': 0, 'records': [], 'weights': WEIGHTS}}

    def native(self, args, timeout):
        r = subprocess.run([self.app.omp, *args], cwd=self.app.state_dir, env=self.app.native_env, capture_output=True, timeout=timeout)
        if r.returncode:
            raise ValueError('Native command failed')
        out = r.stdout.decode()
        return json.loads(out[out.index('{'):])

    def snapshot(self):
        usage = self.data['usage']
        reports = list(usage['reports'])
        if not any(r['provider'] == 'commandcode' for r in reports):
            try:
                external = json.loads((self.app.state_dir / 'commandcode-usage.json').read_text())
                if external.get('provider') == 'commandcode' and external.get('limits'):
                    external['stale'] = time.time() - external['at'] > 900
                    reports.append(external)
            except (OSError, ValueError, KeyError, TypeError):
                pass
        benchmarks = {**self.data.get('benchmarks', {}), 'weights': self.app.ui.get('benchmarkWeights', WEIGHTS), 'weightsAA': self.app.ui.get('benchmarkWeightsAA', AA_WEIGHTS)}
        return {**self.data, 'benchmarks': benchmarks, 'usage': {**usage, 'reports': reports}}

    def update(self, force=False):
        if not self.lock.acquire(False):
            return
        try:
            now = time.time()
            if force or now - self.data['usage'].get('at', 0) >= 300:
                try:
                    native = self.native(['usage', '--json', '--redact'], 60)
                    reports = []
                    for n, report in enumerate(native.get('reports', [])):
                        limits = []
                        for raw in report.get('limits', []):
                            amount = raw.get('amount', {})
                            value = amount.get('remainingFraction')
                            if value is None and amount.get('usedFraction') is not None:
                                value = 1 - amount['usedFraction']
                            limits.append({'id': raw['id'], 'label': raw['label'],
                                'remaining': round(max(0, min(1, value)) * 100, 1) if isinstance(value, (int, float)) else None,
                                'resets': raw.get('window', {}).get('resetsAt'),
                                'starts': raw.get('window', {}).get('startsAt'),
                                'durationMs': raw.get('window', {}).get('durationMs'),
                                'window': raw.get('window', {}).get('label', ''), 'status': raw.get('status'),
                                'models': raw.get('scope', {}).get('modelIds', []), 'tier': raw.get('scope', {}).get('tier', '')})
                        reports.append({'provider': report['provider'], 'account': n + 1,
                            'at': report.get('fetchedAt', 0) / 1000, 'plan': report.get('metadata', {}).get('planType', ''), 'limits': limits})
                    self.data['usage'] = {'at': now, 'reports': reports, 'error': ''}
                except Exception:
                    self.data['usage']['error'] = 'Ліміти не оновились; збережено попередні показники.'
            if force or now - self.data['stats'].get('at', 0) >= 600:
                try:
                    stats = self.native(['stats', '--json'], 120)
                    self.data['stats'] = {k: stats[k] for k in ('overall', 'byModel', 'byAgentType', 'timeSeries') if k in stats}
                    self.data['stats'].update({'at': now, 'error': '', 'scope': 'Реєстр OMP · усі його проєкти'})
                except Exception:
                    self.data['stats']['error'] = 'Статистика не оновилась; збережено попередній звіт.'
            if (now - self.data['benchmarks'].get('at', 0) >= 86400
                    or self.data['benchmarks'].get('schema') != BENCHMARK_SCHEMA):
                try:
                    self.data['benchmarks'] = benchmark_data(self.data['benchmarks'])
                except Exception:
                    self.data['benchmarks']['error'] = 'Джерело тестів недоступне; показано останній знімок.'
            from server import atomic
            atomic(self.path, json.dumps(self.data, ensure_ascii=False).encode())
        finally:
            self.lock.release()

    def loop(self):
        while True:
            self.update()
            time.sleep(60)
