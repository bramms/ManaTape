"""Built-in role capabilities from OMP 18.6.1; no model assignments.

https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/config/model-roles.ts
"""

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


def accepts_model(role, model):
    info = BUILTIN_ROLES.get(role)
    kind = model.get('kind') or 'chat'
    return (kind in (info['kinds'] if info else ['chat'])
            and (role != 'web' or kind != 'chat' or model.get('webSearch') is not None))


def fallback_chain(profile, role):
    chains = profile.get('retry', {}).get('fallbackChains', {})
    inherit = BUILTIN_ROLES.get(role, {}).get('defaultFallbacks', True)
    return chains.get(role, chains.get('default', []) if inherit else [])
