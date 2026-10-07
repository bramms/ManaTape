"""Built-in role capabilities from OMP 18.6.1; no model assignments.

https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/config/model-roles.ts
"""
import re
from pathlib import Path

from ruamel.yaml import YAML

BUILTIN_ROLES = {
    role: {'id': role, 'kinds': kinds, 'thinking': thinking, 'defaultFallbacks': thinking}
    for role, kinds, thinking in (
        ('default', ['chat'], True), ('smol', ['chat'], True),
        ('slow', ['chat'], True), ('vision', ['chat'], True),
        ('plan', ['chat'], True), ('commit', ['chat'], True),
        ('tiny', ['tiny', 'chat'], True), ('memory', ['tiny', 'chat'], True),
        ('task', ['chat'], True), ('advisor', ['chat'], True),
        ('image', ['image'], False), ('web', ['search', 'chat'], False),
        ('speech', ['tts'], False), ('dictation', ['stt'], False),
        ('judge', ['judge', 'tiny', 'chat'], False),
    )
}

# Bundled definitions from src/task/agents.ts and src/prompts/agents/*.md.
# These are display metadata, never task.agentModelOverrides assignments.
BUILTIN_AGENTS = {
    agent: {'id': agent, 'model': model, 'description': description}
    for agent, model, description in (
        ('scout', '@smol', 'Швидке дослідження коду · лише читання'),
        ('reviewer', '@slow', 'Перевірка змін і пошук помилок'),
        ('security-reviewer', None, 'Пошук вразливостей · лише читання'),
        ('task', '@task', 'Універсальний виконавець делегованих завдань'),
        ('sonic', '@smol', 'Механічні зміни та збір даних'),
    )
}

AGENT_ID = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
AGENT_FILE_LIMIT = 64 * 1024
AGENT_FILES_PER_DIR = 200
AGENT_SOURCES = (('project', 'проєкт'), ('user', 'користувач'))


def _frontmatter(path):
    with path.open('rb') as handle:
        text = handle.read(AGENT_FILE_LIMIT + 1)
    if len(text) > AGENT_FILE_LIMIT:
        raise ValueError('файл завеликий')
    lines = text.decode('utf-8').lstrip('\ufeff').splitlines()
    if not lines or lines[0].strip() != '---':
        raise ValueError('немає frontmatter')
    for end, line in enumerate(lines[1:], 1):
        if line.strip() == '---':
            data = YAML(typ='safe').load('\n'.join(lines[1:end]))
            if not isinstance(data, dict):
                raise ValueError('frontmatter не є об’єктом')
            return data
    raise ValueError('frontmatter не закрито')


def _agent_model(value):
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        models = [v.strip() for v in value if isinstance(v, str) and v.strip()]
        return models or None
    return None


def discover_agents(project_dir, agent_dir):
    """Read-only discovery of OMP custom agents; returns (agents, warnings).

    Project definitions shadow user ones. Only frontmatter is parsed and bad files are skipped.
    """
    agents, warnings = {}, []
    for source, directory in (('project', Path(project_dir) / '.omp' / 'agents'), ('user', Path(agent_dir) / 'agents')):
        try:
            root = directory.resolve()
            if not root.is_dir():
                continue
            files = sorted(p for p in root.iterdir() if p.suffix == '.md')[:AGENT_FILES_PER_DIR]
        except OSError:
            continue
        for path in files:
            try:
                if not path.is_file() or not path.resolve().is_relative_to(root):
                    continue
                data = _frontmatter(path)
                name, description = data.get('name'), data.get('description')
                if not isinstance(name, str) or not AGENT_ID.fullmatch(name):
                    raise ValueError('некоректне або відсутнє name')
                if not isinstance(description, str) or not description.strip():
                    raise ValueError('немає description')
            except Exception as error:
                warnings.append(f'{source}/{path.name}: {error}'[:200])
                continue
            if name in agents:
                if agents[name]['source'] == source:
                    warnings.append(f'{source}/{path.name}: повторне ім’я {name}')
                continue
            agents[name] = {'id': name, 'model': _agent_model(data.get('model')),
                            'description': ' '.join(description.split())[:300], 'source': source}
    return agents, warnings


def agent_catalog(project_dir, agent_dir):
    """Built-in agents merged with discovered ones: project > user > built-in."""
    custom, warnings = discover_agents(project_dir, agent_dir)
    agents = {name: {**info, 'source': 'builtin'} for name, info in BUILTIN_AGENTS.items()}
    for name, info in custom.items():
        agents[name] = {**info, 'overrides': name in BUILTIN_AGENTS}
    return agents, warnings


def accepts_model(role, model):
    info = BUILTIN_ROLES.get(role)
    kind = model.get('kind') or 'chat'
    return (kind in (info['kinds'] if info else ['chat'])
            and (role != 'web' or kind != 'chat' or model.get('webSearch') is not None))


def fallback_chain(profile, role):
    chains = profile.get('retry', {}).get('fallbackChains', {})
    inherit = BUILTIN_ROLES.get(role, {}).get('defaultFallbacks', True)
    return chains.get(role, chains.get('default', []) if inherit else [])
