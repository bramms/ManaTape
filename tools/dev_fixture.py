#!/usr/bin/env python3
"""Create a credential-free, offline fixture; never read native OMP state."""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from server import Forge, yaml_dump


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
            path.write_text(content)
    snapshot = state / 'state.json'
    if not snapshot.exists():
        catalog = {pid+'/'+m['id']: {**m, 'provider':pid} for pid,cfg in providers.items() for m in cfg['models']}
        snapshot.write_text(json.dumps(dict(managed={},catalog=catalog,available=list(catalog),changes=[],favs=[],refreshed=0,error='',backups={},attempted=0)))
    return project, agent, state


def seed_showcase():
    """Rich synthetic demo. Reopening preserves saved edits; no native data is read."""
    demo_root(REPO / '.dev')
    root = REPO / '.dev/showcase'
    demo_root(root)
    project, agent, state = (root / name for name in ('project', 'agent', 'state'))
    if (root / 'SHOWCASE_READY').exists():
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
    (project / '.omp/config.yml').write_text('# DEMO: усі моделі та дані синтетичні.\n'+yaml_dump(base))
    (project / '.omp/presets/without-deepseek.yml').write_text('{}\n')
    (project / '.omp/presets/long-tape.yml').write_text(yaml_dump({
        'retry': {'fallbackChains': {'investigator': alternatives+pools['free-good']+pools['free-fast'][:15]}}}))
    (agent / 'models.yml').write_text(yaml_dump({'providers': providers}))
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
    app.insights.path.write_text(json.dumps(app.insights.data, ensure_ascii=False))
    config = {'demo': True, 'noRefresh': True, 'omp': '/does-not-exist', 'state': str(root/'runtime'),
              'agent': str(agent), 'projects': [{'id': 'showcase', 'name': 'DEMO · Творча майстерня',
              'path': str(project), 'state': str(state), 'ui': {'visionRoles': ['storyboarder'], 'localProviders': ['demo-local'],
              'roleLabels': dict(composer='Автор', curator='Куратор', investigator='Дослідник', proofreader='Коректор', storyboarder='Розкадрування', **{'quick-notes': 'Швидкі нотатки'}),
              'providerCodes': {'demo-studio': 'STU', 'demo-cloud': 'CLD', 'demo-free': 'FREE', 'demo-deepseek': 'DS', 'demo-local': 'GPU'},
              'providerLabels': {'demo-studio': 'DEMO Studio', 'demo-cloud': 'DEMO Cloud', 'demo-free': 'DEMO Free', 'demo-deepseek': 'DEMO DeepSeek', 'demo-local': 'DEMO Local'}}}]}
    (root/'installation.yml').write_text(yaml_dump(config))
    (root/'SHOWCASE_READY').write_text('Synthetic showcase. No native accounts or inference.\n')
    return project, agent, state


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
