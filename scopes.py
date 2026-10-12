"""OMP configuration layers, scope discovery and native model presets. Pure helpers, no writes.

Mirrors OMP 18.9 (packages/coding-agent/src/config/settings.ts, config/model-presets.ts,
discovery/builtin.ts, session/session-manager.ts); the evidence is in docs/CONFIGURATION.md.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading

# OMP isValidModelPresetName: /^[a-zA-Z][\w-]*$/ (JS \w is ASCII).
PRESET_NAME = re.compile(r'[a-zA-Z][\w-]{0,63}', re.ASCII)
PRESET_PREFIX = 'preset:'
# defaultThinkingLevel: ThinkingLevel values plus "auto" (settings-schema).
THINKING_LEVELS = ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto')
# Dotted setting groups: a project scalar in their place is ignored (dropSettingsGroupShadows).
GROUPS = ('retry', 'task')
SCOPE_ID = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
# Keys of one layer the panel tracks per value (override / reset / promote).
TRACKED = ('modelRoles', 'retry.fallbackChains', 'task.agentModelOverrides', 'disabledProviders')
# What Mana Tape compiles and writes in a config file. Everything else (theme, defaultThinkingLevel, modelRoleStorage,
# retry.maxRetries, ...) belongs to OMP and the owner: an outside edit there is no conflict, the next write keeps it.
MANAGED = ('modelRoles', 'disabledProviders', 'modelPresets')
MANAGED_GROUPS = {'retry': 'fallbackChains', 'task': 'agentModelOverrides'}


def omp_merge(base, over):
    """OMP Settings#merge: mappings merge key by key; lists, scalars and null replace."""
    if not isinstance(base, dict) or not isinstance(over, dict):
        return copy.deepcopy(over)
    out = {k: copy.deepcopy(v) for k, v in base.items()}
    for k, v in over.items():
        out[k] = omp_merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else copy.deepcopy(v)
    return out


def role_selector(value):
    """OMP getModelRoles: a string, or a list of strings joined by commas; anything else is not a role."""
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return ','.join(value)
    return None


def project_layer(data):
    """The project layer as OMP merges it: model roles that are not selectors (null) are dropped, not tombstones,
    and a scalar where OMP expects a settings group is ignored."""
    if not isinstance(data, dict):
        return {}
    out = {k: v for k, v in data.items() if not (k in GROUPS and not isinstance(v, dict))}
    roles = out.get('modelRoles')
    if isinstance(roles, dict) and any(role_selector(v) is None for v in roles.values()):
        out = {**out, 'modelRoles': {k: v for k, v in roles.items() if role_selector(v) is not None}}
    return out


def effective(global_data, project_data=None):
    """Global config, then the project overlay (<cwd>/.omp/config.yml). --config overlays are not modelled."""
    base = global_data if isinstance(global_data, dict) else {}
    return copy.deepcopy(base) if project_data is None else omp_merge(base, project_layer(project_data))


def lookup(data, dotted):
    node = data
    for part in dotted.split('.'):
        if not isinstance(node, dict) or part not in node:
            return None, False
        node = node[part]
    return node, True


def sources(global_data, project_data=None):
    """Where each tracked value comes from: {'modelRoles.task': 'project' | 'global'}. Missing means OMP default."""
    layers = (('project', project_layer(project_data)) if project_data is not None else None, ('global', global_data or {}))
    out = {}
    for name, layer in filter(None, layers):
        for key in TRACKED:
            value, found = lookup(layer, key)
            if not found:
                continue
            if key == 'disabledProviders':
                out.setdefault(key, name)
            elif isinstance(value, dict):
                for item in value:
                    out.setdefault(key + '.' + str(item), name)
    return out


def model_chain_keys(data):
    """Fallback chains keyed by a model selector (provider/model or provider/*). OMP picks them before role chains."""
    retry = (data or {}).get('retry')
    chains = retry.get('fallbackChains') if isinstance(retry, dict) else None
    return sorted(k for k in chains if isinstance(k, str) and '/' in k) if isinstance(chains, dict) else []


# ---- native model presets -------------------------------------------------------------------------------------


def parse_preset(entry):
    """OMP model-presets.ts parsePresetEntry: {modelRoles: {role: selector}, defaultThinkingLevel?} or an error string."""
    if not isinstance(entry, dict):
        return 'it is not a mapping'
    roles = entry.get('modelRoles')
    if not isinstance(roles, dict):
        return '`modelRoles` is missing or not a mapping'
    out = {}
    for role, value in roles.items():
        if not isinstance(value, str) or not value.strip():
            return f'role `{role}` is not a model selector'
        out[str(role)] = value
    level = entry.get('defaultThinkingLevel')
    if level is None:
        return {'modelRoles': out}
    if level not in THINKING_LEVELS:
        return '`defaultThinkingLevel` is not a thinking level'
    return {'modelRoles': out, 'defaultThinkingLevel': level}


