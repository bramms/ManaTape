#!/usr/bin/env python3
"""Create a credential-free, offline fixture; never read native OMP state."""
import argparse
from datetime import datetime, timezone
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from server import Forge, yaml_dump, yaml_load


def demo_root(root):
    marker = root / 'MANA_TAPE_DEMO'
    if root.is_symlink():
        raise SystemExit('Refusing to follow a demo directory symlink.')
    if root.exists() and any(root.iterdir()) and not marker.exists():
        raise SystemExit('Refusing to write a non-demo directory.')
    root.mkdir(exist_ok=True)
    marker.touch()


def seed():
    root = REPO / '.dev'
    demo_root(root)
    project, agent, state = (root / name for name in ('project', 'agent', 'state'))
    (project / '.omp/presets').mkdir(parents=True, exist_ok=True)
    agent.mkdir(exist_ok=True)
    state.mkdir(exist_ok=True)
    roles = 'default task smol researcher reviewer vision'.split()
    base = {'modelRoles': {role: 'demo-studio/cut-a:high' for role in roles},
            'retry': {'fallbackChains': {'default': ['demo-studio/cut-b', 'demo-free/cut-c']}},
            'task': {'agentModelOverrides': {'task': ['@task', 'demo-studio/cut-b'], 'sonic': ['@smol', 'demo-free/cut-c']}},
            'disabledProviders': []}
    models = [dict(id='cut-a', name='Demo CUT A', input=['text','image'], thinking=['low','high'], reasoning=True, contextWindow=128000),
              dict(id='cut-b', name='Demo CUT B', input=['text'], reasoning=False, contextWindow=64000)]
    providers = {'demo-studio': dict(api='openai-completions', baseUrl='https://example.invalid/v1', auth='none', models=models),
                 'demo-free': dict(api='openai-completions', baseUrl='https://example.invalid/v1', auth='none', models=[dict(id='cut-c', name='Demo CUT C Free', input=['text'], reasoning=False, cost=dict(input=0,output=0))])}
    files = {project / '.omp/config.yml': '# Synthetic development fixture. No real accounts.\n' + yaml_dump(base),
             project / '.omp/presets/demo-b.yml': yaml_dump({'modelRoles': {'task': 'demo-studio/cut-b'}}),
             agent / 'models.yml': yaml_dump({'providers': providers})}
    for path, content in files.items():
        if not path.exists():
            path.write_text(content, encoding='utf-8')
    snapshot = state / 'state.json'
    if not snapshot.exists():
        catalog = {pid+'/'+m['id']: {**m, 'provider':pid} for pid,cfg in providers.items() for m in cfg['models']}
        snapshot.write_text(json.dumps(dict(managed={},catalog=catalog,available=list(catalog),changes=[],favs=[],refreshed=0,error='',backups={},attempted=0)), encoding='utf-8')
    return project, agent, state


