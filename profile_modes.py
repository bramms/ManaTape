"""Pure profile projection. Mode choices never mutate the normal profile."""
import copy
import re
from datetime import datetime, timedelta, timezone
from omp_roles import BUILTIN_ROLES, accepts_model, fallback_chain

EFFORT = re.compile(r':(off|minimal|low|medium|high|xhigh|max|auto)$')
# One provider segment, then the model ID; no whitespace or control characters.
ROUTE = re.compile(r'[^\s\x00-\x1f/]+/[^\s\x00-\x1f]+')
POOL_NAMES = ('free-good', 'free-fast')
POOL_PREFIX = 'mana-pool/'


def route_text(value):
    return isinstance(value, str) and len(value) <= 300 and bool(ROUTE.fullmatch(value))


def thinking_efforts(model):
    """Known thinking efforts of a catalog model, or None when unknown.

    OMP lists them as a list; extensions may register {mode, efforts}. An absent
    or empty list is unknown, as in the browser: unknown means no check.
    """
    value = (model or {}).get('thinking')
    if isinstance(value, dict):
        value = value.get('efforts')
    if isinstance(value, list):
        efforts = [v for v in value if isinstance(v, str)]
        return efforts or None
    return None


def pool_name(value):
    return value[len(POOL_PREFIX):] if isinstance(value, str) and value.startswith(POOL_PREFIX) else None


def validate_pools(value, models):
    if not isinstance(value, dict) or set(value) != set(POOL_NAMES):
        raise ValueError('Потрібні два спільні пули: FREE GOOD і FREE FAST')
    for name, routes in value.items():
        if not isinstance(routes, list):
            raise ValueError('Пул має бути списком CUTS')
        seen = set()
        for route in routes:
            if not route_text(route):
                raise ValueError('Некоректний CUT у пулі')
            raw = raw_route(route)
            model = models.get(raw, {})
            if pool_name(route) is not None or not is_free_model(model):
                raise ValueError('До FREE пулів можна додавати лише підтверджені FREE CUTS')
            effort, efforts = EFFORT.search(route), thinking_efforts(model)
            if effort and effort[1] != 'off' and efforts is not None and effort[1] not in efforts:
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
            and bool(model.get('freeEvidence') or re.search(r'(^|[\s:/_()\[\]-])free($|[\s:/_()\[\]-])', (model.get('id') or '') + ' ' + (model.get('name') or ''), re.I)))


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
            if not route_text(r) or is_deepseek(r, models):
                raise ValueError('Заміна має бути без платного DeepSeek; FREE CUTS дозволені')
        if len(set(routes)) != len(routes):
            raise ValueError('У списку є однакові маршрути')
    return {'mode': value['mode'], 'alternatives': list(lists['profile']), 'overrides': copy.deepcopy(overrides)}


def default_settings():
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
        # OMP roles without thinking (judge, web, image...) never receive an effort suffix.
        plain_role = key.startswith('role:') and not BUILTIN_ROLES.get(key[5:], {}).get('thinking', True)
        result = []
        for token in routes:
            for value in members(token, key):
                raw = raw_route(value)
                if plain_role:
                    value = raw
                model, availability = models.get(raw), statuses.get(raw, {'status': 'unknown', 'reason': 'Немає даних'})
                reason = ''
                if raw.split('/')[0] in disabled:
                    reason = 'Провайдер вимкнений у профілі'
                elif availability['status'] == 'blocked':
                    reason = availability['reason']
                elif not model:
                    reason = 'Модель відсутня в каталозі'
                elif key.startswith('role:') and not accepts_model(key[5:], model):
                    reason = 'CUT не підтримує цю роль'
                elif key in {'role:'+role for role in vision_roles} and 'image' not in model.get('input', []):
                    reason = 'Для цієї ролі потрібен зір'
                effort, efforts = EFFORT.search(value), thinking_efforts(model)
                if not reason and effort and effort[1] != 'off' and efforts is not None and effort[1] not in efforts:
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
        # A hand-written empty agent list stays empty; skipped replacements are reported once.
        if off and values and not pairs and not replacements_added and group == 'vibe':
            pairs.extend(alternatives(key, values[0]))
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
        # Pool members do not consume additional slots on the logical track.
        if len(display) > (30 if group == 'vibe' else 31):
            issues.append({'key': key, 'message': 'Ланцюг перевищує '+str(30 if group == 'vibe' else 31)+' CUTS. Скороти доріжку.'})
        view = {'routes': display, 'refs': display_refs, 'paused': paused, 'original': resolve(values[0], normal) if values else '', 'substituted': off and head_deepseek, 'alias': values[0] if alias else ''}
        return unique, view

    for role, primary in roles.items():
        values = [primary, *fallback_chain(normal, role)]
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