def layer_presets(data):
    """Native presets one config file defines: {name: parsed | {'invalid': reason}}."""
    raw = (data or {}).get('modelPresets')
    if not isinstance(raw, dict):
        return {}
    out = {}
    for name, entry in raw.items():
        if not isinstance(name, str) or not PRESET_NAME.fullmatch(name) or entry is None:
            continue
        parsed = parse_preset(entry)
        out[name] = {'invalid': parsed} if isinstance(parsed, str) else parsed
    return out


def preset_order(name):
    """OMP lists presets with `a.localeCompare(b)` (ICU root collation). For preset names (ASCII letters, digits, `_`,
    `-`): case is ignored first, `_` < `-` < digits < letters, and on a tie a lowercase letter comes first."""
    def rank(ch):
        return (0, 0) if ch == '_' else (0, 1) if ch == '-' else (1, ch) if ch.isdigit() else (2, ch.lower())
    return [rank(ch) for ch in name], [not ch.islower() for ch in name]


def visible_presets(global_data, project_data=None):
    """Presets OMP offers in this scope. A project preset shadows a global one of the same name; null in the
    project layer is not a tombstone (getOwnedModelPreset)."""
    out = {name: {**p, 'source': 'global'} for name, p in layer_presets(global_data).items()}
    if project_data is not None:
        for name, p in layer_presets(project_data).items():
            out[name] = {**p, 'source': 'project', **({'shadows': True} if name in out else {})}
    return dict(sorted(out.items(), key=lambda kv: preset_order(kv[0])))


def active_preset(effective_data, presets):
    """OMP findActiveModelPreset: the first preset (by name) whose role map equals the effective one exactly."""
    roles = {r: s for r, s in ((r, role_selector(v)) for r, v in ((effective_data or {}).get('modelRoles') or {}).items()) if s}
    thinking = (effective_data or {}).get('defaultThinkingLevel', 'high')
    for name, preset in presets.items():
        if 'invalid' in preset:
            continue
        if preset.get('defaultThinkingLevel') not in (None, thinking):
            continue
        if preset['modelRoles'] == roles:
            return name
    return None


def managed_part(data):
    """The part of one config file Mana Tape compiles and writes (MANAGED), as {dotted key: value}."""
    data = data if isinstance(data, dict) else {}
    out = {k: data[k] for k in MANAGED if k in data}
    for group, key in MANAGED_GROUPS.items():
        node = data.get(group)
        if isinstance(node, dict):
            if key in node:
                out[group + '.' + key] = node[key]
        elif group in data:
            out[group] = node  # A scalar where OMP expects a group: never merged silently.
    return out


def with_unmanaged(logical, current):
    """The logical layer rebased on the current file: Mana Tape's own keys from `logical`, every other key as the
    file holds it now (an OMP or owner edit of theme, thinking level, ... survives the next write).

    Works on plain dicts and on round-trip YAML maps (the file's comments and order are kept); returns a new map.
    """
    out = copy.deepcopy(current) if isinstance(current, dict) else {}
    logical = logical if isinstance(logical, dict) else {}
    for key in MANAGED:
        if key in logical:
            _assign(out, key, logical[key])
        elif key in out:
            del out[key]
    for group, key in MANAGED_GROUPS.items():
        mine, theirs = logical.get(group), out.get(group)
        if isinstance(mine, dict) and key in mine:
            if not isinstance(theirs, dict):
                out[group] = theirs = type(out)()
            _assign(theirs, key, mine[key])
        elif isinstance(theirs, dict) and key in theirs:
            del theirs[key]
            if not theirs and group not in logical:
                del out[group]
    return out


def _assign(container, key, value):
    """container[key] = value, updating the node that is already there in place: a round-trip map keeps the comments
    of every key whose value stays the same."""
    old = container[key] if key in container else _ABSENT
    if isinstance(old, dict) and isinstance(value, dict):
        for k in [k for k in old if k not in value]:
            del old[k]
        for k, v in value.items():
            _assign(old, k, v)
    elif old is _ABSENT or old != value:
        container[key] = copy.deepcopy(value)


def onto(base, data):
    """`data` laid over a copy of `base` in place: every node of `base` whose value stays keeps its comments (a
    round-trip YAML map of the file as it is now)."""
    out = copy.deepcopy(base) if isinstance(base, dict) else {}
    for key in [k for k in out if k not in data]:
        del out[key]
    for key, value in data.items():
        _assign(out, key, value)
    return out


