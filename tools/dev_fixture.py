#!/usr/bin/env python3
"""Create a credential-free, offline fixture; never read native OMP state."""
import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from server import yaml_dump


def seed():
    root = REPO / '.dev'
    marker = root / 'MANA_TAPE_DEMO'
    if root.exists() and any(root.iterdir()) and not marker.exists():
        raise SystemExit('Refusing to write a non-demo .dev directory.')
    root.mkdir(exist_ok=True)
    marker.touch()
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
                 'demo-free': dict(api='openai-completions', baseUrl='https://example.invalid/v1', auth='none', models=[dict(id='cut-c', name='Demo CUT C', input=['text'], reasoning=False, cost=dict(input=0,output=0))])}
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--port', type=int, default=19424)
    args = parser.parse_args()
    project, agent, state = seed()
    print(f'DEMO only: http://127.0.0.1:{args.port} — no real quotas or benchmarks', flush=True)
    if args.serve:
        raise SystemExit(subprocess.call([sys.executable, str(REPO/'server.py'), '--project', str(project), '--agent', str(agent), '--state', str(state), '--omp', '/does-not-exist', '--port', str(args.port), '--no-refresh', '--demo']))