def collapse_chain(written, tokens, pools, heads=None):
    """Inverse of the ON expansion for one chain (F5).

    `written` is a chain as a file holds it (pool blocks expanded); `tokens` are the pool blocks the former logical
    chain held. A block comes back wherever the chain still holds its exact expansion: the same members, order and
    thinking. `heads` maps an `@role` entry to the block that role starts with: the file keeps `@role` followed by
    the rest of that block, which folds back into the alias. Returns (chain, kept tokens).
    """
    heads = heads or {}
    remaining, out, kept, i = list(tokens), [], [], 0
    while i < len(written):
        value = written[i]
        hit = next((t for t in remaining if pools.get(pool_name(t)) and list(written[i:i + len(pools[pool_name(t)])]) == list(pools[pool_name(t)])), None)
        if hit is not None:
            out.append(hit); kept.append(hit); remaining.remove(hit); i += len(pools[pool_name(hit)])
            continue
        members = pools.get(pool_name(heads.get(value))) or [] if isinstance(value, str) else []
        if len(members) > 1 and list(written[i + 1:i + len(members)]) == list(members[1:]):
            out.append(value); i += len(members)
            continue
        out.append(value); i += 1
    return out, kept


def collapse_pools(written, logical, pools, inherited=None, keys=None):
    """The logical profile for a file taken as written (F5, «Прийняти файл»).

    FREE pool blocks of the former logical profile stay blocks wherever the file still holds their exact expansion;
    every other entry is the file's own. `written` and `logical` are one layer (Standard or a preset overlay);
    `inherited` is the logical Standard a preset inherits. `keys` limits the change to these chains ('role:x',
    'vibe:w', 'fallback:default'). Returns (profile, kept, lost): [{'key', 'pool'}] for every block of a chain the
    file still has, kept as a block or not.
    """
    out, inherited, pools = copy.deepcopy(written), inherited or {}, {k: list(v or []) for k, v in (pools or {}).items()}
    kept, lost = [], []
    def chains(p):
        return ((p or {}).get('retry') or {}).get('fallbackChains') or {}
    lr, lc, ir, ic = logical.get('modelRoles') or {}, chains(logical), inherited.get('modelRoles') or {}, chains(inherited)
    def primary(role):
        return lr.get(role, ir.get(role))
    def tail(role, own_default):
        if role in lc:
            return list(lc[role] or [])
        if role in ic:
            return list(ic[role] or [])
        return list(own_default) if BUILTIN_ROLES.get(role, {}).get('defaultFallbacks', True) else []
    heads = {'@' + role: primary(role) for role in set(lr) | set(ir) if pool_name(primary(role)) is not None}
    def note(key, tokens, got):
        rest = list(tokens)
        for token in got:
            rest.remove(token)
        kept.extend({'key': key, 'pool': pool_name(t)} for t in got)
        lost.extend({'key': key, 'pool': pool_name(t)} for t in rest)
    def wanted(key):
        return keys is None or key in keys
    def put(seq, values):
        seq[:] = values
    roles, own = out.get('modelRoles') if isinstance(out.get('modelRoles'), dict) else {}, chains(out)
    # Default first: a role that inherits it compares with the collapsed default.
    if 'default' in own and 'default' not in roles and isinstance(own['default'], list) and wanted('fallback:default'):
        tokens = [t for t in lc.get('default', ic.get('default', [])) or [] if pool_name(t) is not None]
        values, got = collapse_chain(own['default'], tokens, pools, heads)
        put(own['default'], values); note('fallback:default', tokens, got)
    default_now = list(own.get('default', ic.get('default', [])) or [])
    for role in sorted(set(roles) | (set(own) - {'default'})):
        key = 'role:' + role
        if not wanted(key):
            continue
        head, chain = roles.get(role), own.get(role)
        if head is not None and not isinstance(head, str) or chain is not None and not isinstance(chain, list):
            continue
        logical_tail = tail(role, lc.get('default', ic.get('default', [])) or [])
        inherits = role not in lc
        # What this layer's role would inherit without an own chain: Standard's chain (preset) or default.
        fallback_now = list(ic[role]) if role in ic and role != 'default' else default_now if BUILTIN_ROLES.get(role, {}).get('defaultFallbacks', True) and role != 'default' else []
        if head is not None:
            tokens = [t for t in [primary(role), *logical_tail] if pool_name(t) is not None]
            values, got = collapse_chain([head, *(chain or [])], tokens, pools, heads)
            roles[role] = values[0]
            if chain is not None:
                if inherits and values[1:] == fallback_now:
                    del own[role]
                else:
                    put(chain, values[1:])
            note(key, tokens, got)
            continue
        if chain is None:
            continue  # A role written without a model (`role:` with no value) has no chain to fold.
        # A preset chain without its own primary: the primary block comes from Standard and its rest leads the chain.
        tokens = [t for t in logical_tail if pool_name(t) is not None]
        members = pools.get(pool_name(primary(role))) or []
        rest = chain[len(members) - 1:] if len(members) > 1 and list(chain[:len(members) - 1]) == members[1:] else chain
        values, got = collapse_chain(rest, tokens, pools, heads)
        if inherits and values == fallback_now:
            del own[role]
        else:
            put(chain, values)
        note(key, tokens, got)
    agents = ((out.get('task') or {}).get('agentModelOverrides')) or {}
    own_agents, inherited_agents = (logical.get('task') or {}).get('agentModelOverrides') or {}, (inherited.get('task') or {}).get('agentModelOverrides') or {}
    for worker, value in list(agents.items()):
        if not isinstance(value, list) or not wanted('vibe:' + worker):
            continue
        former = own_agents.get(worker, inherited_agents.get(worker))
        tokens = [t for t in ([former] if isinstance(former, str) else former or []) if pool_name(t) is not None]
        values, got = collapse_chain(value, tokens, pools, heads)
        if worker not in own_agents and worker in inherited_agents and values == ([former] if isinstance(former, str) else list(former or [])):
            del agents[worker]  # A preset agent the writer only spelled out keeps following Standard.
        elif isinstance(former, str) and values == [former]:
            agents[worker] = former
        else:
            put(value, values)
        note('vibe:' + worker, tokens, got)
    # Containers the writer added only for spelled-out chains go when they are empty again and the layer had none.
    for path in (('retry', 'fallbackChains'), ('task', 'agentModelOverrides')):
        parent, child = out.get(path[0]), path[1]
        if isinstance(parent, dict) and parent.get(child) == {} and child not in (logical.get(path[0]) or {}):
            del parent[child]
            if not parent and path[0] not in logical:
                del out[path[0]]
    return out, kept, lost


def chain_entries(profile):
    """Every chain of one layer by its collapse key, for telling which chains an adoption changed."""
    roles = profile.get('modelRoles') or {}
    chains = (profile.get('retry') or {}).get('fallbackChains') or {}
    out = {('role:' if r in roles or r != 'default' else 'fallback:') + r: [roles.get(r), chains.get(r)] for r in set(roles) | set(chains)}
    out.update({'vibe:' + w: v for w, v in ((profile.get('task') or {}).get('agentModelOverrides') or {}).items()})
    return out


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