def preset_view(full, entry):
    """The profile a native preset edits: its role map over the scope's chains, agents and providers."""
    view = copy.deepcopy(full)
    view['modelRoles'] = copy.deepcopy((entry or {}).get('modelRoles') or {})
    return view


# ---- discovery --------------------------------------------------------------------------------------------------

_SESSION_HEADERS, _SESSION_LOCK = {}, threading.Lock()


def session_cwd(path, limit=65536):
    """The cwd recorded in an OMP session file header ({"type": "session", "cwd": ...}), or None.

    The first line is usually a padded title record; the header follows it. Never decodes directory names. Reading
    stops at the header (at most 8 lines, 64 KB); the cache follows the file's size and mtime, so a moved session
    that rewrote its header is read again.
    """
    try:
        st = path.stat()
        key = (str(path), st.st_ino, st.st_dev, st.st_size, st.st_mtime_ns)
        with _SESSION_LOCK:
            if key in _SESSION_HEADERS:
                return _SESSION_HEADERS[key]
        lines, size = [], 0
        with path.open('rb') as handle:
            while len(lines) < 8 and size < limit:
                line = handle.readline(limit - size)
                if not line:
                    break
                size += len(line)
                lines.append(line)
                if b'"session"' in line:
                    break
    except OSError:
        return None
    cwd = None
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and record.get('type') == 'session':
            value = record.get('cwd')
            cwd = value if isinstance(value, str) and os.path.isabs(value) and '\0' not in value else None
            break
    with _SESSION_LOCK:
        if len(_SESSION_HEADERS) > 20000:
            _SESSION_HEADERS.clear()
        _SESSION_HEADERS[key] = cwd
    return cwd


def session_cwds(sessions_dir, max_files=4000):
    """{cwd: {'lastSeen': mtime, 'sessions': count}} from the newest session files of an OMP agent directory."""
    files = []
    try:
        folders = [d for d in Path(sessions_dir).iterdir() if d.is_dir() and not d.is_symlink()]
    except OSError:
        return {}
    for folder in folders:
        try:
            for p in folder.iterdir():
                if p.suffix == '.jsonl' and not p.name.startswith('.') and not p.is_symlink() and p.is_file():
                    files.append((p.stat().st_mtime, p))
        except OSError:
            continue
    found = {}
    for mtime, p in sorted(files, key=lambda x: x[0], reverse=True)[:max_files]:
        cwd = session_cwd(p)
        if cwd is None:
            continue
        row = found.setdefault(cwd, {'lastSeen': mtime, 'sessions': 0})
        row['sessions'] += 1
        row['lastSeen'] = max(row['lastSeen'], mtime)
    return found


def project_config(path):
    """(config path, state): 'configured', 'missing' or 'symlink'. OMP reads exactly <cwd>/.omp/config.yml."""
    config = Path(path) / '.omp' / 'config.yml'
    if config.is_symlink() or (Path(path) / '.omp').is_symlink():
        return config, 'symlink'
    return config, 'configured' if config.is_file() else 'missing'


def discover(agent_dir, roots=(), home=None, exclude=()):
    """Project directories OMP has run in (session history) plus configured children of `roots`.

    Returns {resolved path: {'path', 'name', 'status', 'lastSeen', 'sessions', 'origin'}}. The home directory is
    skipped: OMP never reads a project layer there. Paths come from local files only, never from HTTP clients.
    """
    home = Path(home or Path.home()).resolve()
    skip = {Path(p).resolve() for p in exclude} | {home}
    # System places are never projects: the root, the home directory's ancestors and the temporary directories.
    system = {Path('/').resolve(), *home.parents}
    for temp in (tempfile.gettempdir(), '/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'):
        try:
            system.add(Path(temp).resolve())
        except (OSError, RuntimeError):
            pass
    out = {}

    def add(raw, origin, last=0, count=0):
        try:
            real = Path(raw).resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            return  # Gone, a link loop, or not a path at all (a NUL byte).
        if real in skip or real in system or not real.is_dir():
            return
        _, status = project_config(real)
        row = out.setdefault(real, {'path': str(real), 'name': real.name or str(real), 'status': status,
                                    'lastSeen': 0, 'sessions': 0, 'origin': origin})
        row['lastSeen'] = max(row['lastSeen'], last)
        row['sessions'] += count

    for cwd, row in session_cwds(Path(agent_dir) / 'sessions').items():
        add(cwd, 'sessions', row['lastSeen'], row['sessions'])
    for root in roots:
        try:
            children = sorted(Path(root).iterdir())
        except OSError:
            continue
        for child in children[:500]:
            if child.is_dir() and not child.is_symlink() and project_config(child)[1] == 'configured':
                add(child, 'roots')
    return out


