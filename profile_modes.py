"""Pure profile projection. Mode choices never mutate the normal profile."""
import copy
import re
from datetime import datetime, timedelta, timezone

EFFORT = re.compile(r':(off|minimal|low|medium|high|xhigh|max|auto)$')
POOL_NAMES = ('free-good', 'free-fast')
POOL_PREFIX = 'mana-pool/'


def pool_name(value):
    return value[len(POOL_PREFIX):] if isinstance(value, str) and value.startswith(POOL_PREFIX) else None


def validate_pools(value, models):
    if not isinstance(value, dict) or set(value) != set(POOL_NAMES):
        raise ValueError('Потрібні два спільні пули: FREE GOOD і FREE FAST')
    for name, routes in value.items():
        if not isinstance(routes, list) or len(routes) > 30:
            raise ValueError('У пулі може бути до 30 CUTS')
        seen = set()
        for route in routes:
            if not isinstance(route, str) or len(route) > 300 or not re.fullmatch(r'[^\s\x00-\x1f/]+/[^\s\x00-\x1f]+', route):
                raise ValueError('Некоректний CUT у пулі')
            raw = raw_route(route)
            model = models.get(raw, {})
            if pool_name(route) is not None or not is_free_model(model):
                raise ValueError('До FREE пулів можна додавати лише підтверджені FREE CUTS')
            effort = EFFORT.search(route)
            if effort and effort[1] not in model.get('thinking', []) and not (effort[1] == 'off' and model.get('reasoning') is False):
                raise ValueError('CUT не підтримує вибраний thinking')
            if raw in seen:
                raise ValueError('У пулі є однакові CUTS')
            seen.add(raw)
    return copy.deepcopy(value)


def raw_route(value):
    return EFFORT.sub('', value)


def is_free_model(model):
    cost = model.get('cost') or {}
    return (all(isinstance(cost.get(k), (int, float)) and not isinstance(cost[k], bool) and cost[k] == 0 for k in ('input', 'output'))
            and not cost.get('cacheRead') and not cost.get('cacheWrite')
            and bool(re.search(r'(^|[\s:/_()\[\]-])free($|[\s:/_()\[\]-])', (model.get('id') or '') + ' ' + (model.get('name') or ''), re.I)))


def is_deepseek(value, models):
    model = raw_route(value).partition('/')[2].split('/')[-1].lower()
    return bool(re.match(r'deepseek(?:[-_.:]|$)', model)) and not is_free_model(models.get(raw_route(value), {}))


def validate_settings(value, roles, models, workers=()):
    if not isinstance(value, dict) or value.get('mode') not in ('deepseek', 'no-deepseek'):
        raise ValueError('Невідомий режим профілю')
    lists = {'profile': value.get('alternatives', [])}
    overrides = value.get('overrides', {})
    if not isinstance(overrides, dict) or any(k not in {'role:'+r for r in roles} | {'vibe:'+w for w in workers} for k in overrides):
        raise ValueError('Некоректні винятки замін')
    lists.update(overrides)
    for key, routes in lists.items():
        if not isinstance(routes, list) or len(routes) > 12:
            raise ValueError('У списку замін може бути до 12 маршрутів')
        for r in routes:
            if not isinstance(r, str) or len(r) > 300 or not re.fullmatch(r'[^\s\x00-\x1f/]+/[^\s\x00-\x1f]+', r) or is_deepseek(r, models):
                raise ValueError('Заміна має бути без платного DeepSeek; FREE CUTS дозволені')
        if len(set(routes)) != len(routes):
            raise ValueError('У списку є однакові маршрути')
    return {'mode': value['mode'], 'alternatives': list(lists['profile']), 'overrides': copy.deepcopy(overrides)}


def default_settings(models, available, disabled=()):
    # The user chooses replacements; subscriptions do not imply role suitability.
    return {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}


def route_statuses(models, managed):
    """Mode switches check route availability, never subscription balances."""
    out = {}
    for raw, model in models.items():
        reason = ('Зникла з каталогу' if model.get('status') == 'missing' else
                  'Термін провайдера минув' if managed.get(raw.split('/')[0], {}).get('expired') else '')
        out[raw] = {'status': 'blocked' if reason else 'unknown', 'reason': reason or 'Ліміти не впливають на заміни'}
    return out