def seed_showcase():
    """Rich synthetic demo. Reopening preserves saved edits; no native data is read."""
    demo_root(REPO / '.dev')
    root = REPO / '.dev/showcase'
    demo_root(root)
    project, agent, state = (root / name for name in ('project', 'agent', 'state'))
    if (root / 'SHOWCASE_READY').exists():
        seed_layers(root, project, agent)
        return project, agent, state
    # A partially prepared showcase is not silently reseeded over possible edits.
    if any(p.name != 'MANA_TAPE_DEMO' for p in root.iterdir()):
        raise SystemExit('Incomplete showcase: move .dev/showcase aside before creating it again.')
    (project / '.omp/presets').mkdir(parents=True)
    agent.mkdir()
    state.mkdir()
    now = time.time()

    def model(mid, name, free=False, image=False, reasoning=True):
        return dict(id=mid, name='DEMO · '+name, input=['text', 'image'] if image else ['text'],
                    reasoning=reasoning, thinking=['low', 'medium', 'high'] if reasoning else [],
                    contextWindow=128000 if reasoning else 64000, maxTokens=8192,
                    cost=dict(input=0 if free else .4, output=0 if free else 1.2, cacheRead=0, cacheWrite=0))

    good = [model(f'aurora-{i:02}-free', f'Aurora {i:02} Free', True, True) for i in range(1, 10)]
    good.append(model('deepseek-demo-free', 'DeepSeek Free · синтетична редакція', True, True))
    fast = [model(f'swift-{i:02}-free', f'Swift {i:02} Free', True, reasoning=False) for i in range(1, 17)]
    rows = {
        'demo-studio': [model('atlas-composer', 'Atlas Composer', image=True),
                        model('editor-long-context-multilingual-edition', 'Editor · довга багатомовна редакція з розширеним контекстом'),
                        model('canvas-image', 'Canvas Image', image=True)],
        'demo-cloud': [model('research-lab', 'Research Lab'), model('swift-draft', 'Swift Draft', reasoning=False)],
        'demo-deepseek': [model('deepseek-v4-demo', 'DeepSeek · синтетична платна редакція')],
        'demo-free': good+fast,
        'demo-local': [model('compact-local', 'Compact Local', reasoning=False)],
    }
    providers = {pid: dict(api='openai-completions', baseUrl='https://example.invalid/v1', auth='none', models=models)
                 for pid, models in rows.items()}
    catalog = {pid+'/'+m['id']: {**m, 'provider': pid} for pid, models in rows.items() for m in models}
    pools = {'free-good': ['demo-free/'+m['id'] for m in good], 'free-fast': ['demo-free/'+m['id'] for m in fast]}
    alternatives = ['demo-studio/atlas-composer:high', 'demo-cloud/research-lab:medium',
                    'demo-studio/editor-long-context-multilingual-edition:low', 'demo-cloud/swift-draft', 'demo-studio/canvas-image']
    base = {'modelRoles': {
        'composer': 'demo-deepseek/deepseek-v4-demo:high',
        'curator': alternatives[2], 'investigator': 'demo-deepseek/deepseek-v4-demo:high',
        'proofreader': alternatives[0], 'storyboarder': 'demo-studio/canvas-image', 'quick-notes': 'demo-cloud/swift-draft'},
        'retry': {'fallbackChains': {
            'composer': [alternatives[0], 'mana-pool/free-good', 'mana-pool/free-fast'],
            'curator': ['mana-pool/free-good'], 'investigator': [alternatives[1], 'mana-pool/free-good'],
            'proofreader': ['mana-pool/free-fast'], 'storyboarder': ['mana-pool/free-good'],
            'quick-notes': ['demo-local/compact-local', 'mana-pool/free-fast']}},
        'task': {'agentModelOverrides': {
            'writing-team': ['@composer', 'mana-pool/free-fast'],
            'library-assistant': ['@curator', 'mana-pool/free-good']}}, 'disabledProviders': []}
    (project / '.omp/config.yml').write_text('# DEMO: усі моделі та дані синтетичні.\n'+yaml_dump(base), encoding='utf-8')
    (project / '.omp/presets/without-deepseek.yml').write_text('{}\n', encoding='utf-8')
    (project / '.omp/presets/long-tape.yml').write_text(yaml_dump({
        'retry': {'fallbackChains': {'investigator': alternatives+pools['free-good']+pools['free-fast'][:15]}}}), encoding='utf-8')
    (agent / 'models.yml').write_text(yaml_dump({'providers': providers}), encoding='utf-8')
    app = Forge(project, agent, state, '/does-not-exist', demo=True)
    app.ui = {'visionRoles': ['storyboarder']}
    app.state.update(catalog=catalog, available=list(catalog), refreshed=now, favs=[*alternatives, pools['free-good'][0]])
    app.persist()
    app.save_pools({'revision': app.pools_revision(), 'pools': pools})
    for name in ('standard', 'without-deepseek', 'long-tape'):
        body = {'profile': name, 'revision': app.revision(name), 'changes': [],
                'modeSettings': {'mode': 'no-deepseek' if name == 'without-deepseek' else 'deepseek',
                                 'alternatives': alternatives, 'overrides': {}}}
        body['previewToken'] = app.preview_profile(body)['token']
        app.save_profile(body)

    reports = []
    for pid, remaining in [('demo-studio', [74, 61]), ('demo-cloud', [23, 48, 81, None]), ('demo-deepseek', [8])]:
        limits = []
        for i, left in enumerate(remaining):
            duration = [5*3600000, 7*86400000, 30*86400000, 86400000][i]
            limits.append(dict(id=str(i), label=['5 год', 'Тиждень', 'Місяць', 'Доба'][i],
                               window=['5 год', 'Тиждень', 'Місяць', 'Доба'][i], durationMs=duration,
                               remaining=left, starts=now*1000-duration*.35, resets=now*1000+duration*.65, models=[]))
        reports.append(dict(provider=pid, account=1, at=now, plan='DEMO · вигадані ліміти', source='DEMO', limits=limits))
    reports += commandcode_demo(state, now)
    hour = int(now // 3600)*3600000
    series = [dict(timestamp=hour-(47-i)*3600000, requests=8+(i*7)%37, tokens=2500+(i*1307)%28000,
                   errors=int(i % 17 == 0), cost=round(.03+(i % 11)*.017, 3)) for i in range(48)]
    total = sum(x['requests'] for x in series)
    failed = sum(x['errors'] for x in series)
    app.insights.data = {'usage': {'at': now, 'reports': reports, 'error': ''},
        'benchmarks': {'at': now, 'schema': 2, 'records': [], 'sources': {}, 'error': ''},
        'stats': {'at': now, 'scope': 'DEMO · вигадана історія', 'error': '', 'timeSeries': series,
                  'overall': dict(firstTimestamp=series[0]['timestamp'], lastTimestamp=hour, totalRequests=total,
                                  failedRequests=failed, errorRate=failed/total, cacheRate=.63, avgTtft=740, avgTokensPerSecond=68),
                  'byModel': [dict(model=route.split('/', 1)[1], provider=route.split('/')[0],
                                   totalRequests=round(total*share), totalCost=round(12*share, 2), failedRequests=failed if i==0 else 0,
                                   avgTokensPerSecond=52+i*11, avgTtft=950-i*120)
                              for i, (route, share) in enumerate(zip(alternatives, [.32, .26, .20, .14, .08]))]}}
    app.insights.path.write_text(json.dumps(app.insights.data, ensure_ascii=False), encoding='utf-8')
    config = {'demo': True, 'noRefresh': True, 'omp': '/does-not-exist', 'state': str(root/'runtime'),
              'agent': str(agent), 'projects': [{'id': 'showcase', 'name': 'DEMO · Творча майстерня',
              'path': str(project), 'state': str(state), 'ui': {'visionRoles': ['storyboarder'], 'localProviders': ['demo-local'],
              'roleLabels': dict(composer='Автор', curator='Куратор', investigator='Дослідник', proofreader='Коректор', storyboarder='Розкадрування', **{'quick-notes': 'Швидкі нотатки'}),
              'providerCodes': {'demo-studio': 'STU', 'demo-cloud': 'CLD', 'demo-free': 'FREE', 'demo-deepseek': 'DS', 'demo-local': 'GPU'},
              'providerLabels': {'demo-studio': 'DEMO Studio', 'demo-cloud': 'DEMO Cloud', 'demo-free': 'DEMO Free', 'demo-deepseek': 'DEMO DeepSeek', 'demo-local': 'DEMO Local'}}}]}
    (root/'installation.yml').write_text(yaml_dump(config), encoding='utf-8')
    (root/'SHOWCASE_READY').write_text('Synthetic showcase. No native accounts or inference.\n', encoding='utf-8')
    seed_layers(root, project, agent)
    return project, agent, state


def commandcode_demo(state, now):
    """Two synthetic CommandCode accounts in OMP's own shape (plan units, a windowless balance) through the real
    normalisation, and a CodexBar snapshot of the first one, which the panel joins by its 5 h and weekly readings."""
    from insights import commandcode_report, usage_report

    def account(n, used_5h, used_week, balance):
        def window(key, label, cap, used, ms, left):
            return {'id': 'commandcode:' + key, 'label': label + ' limit', 'status': 'ok',
                    'window': {'id': key, 'label': label, 'durationMs': ms, 'resetsAt': int(now * 1000 + ms * left)},
                    'amount': {'used': used, 'limit': cap, 'usedFraction': used / cap, 'unit': 'credits'}}
        report = usage_report({'provider': 'commandcode', 'fetchedAt': now * 1000, 'limits': [
            window('5h', '5-hour', 14, used_5h, 18000000, .45), window('7d', 'Weekly', 35, used_week, 604800000, .6),
            {'id': 'commandcode:balance', 'label': 'Credit balance', 'amount': {'remaining': balance, 'unit': 'credits'}}]}, n)
        return {**report, 'plan': 'DEMO · вигадані ліміти', 'source': 'DEMO'}

    used, fresh = account(1, 0.686, 7.875, 3.68), account(2, 0, 0, 70)
    iso = lambda at: datetime.fromtimestamp(at, timezone.utc).isoformat()
    window = lambda limit: {'usedPercent': round(100 - limit['remaining'], 1), 'resetsAt': iso(limit['resets'] / 1000)}
    codexbar = commandcode_report([{'provider': 'commandcode', 'usage': {'updatedAt': iso(now),
        'primary': {**window(used['limits'][0]), 'windowMinutes': 300}, 'secondary': {**window(used['limits'][1]), 'windowMinutes': 10080},
        'tertiary': {'usedPercent': 94.7, 'resetsAt': iso(now + 8 * 86400), 'windowMinutes': 43200}}}])
    (state / 'commandcode-usage.json').write_text(json.dumps({**codexbar, 'source': 'DEMO · CodexBar'}), encoding='utf-8')
    return [used, fresh]


SHARED_UI = ('localProviders', 'providerCodes', 'providerLabels')


def demo_session(agent, folder, name, cwd):
    """A synthetic OMP session file: a padded title record, then the header that names the cwd (no real history)."""
    path = agent / 'sessions' / folder
    path.mkdir(parents=True, exist_ok=True)
    (path / name).write_text(json.dumps({'type': 'title', 'v': 1, 'title': 'DEMO', 'pad': ' ' * 96}) + '\n'
        + json.dumps({'type': 'session', 'version': 3, 'id': name.split('_')[-1].split('.')[0], 'cwd': str(cwd)}) + '\n', encoding='utf-8')


def seed_layers(root, project, agent):
    """Config layers for the showcase: a Global OMP config with its own roles, chains, an agent and a native preset;
    native presets (котушки) in the project; a second project OMP ran in (discovered from a session header) whose
    file was then changed outside Mana Tape; a directory OMP ran in without .omp/config.yml (a candidate). The old
    `.omp/presets/*.yml` stay for the migration panel. Runs once (LAYERS_READY); an older showcase gains only what
    it lacks, and nothing it already has is overwritten."""
    if (root / 'LAYERS_READY').exists():
        return
    from server import Problem, load_installation
    config_path = root / 'installation.yml'
    config = yaml_load(config_path.read_text(encoding='utf-8'))
    entry = config['projects'][0]
    # Provider names, codes and the local GPU belong to the whole machine: the Global scope shows them too.
    if not config.get('ui'):
        config['ui'] = {k: entry.get('ui', {}).get(k) for k in SHARED_UI if entry.get('ui', {}).get(k)}
        entry['ui'] = {k: v for k, v in entry.get('ui', {}).items() if k not in SHARED_UI}
        config_path.write_text(yaml_dump(config), encoding='utf-8')
    glob = agent / 'config.yml'
    if not glob.exists():
        # Written as OMP itself would leave it: compiled routes, a comment, no Mana Tape record.
        glob.write_text('# DEMO: глобальні налаштування OMP для всіх каталогів (синтетичні).\n' + yaml_dump({
            'modelRoles': {'default': 'demo-studio/atlas-composer:high', 'smol': 'demo-cloud/swift-draft',
                           'slow': 'demo-cloud/research-lab:medium', 'plan': 'demo-studio/editor-long-context-multilingual-edition:low',
                           'curator': 'demo-cloud/research-lab:medium'},
            'retry': {'fallbackChains': {'default': ['demo-cloud/research-lab:medium', 'demo-free/aurora-01-free'],
                                         'smol': ['demo-free/swift-01-free', 'demo-local/compact-local']}},
            'task': {'agentModelOverrides': {'reviewer': ['@slow', 'demo-free/aurora-02-free']}},
            'modelPresets': {'budget': {'modelRoles': {'default': 'demo-free/aurora-01-free', 'smol': 'demo-free/swift-01-free',
                                                       'slow': 'demo-free/aurora-03-free'}}}}), encoding='utf-8')
    notes, sketches = root / 'field-notes', root / 'sketchbook'
    fresh_notes = not (notes / '.omp/config.yml').exists()
    if fresh_notes:
        (notes / '.omp').mkdir(parents=True, exist_ok=True)
        (notes / '.omp/config.yml').write_text('# DEMO: другий проєкт, знайдений в історії сесій OMP.\n' + yaml_dump({
            'modelRoles': {'task': 'demo-cloud/research-lab:medium', 'smol': 'demo-free/swift-02-free'},
            'retry': {'fallbackChains': {'task': ['demo-free/aurora-03-free']}}}), encoding='utf-8')
    sketches.mkdir(exist_ok=True)
    demo_session(agent, '--field-notes--', '2026-10-11T09-12-00-000Z_demo0001.jsonl', notes)
    demo_session(agent, '--sketchbook--', '2026-10-11T18-40-00-000Z_demo0002.jsonl', sketches)
    _, apps = load_installation(config_path)
    show = next(a for a in apps.values() if a.project == project.resolve())
    # Every scope of the demo sees the same synthetic catalogue and telemetry (one machine, one OMP).
    for app in apps.values():
        if app is not show and not app.state.get('catalog'):
            app.state.update(catalog=show.state['catalog'], available=show.state['available'], refreshed=show.state['refreshed'], favs=show.state['favs'])
            app.persist()
            if show.insights.path.exists() and not app.insights.path.exists():
                app.insights.path.write_bytes(show.insights.path.read_bytes())
            codexbar = show.state_dir / 'commandcode-usage.json'
            if codexbar.exists() and not (app.state_dir / 'commandcode-usage.json').exists():
                (app.state_dir / 'commandcode-usage.json').write_bytes(codexbar.read_bytes())

    def confirmed(call, body):
        # The demo's Global file is seeded after the project: its first write also brings what DeepSeek OFF and
        # the FREE pools now reach there. The panel would show that and ask; the seeding accepts it.
        try:
            return call(body)
        except Problem as error:
            if error.code != 'derived':
                raise
            return call({**body, 'confirm': error.details['token']})

    def save(app, profile, changes):
        body = {'profile': profile, 'revision': app.revision(profile), 'changes': changes,
                'modeSettings': app.preset_settings(profile[7:]) if profile.startswith('preset:') else app.mode_settings(profile)}
        body['previewToken'] = app.preview_profile(body)['token']
        confirmed(app.save_profile, body)
    # An older showcase with its own saved edits may refuse a write (an outside edit to accept first): the demo then
    # simply lacks that part, and says so.
    def attempt(what, step):
        try:
            step()
        except Problem as error:
            print(f'DEMO: {what} skipped — {error}', file=sys.stderr)
    if not show.native_presets():
        # `studio` = /modelpreset save of what runs now (OMP calls it active); `night` differs in two roles + thinking.
        def presets():
            for name in ('studio', 'night'):
                confirmed(show.profile_action, {'action': 'clone', 'profile': 'standard', 'name': name})
            save(show, 'preset:night', [{'path': ['modelRoles', 'composer'], 'value': 'demo-cloud/research-lab:medium'},
                                        {'path': ['modelRoles', 'investigator'], 'value': 'mana-pool/free-good'},
                                        {'path': ['defaultThinkingLevel'], 'value': 'low'}])
        attempt('native котушки', presets)
    if fresh_notes:
        app = next(a for a in apps.values() if a.project == notes.resolve())
        # Saved once through Mana Tape (with a FREE pool block, so the pools reach two scopes) …
        attempt('second project save', lambda: save(app, 'standard', [{'path': ['retry', 'fallbackChains', 'task'], 'value': ['demo-free/aurora-03-free', 'mana-pool/free-fast']}]))
        # … then OMP rewrote the file (/model with modelRoleStorage: project): an outside edit to accept or restore.
        data = yaml_load((notes / '.omp/config.yml').read_text(encoding='utf-8'))
        data['modelRoles']['smol'] = 'demo-cloud/swift-draft'
        data['modelRoles']['vision'] = 'demo-studio/canvas-image'
        (notes / '.omp/config.yml').write_text(yaml_dump(data), encoding='utf-8')
    (root / 'LAYERS_READY').write_text('Global, two projects, a candidate, native presets, an outside edit.\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--port', type=int, default=19424)
    parser.add_argument('--showcase', action='store_true', help='Багата синтетична демонстрація у .dev/showcase')
    args = parser.parse_args()
    project, agent, state = seed_showcase() if args.showcase else seed()
    print(f'DEMO only: http://127.0.0.1:{args.port} — synthetic data; no real quotas or benchmarks', flush=True)
    if args.serve:
        target = ['--config', str(state.parent/'installation.yml')] if args.showcase else ['--project', str(project), '--agent', str(agent), '--state', str(state), '--omp', '/does-not-exist']
        raise SystemExit(subprocess.call([sys.executable, str(REPO/'server.py'), *target, '--port', str(args.port), '--no-refresh', '--demo']))