def scope_id(path, taken=()):
    """A stable, readable scope id for a project directory: <slug>-<6 hex of the path>."""
    path = str(path)
    slug = re.sub(r'[^a-z0-9]+', '-', Path(path).name.lower()).strip('-')[:40] or 'project'
    if not slug[0].isalnum():
        slug = 'p' + slug
    hashed = hashlib.sha256(path.encode()).hexdigest()
    for size in (6, 10, 16):
        candidate = f'{slug}-{hashed[:size]}'
        if candidate not in taken:
            return candidate
    return 'p-' + hashed[:32]


def legacy_project(path):
    """The project directory a legacy state.json backups key points at, or None."""
    p = Path(path)
    if p.name.endswith('.yml') and p.parent.name == '.omp':
        return p.parent.parent
    if p.name.endswith('.yml') and p.parent.name == 'presets' and p.parent.parent.name == '.omp':
        return p.parent.parent.parent
    return None


# ---- short human diff -------------------------------------------------------------------------------------------


def _flat(data, prefix=''):
    out = {}
    if isinstance(data, dict) and not data and not prefix:
        return out
    if isinstance(data, dict) and data:
        for k, v in data.items():
            out.update(_flat(v, f'{prefix}.{k}' if prefix else str(k)))
    else:
        out[prefix or '(файл)'] = data
    return out


def _show(value, limit=48):
    text = json.dumps(value, ensure_ascii=False, separators=(', ', ': ')) if not isinstance(value, str) else value
    return text if len(text) <= limit else text[:limit - 1] + '…'


def _pair(a, b, limit=34):
    """Two values side by side; long strings drop their common start so the part that differs stays visible."""
    if isinstance(a, str) and isinstance(b, str) and max(len(a), len(b)) > limit:
        cut = len(os.path.commonprefix([a, b]))
        cut = max(a.rfind('/', 0, cut + 1), a.rfind('-', 0, cut + 1), 0)
        if cut > 0:
            a, b = '…' + a[cut:], '…' + b[cut:]
    return f'{_show(a, limit)} → {_show(b, limit)}'


def _list_change(old, new):
    if len(old) == len(new):
        changed = [i for i, (a, b) in enumerate(zip(old, new)) if a != b]
        if len(changed) == 1:
            i = changed[0]
            return f'[{i + 1}] {_pair(old[i], new[i])}'
    added = [v for v in new if v not in old]
    removed = [v for v in old if v not in new]
    if not added and not removed:
        return f'порядок змінено ({len(new)})'
    parts = []
    if added:
        parts.append('+' + ', '.join(_show(v, 30) for v in added[:2]) + (f' +{len(added) - 2}' if len(added) > 2 else ''))
    if removed:
        parts.append('−' + ', '.join(_show(v, 30) for v in removed[:2]) + (f' +{len(removed) - 2}' if len(removed) > 2 else ''))
    return ' '.join(parts)


def changed_keys(old, new):
    """Dotted keys whose value differs between two documents (lists compare whole), with their new values."""
    a, b = _flat(old or {}), _flat(new or {})
    return {key: b.get(key, _ABSENT) for key in set(a) | set(b) if a.get(key, _ABSENT) != b.get(key, _ABSENT)}


_ABSENT = object()


def short_diff(old, new, limit=6, keys=None):
    """At most `limit` human lines: `+ key: value`, `− key`, `~ key: old → new` (lists: the CUT that changed).
    `keys` limits the lines to these dotted keys."""
    a, b = _flat(old or {}), _flat(new or {})
    lines = []
    for key in sorted(set(a) | set(b)):
        if keys is not None and key not in keys:
            continue
        if key in a and key in b:
            if a[key] == b[key]:
                continue
            if isinstance(a[key], list) and isinstance(b[key], list):
                lines.append(f'~ {key}: {_list_change(a[key], b[key])}')
            else:
                lines.append(f'~ {key}: {_pair(a[key], b[key], 48)}')
        elif key in b:
            lines.append(f'+ {key}: {_show(b[key])}')
        else:
            lines.append(f'− {key}')
    # Changed values first, then removed, then added keys: the ones a reviewer must not miss.
    lines.sort(key=lambda line: '~−+'.index(line[0]))
    if len(lines) > limit:
        lines = lines[:limit - 1] + [f'… ще {len(lines) - limit + 1} змін']
    return lines