def compile_profile(normal, settings, models, statuses, pools=None, vision_roles=('vision',)):
    off = settings['mode'] == 'no-deepseek'
    effective = copy.deepcopy(normal)
    roles = normal.get('modelRoles', {})
    views, issues, skipped = {'role': {}, 'vibe': {}}, [], []
    disabled = set(normal.get('disabledProviders', []))
    pools = pools or {}
    native_views = {}

    def members(value, key):
        name = pool_name(value)
        if name is None:
            return [value]
        routes = pools.get(name, [])
        reason = ''
        if not routes:
            reason = 'Пул '+name.upper().replace('-', ' ')+' порожній або невідомий'
        elif any(raw_route(r).split('/')[0] in disabled for r in routes):
            reason = 'Пул містить вимкненого провайдера'
        elif key in {'role:'+role for role in vision_roles} and any('image' not in models.get(raw_route(r), {}).get('input', []) for r in routes):
            reason = 'Усі CUTS пулу на доріжці зору мають підтримувати зображення'
        if reason:
            issues.append({'key': key, 'message': reason})
        return routes

    def resolve(value, source):
        return source.get('modelRoles', {}).get(value[1:], value) if value.startswith('@') else value

    def alternatives(key, original):
        routes = settings['overrides'].get(key, settings['alternatives'])
        result = []
        for token in routes:
            for value in members(token, key):
                raw = raw_route(value)
                model, availability = models.get(raw), statuses.get(raw, {'status': 'unknown', 'reason': 'Немає даних'})
                reason = ''
                if raw.split('/')[0] in disabled:
                    reason = 'Провайдер вимкнений у профілі'
                elif availability['status'] == 'blocked':
                    reason = availability['reason']
                elif not model:
                    reason = 'Модель відсутня в каталозі'
                elif key in {'role:'+role for role in vision_roles} and 'image' not in model.get('input', []):
                    reason = 'Для цієї ролі потрібен зір'
                effort = EFFORT.search(value)
                if not reason and effort and model and model.get('thinking') and effort[1] not in model['thinking']:
                    reason = 'Модель не підтримує вибраний thinking'
                if reason:
                    skipped.append({'key': key, 'route': value, 'reason': reason})
                else:
                    result.append((value, {'kind': 'replacement', 'route': token, 'original': original, 'key': key, **({'pool': token} if pool_name(token) is not None else {})}))
        return result

    def project(values, key, group):
        pairs, paused = [], []
        head_deepseek = bool(values and is_deepseek(resolve(values[0], normal), models))
        # An alias follows the already projected role; do not independently replace it.
        alias = bool(values and values[0].startswith('@'))
        replacements_added = off and head_deepseek
        if off and head_deepseek and not alias:
            pairs.extend(alternatives(key, values[0]))
        if off and head_deepseek and alias:
            source_role = values[0][1:]
            source_pairs = native_views.get('role:'+source_role, [])
            head_pool = source_pairs[0][1].get('pool') if source_pairs else None
            head_ref = {'kind': 'base', 'index': 0, 'route': resolve(values[0], normal), 'key': key}
            if head_pool:
                head_ref['pool'] = head_pool
            pairs.append((values[0], head_ref))
            for route, ref in source_pairs[1:]:
                if head_pool and ref.get('pool') == head_pool:
                    pairs.append((route, copy.deepcopy(head_ref)))
                elif ref['kind'] == 'replacement':
                    pairs.append((route, copy.deepcopy(ref)))
        for index, value in enumerate(values):
            symbolic = resolve(value, normal)
            for member_index, member in enumerate(members(symbolic, key)):
                expanded = pool_name(symbolic) is not None
                native = value if not expanded or value.startswith('@') and member_index == 0 else member
                if expanded:
                    pairs.append((native, {'kind': 'base', 'index': index, 'route': symbolic, 'key': key, 'pool': symbolic}))
                    continue
                actual = resolve(value, effective if group == 'vibe' else normal)
                if off and is_deepseek(actual, models):
                    # Fill the first paused position even when DeepSeek is a fallback.
                    # One ordered replacement chain per track, not one copy per CUT.
                    if not replacements_added:
                        replacement_key = 'role:'+values[0][1:] if alias else key
                        pairs.extend(alternatives(replacement_key, resolve(value, normal)))
                        replacements_added = True
                    paused.append({'index': index, 'route': resolve(value, normal), 'primary': index == 0})
                    continue
                pairs.append((value, {'kind': 'base', 'index': index, 'route': resolve(value, normal), 'key': key}))
        if off and not pairs and group == 'vibe':
            pairs.extend(alternatives(key, values[0] if values else 'DeepSeek'))
        unique, refs, seen = [], [], set()
        for value, ref in pairs:
            identity = resolve(value, effective if group == 'vibe' else normal)
            if off and raw_route(identity) in seen:
                continue
            # A retained fallback that becomes primary must also be usable.
            if off and head_deepseek and not unique and ref['kind'] == 'base':
                raw = raw_route(identity)
                model = models.get(raw, {})
                availability = statuses.get(raw, {})
                reason = ('Провайдер вимкнений у профілі' if raw.split('/')[0] in disabled else
                    availability.get('reason', 'Модель недоступна') if availability.get('status') == 'blocked' else
                    'Для цієї ролі потрібен зір' if key in {'role:'+role for role in vision_roles} and 'image' not in model.get('input', []) else '')
                if reason:
                    skipped.append({'key': key, 'route': identity, 'reason': reason})
                    continue
            seen.add(raw_route(identity)); unique.append(value); refs.append(ref)
        if not unique:
            issues.append({'key': key, 'message': 'Немає доступної основної моделі. Додай альтернативу.'})
        if len(unique) > (30 if group == 'vibe' else 31):
            issues.append({'key': key, 'message': 'Ланцюг перевищує '+str(30 if group == 'vibe' else 31)+' CUTS. Скороти доріжку або спільний пул.'})
        native_views[key] = list(zip(unique, refs))
        display, display_refs, displayed_pools = [], [], set()
        for value, ref in zip(unique, refs):
            if ref.get('pool'):
                marker = (ref['pool'], ref['kind'], ref.get('index'))
                if marker in displayed_pools:
                    continue
                displayed_pools.add(marker)
            display.append(ref.get('pool') or resolve(value, effective if group == 'vibe' else normal))
            display_refs.append(ref)
        view = {'routes': display, 'refs': display_refs, 'paused': paused, 'original': resolve(values[0], normal) if values else '', 'substituted': off and head_deepseek, 'alias': values[0] if alias else ''}
        return unique, view

    for role, primary in roles.items():
        values = [primary, *normal.get('retry', {}).get('fallbackChains', {}).get(role, normal.get('retry', {}).get('fallbackChains', {}).get('default', []))]
        result, view = project(values, 'role:'+role, 'role')
        views['role'][role] = view
        if (off or any(pool_name(resolve(v, normal)) is not None for v in values)) and result:
            effective['modelRoles'][role] = result[0]
            effective.setdefault('retry', {}).setdefault('fallbackChains', {})[role] = result[1:]
    for worker, original in normal.get('task', {}).get('agentModelOverrides', {}).items():
        values = [original] if isinstance(original, str) else list(original)
        if len(values) == 1 and values[0].startswith('@'):
            # OMP inherits the role's retry chain only for a singleton alias.
            # Expanding its primary pool here would replace that inherited tail.
            alias, key = values[0], 'vibe:'+worker
            primary = resolve(alias, effective)
            views['vibe'][worker] = {
                'routes': [primary],
                'refs': [{'kind': 'base', 'index': 0, 'route': resolve(alias, normal), 'key': key}],
                'paused': [], 'original': resolve(alias, normal), 'substituted': False,
                'alias': alias, 'linkedRole': alias[1:], 'unresolved': alias[1:] not in roles,
            }
            continue
        result, view = project(values, 'vibe:'+worker, 'vibe')
        views['vibe'][worker] = view
        if off or any(pool_name(resolve(v, normal)) is not None for v in values):
            effective['task']['agentModelOverrides'][worker] = result
    # Default fallbacks can be inherited by any role and must never contain a token.
    defaults = normal.get('retry', {}).get('fallbackChains', {}).get('default', [])
    if 'default' not in roles and any(pool_name(v) is not None for v in defaults):
        effective['retry']['fallbackChains']['default'] = project(defaults, 'fallback:default', 'role')[0]
    return {'effective': effective, 'views': views, 'issues': issues, 'skipped': skipped}


def tariff_status(now=None):
    now = now or datetime.now(timezone.utc)
    def peak(at):
        return at.weekday() < 5 and (1 <= at.hour < 4 or 6 <= at.hour < 10)
    current = peak(now)
    candidate = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    while peak(candidate) == current:
        candidate += timedelta(hours=1)
    return {'peak': current, 'next': int(candidate.timestamp()), 'at': int(now.timestamp()),
        'note': 'Базовий розклад UTC. Винятки свят у провайдера можуть відрізнятися.',
        'sources': ['https://api-docs.deepseek.com/quick_start/pricing/', 'https://commandcode.ai/docs/resources/pricing-limits', 'https://opencode.ai/docs/go/']}
