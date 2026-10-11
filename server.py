#!/usr/bin/env python3
"""Private OMP profile editor. Run behind Tailscale Serve, bound to loopback."""
import argparse
import base64
from collections import OrderedDict
from collections.abc import Set as AbstractSet
import copy
from datetime import date
import errno
import gzip
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from profile_modes import (EFFORT, POOL_NAMES, compile_profile, default_settings, is_free_model, pool_name, raw_route,
    route_statuses, route_text, tariff_status, thinking_efforts, validate_pools, validate_settings)
from omp_roles import BUILTIN_ROLES, agent_catalog, accepts_model, fallback_chain
from insights import Insights
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
from urllib.request import Request, urlopen

from ruamel.yaml import YAML
from ruamel.yaml.comments import TaggedScalar

ID = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
STATIC = (Path(__file__).resolve().parent / 'static').resolve()
COMPRESSIBLE = ('text/', 'application/json', 'application/javascript', 'application/manifest+json', 'image/svg+xml')
RECOVERY = 'Незавершене збереження режимів. Запис зупинено, доки журнал не буде відновлено'
OUTSIDE = object()  # A journal file state that is neither before nor after.
MODEL_FIELDS = ('id', 'name', 'kind', 'webSearch', 'reasoning', 'thinking', 'input', 'contextWindow', 'maxTokens', 'cost')
# Exact hosted route, verified against the provider's model page on 2026-09-26.
VERIFIED_FREE_ROUTES = {
    'nvidia/deepseek-ai/deepseek-v4.1-flash': (
        'https://integrate.api.nvidia.com/v1',
        'https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash'),
}
# Gateways whose OMP catalog keeps a built-in list and never drops withdrawn FREE routes.
# Their public, keyless model lists prove which FREE routes are still offered.
PUBLIC_MODEL_LISTS = {
    # output_modalities=all also lists embedding, rerank and other non-chat models.
    'openrouter': 'https://openrouter.ai/api/v1/models?output_modalities=all',
    'kilo': 'https://api.kilo.ai/api/gateway/models',
}


def public_listing(url):
    req = Request(url, headers={'User-Agent': 'ManaTape/1.0 (catalog check)'})
    with urlopen(req, timeout=10) as response:
        return json.loads(response.read(16_000_000))


def withdrawn_free_routes(provider, native, listing):
    """FREE routes OMP still lists for `provider` that its public list no longer offers.

    None when the listing cannot prove absence: malformed, missing most known
    routes, or without a single known FREE route.
    """
    try:
        listed = {m['id'] for m in listing['data']}
    except (TypeError, KeyError):
        return None
    if not all(isinstance(i, str) and i for i in listed):
        return None
    own = [m for m in native if m.get('provider') == provider and isinstance(m.get('id'), str)]
    known = {m['id'] for m in own}
    free = {m['id'] for m in own if is_free_model(m) or m['id'].endswith(':free')}
    if not free & listed or 2 * len(known & listed) < len(known):
        return None
    return {provider + '/' + mid for mid in free - listed}



class Problem(Exception):
    def __init__(self, message, status=400, code='', **details):
        self.status, self.code, self.details = status, code, details
        super().__init__(message)

    def body(self):
        return {'error': str(self), **({'code': self.code} if self.code else {}), **self.details}


def log_failure(context, error=None):
    """Type, errno and code location only: no messages, paths, bodies, keys or model output."""
    error = error or sys.exc_info()[1]
    if error is None:
        return
    frames = traceback.extract_tb(error.__traceback__)
    own = [f for f in frames if Path(f.filename).parent == Path(__file__).parent] or frames
    where = ' < '.join(f'{Path(f.filename).name}:{f.lineno}:{f.name}' for f in reversed(own[-3:])) or '?'
    code = errno.errorcode.get(error.errno, '') if isinstance(error, OSError) and error.errno else ''
    cause = f' from {type(error.__cause__).__name__}' if error.__cause__ else ''
    print(f'Mana Tape: {context}: {type(error).__name__}{" " + code if code else ""}{cause} at {where}', file=sys.stderr, flush=True)


def profile_name(value):
    name = re.sub(r'\s+', '-', value.strip().lower()) if isinstance(value, str) else ''
    if not ID.fullmatch(name):
        raise Problem('Вкажи назву латиницею: літери, цифри, пробіли, дефіс або підкреслення; до 64 символів. Почни з літери чи цифри.')
    return name


def yaml_load(data):
    """Fresh round-trip YAML: comments and formatting survive a later dump. Use for writes."""
    y = YAML(typ='rt')
    y.preserve_quotes = True
    return y.load(data) or {}


def yaml_dump(data):
    y = YAML(typ='rt')
    y.preserve_quotes = True
    y.width = 150
    y.indent(mapping=2, sequence=4, offset=2)
    out = io.StringIO()
    y.dump(data, out)
    return out.getvalue()


def plain(x):
    """JSON-shaped data with stable comparisons; YAML tags and sets become explicit values."""
    if isinstance(x, dict):
        return {str(k): plain(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [plain(v) for v in x]
    if isinstance(x, TaggedScalar):
        return {'!tag': str(x.tag), 'value': plain(x.value)}
    if isinstance(x, AbstractSet):
        return {'!set': sorted(json.dumps(plain(v), sort_keys=True, default=json_value) for v in x)}
    return x


def json_value(value):
    """Deterministic JSON for YAML scalars json cannot encode itself (dates, binary)."""
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bytes):
        return {'!binary': base64.b64encode(value).decode()}
    raise TypeError(type(value).__name__)


class SharedDict(dict):
    """Cached YAML shared by readers. Mutation fails loudly; a deep copy is an ordinary dict."""
    def _read_only(self, *args, **kwargs):
        raise TypeError('Shared YAML data is read-only; copy it first')
    __setitem__ = __delitem__ = __ior__ = setdefault = pop = popitem = update = clear = _read_only

    def __copy__(self):
        return dict(self)

    def __deepcopy__(self, memo):
        return {k: copy.deepcopy(v, memo) for k, v in self.items()}


class SharedList(list):
    def _read_only(self, *args, **kwargs):
        raise TypeError('Shared YAML data is read-only; copy it first')
    __setitem__ = __delitem__ = __iadd__ = __imul__ = append = extend = insert = pop = remove = clear = sort = reverse = _read_only

    def __copy__(self):
        return list(self)

    def __deepcopy__(self, memo):
        return [copy.deepcopy(v, memo) for v in self]


def freeze(x):
    if isinstance(x, dict):
        return SharedDict((k, freeze(v)) for k, v in x.items())
    if isinstance(x, list):
        return SharedList(freeze(v) for v in x)
    return x


_SHARED_YAML, _SHARED_LOCK, SHARED_YAML_SIZE = OrderedDict(), threading.Lock(), 256


def yaml_shared(text):
    """Parsed plain YAML for read-only callers, cached by exact content.

    Keyed by the bytes themselves, so an outside edit can never be served from
    a stale entry, whatever the file timestamps say.
    """
    raw = text if isinstance(text, bytes) else text.encode('utf-8')
    key = hashlib.sha256(raw).digest()
    with _SHARED_LOCK:
        hit = _SHARED_YAML.get(key)
        if hit is not None:
            _SHARED_YAML.move_to_end(key)
            return hit
    value = freeze(plain(yaml_load(raw.decode('utf-8'))))
    with _SHARED_LOCK:
        _SHARED_YAML[key] = value
        while len(_SHARED_YAML) > SHARED_YAML_SIZE:
            _SHARED_YAML.popitem(last=False)
    return value


def merge(a, b):
    out = copy.deepcopy(a)
    for k, v in b.items():
        out[k] = merge(out.get(k, {}), v) if isinstance(v, dict) else copy.deepcopy(v)
    return out


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fingerprint(data):
    return digest(json.dumps(plain(data), sort_keys=True, separators=(',', ':'), default=json_value).encode())


def fsync_dir(path):
    directory = os.open(path, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def atomic(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.forge-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
        fsync_dir(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def create_new(path, data, mode=0o600):
    """Atomically create `path`; FileExistsError instead of replacing a file that appeared meanwhile."""
    fd, name = tempfile.mkstemp(prefix='.forge-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(name, path)
        except FileExistsError:
            raise
        except OSError:
            # A filesystem without hard links: exclusive create, then the same bytes.
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode), 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
        fsync_dir(path.parent)
    finally:
        os.unlink(name)


def read_or_none(path):
    return path.read_bytes() if path.exists() else None


def stat_key(path):
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_mtime_ns, st.st_ctime_ns, st.st_size, st.st_ino


def valid_route(value):
    if not route_text(value):
        raise Problem('Некоректний ідентифікатор моделі')


def catalog_entry(raw, provider, source):
    model = {k: raw[k] for k in MODEL_FIELDS if k in raw}
    if isinstance(model.get('thinking'), dict):
        # Extensions may register {mode, efforts}; the panel and the compiler read a list.
        model['thinking'] = thinking_efforts(model) or []
    model.update(provider=provider, source=source)
    return model


def peer_uid(client_port, server_port, table='/proc/net/tcp'):
    """Owner UID of a loopback TCP client socket (Linux /proc), or None when unknowable."""
    try:
        with open(table, encoding='ascii') as handle:
            rows = handle.read().splitlines()[1:]
    except OSError:
        return None
    local, remote = f'0100007F:{client_port:04X}', f'0100007F:{server_port:04X}'
    for row in rows:
        fields = row.split()
        if len(fields) > 7 and fields[1] == local and fields[2] == remote:
            return int(fields[7])
    return -1  # The table exists but does not show this peer: never trust it.


class Forge:
    def __init__(self, project, agent, state, omp, origin='', owner='', demo=False):
        self.project, self.agent, self.state_dir = Path(project), Path(agent), Path(state)
        self.omp, self.origin, self.owner = omp, origin.rstrip('/'), owner
        self.demo = demo
        self.ui = {}
        self.project_id = "default"
        self.projects = []
        self.agent_peers = [self]
        self.provider_store = None
        self.legacy_drafts = False
        self.native_env = {**os.environ, "PI_CODING_AGENT_DIR": str(self.agent.resolve())}
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.refresh_lock = threading.Lock()
        self.busy = False
        self.csrf = secrets.token_urlsafe(32)
        self.local_token = secrets.token_urlsafe(32)
        atomic(self.state_dir / 'local-token', self.local_token.encode())
        self.state_file = self.state_dir / 'state.json'
        self.state = json.loads(self.state_file.read_text(encoding='utf-8')) if self.state_file.exists() else {
            'managed': {}, 'catalog': {}, 'available': [], 'changes': [], 'favs': [],
            'refreshed': 0, 'error': '', 'backups': {}, 'attempted': 0}
        self.state.setdefault('attempted', 0)
        self.mode_file = self.state_dir / 'profile-modes.json'
        self.mode_journal = self.state_dir / 'profile-mode-transaction.json'
        self.mode_state = json.loads(self.mode_file.read_text(encoding='utf-8')) if self.mode_file.exists() else {'profiles': {}}
        self.recovery = None
        self.profile_warnings = []
        self._model_cache = None
        try:
            self.recover_modes()
        except Exception as error:
            # Start read-only instead of crash-looping under systemd/launchd; the journal stays.
            self.recovery_failed(error)
        self.insights = Insights(self, atomic)

    @property
    def managed(self):
        return self.provider_store['managed'] if self.provider_store is not None else self.state['managed']

    @managed.setter
    def managed(self, value):
        if self.provider_store is not None:
            self.provider_store['managed'] = value
        self.state['managed'] = value

    def persist(self):
        if self.provider_store is not None:
            atomic(self.provider_store['path'], json.dumps(self.managed, ensure_ascii=False).encode())
            self.state['managed'] = copy.deepcopy(self.managed)
        atomic(self.state_file, json.dumps(self.state, ensure_ascii=False).encode())

    def backup_dir(self):
        backup_dir = self.state_dir / 'backups'
        backup_dir.mkdir(mode=0o700, exist_ok=True)
        backup_dir.chmod(0o700)
        return backup_dir

    def path(self, profile):
        if not isinstance(profile, str) or not ID.fullmatch(profile):
            raise Problem('Некоректна назва профілю')
        p = self.project / '.omp' / ('config.yml' if profile == 'standard' else f'presets/{profile}.yml')
        if p.is_symlink() or not p.resolve().is_relative_to((self.project / '.omp').resolve()):
            raise Problem('Посилання замість конфігурації не підтримується')
        return p

    def read(self, p, shared=False):
        """Round-trip YAML for writes, or cached read-only plain data with `shared`."""
        try:
            raw = p.read_bytes()
            data = yaml_shared(raw) if shared else yaml_load(raw.decode('utf-8'))
        except Exception as e:
            raise Problem('Не вдалося прочитати YAML; оригінал не змінено', 422) from e
        if not isinstance(data, dict):
            raise Problem('Очікується YAML-об’єкт', 422)
        return data

    def revision(self, profile):
        base = self.path('standard').read_bytes()
        records = self.mode_state['profiles']
        meta = {k: {x: records[k].get(x) for x in ('normal', 'settings')} for k in ('standard', profile) if k in records}
        # The profile name is not part of a revision; renaming preserves its contents.
        if profile != 'standard' and profile in meta:
            meta['selected'] = meta.pop(profile)
        suffix = json.dumps(meta, sort_keys=True).encode() if meta else b''
        pool_suffix = self.pools_revision().encode() if self.mode_state.get('pools') else b''
        return digest(base + b'\0' + (self.path(profile).read_bytes() if profile != 'standard' else b'') + suffix + pool_suffix)

    def pools(self):
        return copy.deepcopy(self.mode_state.get('pools', {name: [] for name in POOL_NAMES}))

    def pools_revision(self):
        return fingerprint(self.pools())

    def save_pools(self, body):
        with self.lock:
            self.writable()
            if body.get('revision') != self.pools_revision():
                raise Problem('Спільні пули вже змінилися. Онови дані; чернетка лишиться у вікні.', 409)
            frozen = self.outside_edits('standard')
            try:
                pools = validate_pools(body.get('pools'), self.mode_catalog())
            except ValueError as e:
                raise Problem(str(e), 422) from e
            base, _ = self.profiles()
            return self.commit_mode({'name': 'standard', 'normal': base, 'pools': pools, 'poolsOnly': True, 'frozen': frozen})

    def native_profiles(self, shared=False):
        """Standard plus every readable preset. A broken or linked preset is reported, never fatal."""
        base = self.read(self.path('standard'), shared)
        profiles, warnings = {'standard': base}, []
        for p in sorted((self.project / '.omp/presets').glob('*.yml')):
            if ID.fullmatch(p.stem):
                try:
                    profiles[p.stem] = self.read(self.path(p.stem), shared)
                except Problem as error:
                    warnings.append(f'{p.name}: {error}')
        self.profile_warnings = warnings
        return base, profiles

    def profiles(self, shared=False):
        _, ps = self.native_profiles(shared)
        load = yaml_shared if shared else yaml_load
        for name in ps:
            record = self.mode_state['profiles'].get(name)
            if record:
                ps[name] = load(record['normal'])
        return ps['standard'], ps

    def mode_conflicts(self):
        """Recorded profiles whose file no longer holds the bytes Mana Tape wrote."""
        conflicts = []
        for name, record in self.mode_state['profiles'].items():
            try:
                raw = read_or_none(self.path(name))
            except Problem:
                conflicts.append(name)
                continue
            if raw is not None and digest(raw) != record.get('hash'):
                conflicts.append(name)
        return conflicts

    def mode_orphans(self):
        """Mode records whose native file was removed outside Mana Tape."""
        orphans = []
        for name in self.mode_state['profiles']:
            try:
                if not self.path(name).exists():
                    orphans.append(name)
            except Problem:
                pass
        return orphans

    def outside_edits(self, name):
        """Conflicting profiles a write must leave untouched. The target and Standard must be clean."""
        conflicts = self.mode_conflicts()
        blocking = [n for n in conflicts if n in ('standard', name)]
        if blocking:
            raise Problem('Файл змінено поза Mana Tape: ' + ', '.join(blocking)
                + '. Збереження зупинене, щоб не затерти ці зміни. Прийми поточний файл або віднови його.',
                409, 'mode-conflict', profiles=conflicts)
        return set(conflicts)

    def recovery_failed(self, error):
        log_failure('mode recovery', error)
        if isinstance(error, Problem):
            self.recovery = {'error': str(error), 'files': error.details.get('files', [])}
        else:
            self.recovery = {'error': RECOVERY + ': файли не вдалося повернути. Перевір місце на диску й права доступу.', 'files': []}

    def writable(self, accept=()):
        """Every write first finishes or rolls back an interrupted mode transaction."""
        if not self.mode_journal.exists():
            self.recovery = None
            return
        try:
            self.recover_modes(accept)
        except Exception as error:
            self.recovery_failed(error)
            raise Problem(self.recovery['error'], 409 if isinstance(error, Problem) else 503,
                'mode-recovery', files=self.recovery['files']) from error

    def recover_modes(self, accept=()):
        """Finish or roll back an interrupted mode transaction without overwriting outside edits.

        Files are compared as exact bytes. When not every file reached the journal's
        after state, files in that state are ours and are rolled back. A file in
        neither state was changed elsewhere: the journal stays and writes are refused
        until the owner accepts that file as it is.
        """
        if not self.mode_journal.exists():
            return
        journal = json.loads(self.mode_journal.read_text(encoding='utf-8'))
        files = journal['files']
        def encoded(text):
            return None if text is None else text.encode('utf-8')
        def current(name):
            try:
                return read_or_none(self.path(name))
            except Problem:
                return OUTSIDE  # A link was put in place of the file.
        if all(current(n) == encoded(row['after']) for n, row in files.items()):
            self.mode_state = journal['afterState']
        else:
            for name, row in files.items():
                now, before = current(name), encoded(row['before'])
                if now == before or now != encoded(row['after']):
                    continue
                path = self.path(name)
                if before is None:
                    path.unlink()
                    fsync_dir(path.parent)
                else:
                    atomic(path, before, row.get('mode') or (path.stat().st_mode & 0o777 if path.exists() else 0o600))
            outside = sorted(n for n, row in files.items() if current(n) != encoded(row['before']))
            if set(outside) - set(accept):
                raise Problem(RECOVERY + ': ' + ', '.join(outside) + ' змінено поза Mana Tape під час запису. '
                    'Інші файли повернуто. Перевір ці файли й прийми їх як є.', 409, 'mode-recovery', files=outside)
            if outside:
                # Accepted outside versions stay as they are; keep the journal for manual comparison.
                atomic(self.backup_dir() / f'{time.time_ns()}-profile-mode-transaction.json', self.mode_journal.read_bytes())
            self.mode_state = journal['beforeState']
        atomic(self.mode_file, json.dumps(self.mode_state, ensure_ascii=False).encode())
        self.mode_journal.unlink()
        fsync_dir(self.state_dir)
        self.recovery = None

    def transact(self, files, after):
        """Journal, native files, metadata, then drop the journal; a failure rolls back our writes.

        `files` maps profile → {'before', 'after', 'mode'} with None meaning absent.
        New files are created exclusively and never replace a file created meanwhile.
        """
        if self.mode_journal.exists():
            raise Problem(RECOVERY + '.', 409, 'mode-recovery')
        atomic(self.mode_journal, json.dumps({'files': files, 'beforeState': self.mode_state, 'afterState': after}, ensure_ascii=False).encode())
        try:
            for name, row in files.items():
                path = self.path(name)
                if read_or_none(path) != (None if row['before'] is None else row['before'].encode('utf-8')):
                    raise Problem('Зовнішня зміна під час запису', 409)
                if row['after'] is None:
                    path.unlink()
                    fsync_dir(path.parent)
                elif row['before'] is None:
                    create_new(path, row['after'].encode('utf-8'), row.get('mode') or 0o600)
                else:
                    atomic(path, row['after'].encode('utf-8'), row.get('mode') or 0o600)
            atomic(self.mode_file, json.dumps(after, ensure_ascii=False).encode())
        except Exception:
            try:
                self.recover_modes()
            except Exception as error:
                self.recovery_failed(error)
            raise
        self.mode_state = after
        self.mode_journal.unlink()
        fsync_dir(self.state_dir)

    def verified_free_models(self, models):
        providers = self.registry(shared=True).get('providers') or {}
        for raw, (endpoint, evidence) in VERIFIED_FREE_ROUTES.items():
            if raw not in models:
                continue
            provider = raw.split('/', 1)[0]
            configured = (providers.get(provider) or {}).get('baseUrl', endpoint)
            # A custom endpoint using the same provider name is not this offer.
            models[raw] = {**models[raw], 'freeEvidence': evidence if isinstance(configured, str) and configured.rstrip('/') == endpoint else None}
        return models

    def mode_catalog(self):
        cached, _ = self.cached()
        return self.verified_free_models({**cached, **self.state['catalog']})

    def mode_settings(self, name):
        record = self.mode_state['profiles'].get(name)
        return copy.deepcopy(record['settings']) if record else default_settings()

    def preview_profile(self, body):
        with self.lock:
            self.writable()
            return self.prepare_mode(body, shared=True)['public']

    def prepare_mode(self, body, shared=False):
        """Patch and compile one profile. `shared` previews on cached read-only YAML; saves use round-trip YAML."""
        name = body.get('profile')
        if not self.path(name).is_file():
            raise Problem('Профіль не знайдено', 404)
        if body.get('revision') != self.revision(name):
            raise Problem('Профіль або його режим змінився. Онови дані; чернетка лишиться у вікні.', 409)
        frozen = self.outside_edits(name)
        base, ps = self.profiles(shared)
        if name not in ps:
            self.read(self.path(name))  # Raises the precise YAML problem of this preset.
        data = copy.deepcopy(ps[name])
        roles = set(BUILTIN_ROLES) | set(merge(base, data).get('modelRoles', {}))
        changes = body.get('changes', [])
        if not isinstance(changes, list) or len(changes) > 150:
            raise Problem('Забагато змін')
        models = self.mode_catalog()
        self.patch_profile(data, changes, roles, name, base, models)
        full = data if name == 'standard' else merge(base, data)
        try:
            settings = validate_settings(body['modeSettings'] if 'modeSettings' in body else self.mode_settings(name),
                roles, models, full.get('task', {}).get('agentModelOverrides', {}))
        except ValueError as e:
            raise Problem(str(e)) from e
        statuses = route_statuses(models, self.managed)
        plan = compile_profile(full, settings, models, statuses, self.pools(), self.ui.get('visionRoles', ['vision']))
        token = fingerprint({'revision': self.revision(name), 'normal': data, 'settings': settings, 'effective': plan['effective']})
        public = {k: plain(v) for k, v in plan.items() if k != 'effective'}
        public.update({'token': token, 'settings': settings, 'statuses': {r: statuses.get(r, {'status': 'unknown', 'reason': 'Немає даних'}) for r in {raw_route(v) for v in settings['alternatives'] + [x for a in settings['overrides'].values() for x in a]}}, 'tariff': tariff_status()})
        return {'name': name, 'normal': data, 'settings': settings, 'plan': plan, 'statuses': statuses, 'public': public, 'frozen': frozen}

    def save_mode_profile(self, body):
        with self.lock:
            self.writable()
            prepared = self.prepare_mode(body)
            if prepared['plan']['issues']:
                raise Problem('Додай доступні альтернативи: '+', '.join(i['key'] for i in prepared['plan']['issues']), 422)
            if body.get('previewToken') != prepared['public']['token']:
                raise Problem('План змінився. Онови заміни, переглянь карту та збережи ще раз.', 409)
            return self.commit_mode(prepared)

    def commit_mode(self, prepared):
        name = prepared['name']
        # Profiles changed outside Mana Tape stay byte-for-byte untouched until adopted.
        frozen = set(prepared.get('frozen', ())) - {name}
        _, normals = self.profiles()
        before_bytes = {n: self.path(n).read_bytes() for n in normals}
        if prepared.get('new'):
            if self.path(name).exists():
                raise Problem('Профіль із такою назвою вже є', 409)
            before_bytes[name] = None
        normals[name] = prepared['normal']
        records = copy.deepcopy(self.mode_state['profiles'])
        prior = records.get(name)
        previous = {k: copy.deepcopy(prior.get(k, {})) for k in ('normal', 'settings', 'statuses', 'catalog')} if prior else {
            'normal': yaml_dump(prepared['normal']) if prepared.get('new') else before_bytes[name].decode('utf-8'), 'settings': default_settings(), 'statuses': {}, 'catalog': {}}
        models = self.mode_catalog()
        pools = prepared.get('pools', self.pools())
        settings = prepared['settings'] if 'settings' in prepared else self.mode_settings(name)
        full = normals['standard'] if name == 'standard' else merge(normals['standard'], normals[name])
        references = set(raw_route(r) for r in settings['alternatives'] + [r for values in settings['overrides'].values() for r in values]
            + list(full.get('modelRoles', {}).values()) + [r for values in full.get('retry', {}).get('fallbackChains', {}).values() for r in values]
            + [r for values in full.get('task', {}).get('agentModelOverrides', {}).values() for r in ([values] if isinstance(values, str) else values) if not r.startswith('@')])
        references = {raw_route(member) for ref in references for member in (pools.get(pool_name(ref), []) if pool_name(ref) is not None else [ref])}
        frozen_catalog = prepared.get('catalog', {r: {k: copy.deepcopy(models[r].get(k)) for k in ('id', 'name', 'kind', 'webSearch', 'cost', 'input', 'thinking', 'freeEvidence')} if r in models else None for r in references})
        if not prepared.get('poolsOnly'):
            # An adopted file keeps its exact text; other saves store the patched logical profile.
            normal = prepared['text'] if prepared.get('text') is not None else yaml_dump(prepared['normal'])
            records[name] = {**(prior or {}), 'normal': normal, 'settings': settings,
                'statuses': {r: v for r, v in prepared['statuses'].items() if r in references},
                'catalog': frozen_catalog, 'previous': previous, 'at': time.time()}
        projections = {}
        for n, overlay in normals.items():
            if n in frozen:
                continue
            full = overlay if n == 'standard' else merge(normals['standard'], overlay)
            settings = records[n]['settings'] if n in records else default_settings()
            statuses = records[n].get('statuses', {}) if n in records else {}
            profile_catalog = dict(models)
            # Availability and capabilities are fixed when this mode is saved.
            # Saving another profile must not silently reselect its routes.
            for raw, model in records.get(n, {}).get('catalog', {}).items():
                if model is None:
                    profile_catalog.pop(raw, None)
                else:
                    profile_catalog[raw] = {**profile_catalog.get(raw, {}), **model}
            projection = compile_profile(full, settings, profile_catalog, statuses, pools, self.ui.get('visionRoles', ['vision']))
            if projection['issues']:
                raise Problem('Неможливо зберегти робочий режим '+n+': '+projection['issues'][0]['message'], 422)
            projections[n] = projection
        compiled_base = projections['standard']['effective']
        outputs = {}
        for n, overlay in normals.items():
            if n in frozen:
                continue
            desired = projections[n]['effective']
            output = copy.deepcopy(overlay)
            inherited = output if n == 'standard' else merge(compiled_base, output)
            wanted_default = desired.get('retry', {}).get('fallbackChains', {}).get('default', [])
            if wanted_default != inherited.get('retry', {}).get('fallbackChains', {}).get('default', []):
                output.setdefault('retry', {}).setdefault('fallbackChains', {})['default'] = copy.deepcopy(wanted_default)
            for role, model in desired.get('modelRoles', {}).items():
                if inherited.get('modelRoles', {}).get(role) != model:
                    output.setdefault('modelRoles', {})[role] = model
                wanted = fallback_chain(desired, role)
                actual = fallback_chain(inherited, role)
                if wanted != actual:
                    output.setdefault('retry', {}).setdefault('fallbackChains', {})[role] = copy.deepcopy(wanted)
            for worker, values in desired.get('task', {}).get('agentModelOverrides', {}).items():
                if values != inherited.get('task', {}).get('agentModelOverrides', {}).get(worker):
                    output.setdefault('task', {}).setdefault('agentModelOverrides', {})[worker] = copy.deepcopy(values)
            normal_text = records[n]['normal'] if n in records else before_bytes[n].decode('utf-8')
            rendered = normal_text if plain(output) == plain(overlay) else yaml_dump(output)
            if plain(yaml_load(rendered)) != plain(output):
                raise Problem('Перевірка YAML не пройдена', 422)
            if n in records or rendered != normal_text:
                records[n] = {**records.get(n, {}), 'normal': normal_text, 'settings': records.get(n, {}).get('settings', default_settings()), 'statuses': records.get(n, {}).get('statuses', {}), 'hash': digest(rendered.encode('utf-8')), 'views': projections[n]['views']}
            outputs[n] = rendered
        files = {}
        for n, text in outputs.items():
            if text.encode('utf-8') == before_bytes[n]:
                continue
            files[n] = {'before': before_bytes[n].decode('utf-8') if before_bytes[n] is not None else None, 'after': text}
            if before_bytes[n] is not None:
                files[n]['mode'] = self.path(n).stat().st_mode & 0o777
        for n, raw in before_bytes.items():
            if n not in frozen and read_or_none(self.path(n)) != raw:
                raise Problem('Файл змінився під час підготовки. Збереження скасовано.', 409)
        after = {**self.mode_state, 'profiles': records}
        if 'pools' in prepared:
            after['pools'] = pools
        backup_dir = self.backup_dir()
        atomic(backup_dir/(str(time.time_ns())+'-profile-modes.json'), json.dumps(self.mode_state, ensure_ascii=False).encode())
        for n, row in files.items():
            if row['before'] is None:
                continue
            backup = backup_dir/(str(time.time_ns())+'-'+self.path(n).name)
            atomic(backup, row['before'].encode('utf-8')); self.state['backups'][str(self.path(n))] = str(backup)
        self.transact(files, after)
        self.persist()
        return {'ok': True, 'revision': self.revision(name)}

    def adopt(self, name, body):
        """Accept a profile file as it is now after an outside edit, or forget the record of a removed file.

        The file itself is never rewritten. Its former logical version stays in
        `previous`, so Restore can bring it back explicitly.
        """
        path = self.path(name)
        records = copy.deepcopy(self.mode_state['profiles'])
        record = records.get(name)
        raw = read_or_none(path)
        if raw is None:
            if record is None:
                raise Problem('Профіль не знайдено', 404)
            atomic(self.backup_dir() / f'{time.time_ns()}-forgotten-{name}-mode.json', json.dumps(record, ensure_ascii=False).encode())
            del records[name]
            self.transact({}, {**self.mode_state, 'profiles': records})
            return {'ok': True}
        if body.get('revision') != self.revision(name):
            raise Problem('Профіль змінився; онови дані', 409)
        if record is None or digest(raw) == record.get('hash'):
            return {'ok': True, 'revision': self.revision(name)}
        conflicts = self.mode_conflicts()
        if name != 'standard' and 'standard' in conflicts:
            raise Problem('Спочатку прийми файл Standard: від нього залежать інші профілі.', 409, 'mode-conflict', profiles=conflicts)
        normal = self.read(path)
        # The file is taken as written, so DeepSeek is ON; saved replacements stay for the next OFF.
        settings = {**self.mode_settings(name), 'mode': 'deepseek'}
        statuses = route_statuses(self.mode_catalog(), self.managed)
        return self.commit_mode({'name': name, 'normal': normal, 'text': raw.decode('utf-8'), 'settings': settings,
            'statuses': statuses, 'frozen': set(conflicts) - {name}})

    def refs(self, base=None, ps=None):
        if ps is None:
            base, ps = self.profiles(shared=True)
        pools = self.pools()
        out = {}
        for name, overlay in ps.items():
            p = merge(base, overlay)
            entries = list(p.get('modelRoles', {}).values())
            for a in p.get('retry', {}).get('fallbackChains', {}).values():
                entries += a
            for a in p.get('task', {}).get('agentModelOverrides', {}).values():
                entries += a if isinstance(a, list) else [a]
            settings = self.mode_state['profiles'].get(name, {}).get('settings', {})
            entries += settings.get('alternatives', []) + [v for values in settings.get('overrides', {}).values() for v in values]
            entries = [member for r in entries for member in (pools.get(pool_name(r), []) if pool_name(r) is not None else [r])]
            for r in entries:
                if isinstance(r, str) and '/' in r:
                    out.setdefault(raw_route(r), set()).add(name)
        return out

    def replace_yaml(self, path, data, expected=None):
        if path.is_symlink():
            # Writing through would edit a file elsewhere (dotfiles); replacing would break the link.
            raise Problem(path.name + ' — символьне посилання. Mana Tape не записує через посилання: '
                'заміни його звичайним файлом або змінюй ціль вручну.', 409, 'symlink')
        old = read_or_none(path) or b''
        if expected is not None and digest(old) != expected:
            raise Problem('Файл уже змінився. Онови дані й повтори зміну.', 409)
        rendered = yaml_dump(data).encode('utf-8')
        if plain(yaml_load(rendered.decode('utf-8'))) != plain(data):
            raise Problem('Перевірка YAML не пройдена', 422)
        if old == rendered:
            return
        backup_dir = self.backup_dir()
        backup = backup_dir / f'{time.time_ns()}-{path.name}'
        if old:
            atomic(backup, old)
        # Compare once more immediately before replacing; external OMP writers do not share our lock.
        if (read_or_none(path) or b'') != old:
            raise Problem('Файл змінився під час збереження', 409)
        atomic(path, rendered, (path.stat().st_mode & 0o777) if path.exists() else 0o600)
        if old:
            self.state['backups'][str(path)] = str(backup)
        self.persist()
        self.rotate_backups(path.name)

    def rotate_backups(self, name, keep=20):
        """Keep the newest direct-write backups of exactly this file name and every backup Restore points to.

        `<ns>-x-config.yml` or `<ns>-deleted-config.yml` never match `config.yml`.
        """
        pattern = re.compile(r'(\d+)-' + re.escape(name))
        referenced = {Path(p).name for p in self.state['backups'].values()}
        found = sorted((int(m[1]), p) for p in self.backup_dir().iterdir() if (m := pattern.fullmatch(p.name)))
        for _, expired in found[:-keep]:
            if expired.name not in referenced:
                expired.unlink(missing_ok=True)

    def agents(self):
        return agent_catalog(self.project, self.agent)

    def patch_profile(self, data, changes, roles, name, base=None, models=None):
        if base is None:
            base, _ = self.profiles(shared=True)
        known_agents, _ = self.agents()
        workers = set(known_agents) | set(merge(base, data).get('task', {}).get('agentModelOverrides', {}))
        models = self.mode_catalog() if models is None else models
        for change in changes:
            keys, value = change.get('path'), change.get('value')
            allowed = (isinstance(keys, list) and (
                (len(keys) == 2 and keys[0] == 'modelRoles' and keys[1] in roles) or
                (len(keys) == 3 and keys[:2] == ['retry', 'fallbackChains'] and keys[2] in roles) or
                (len(keys) == 3 and keys[:2] == ['task', 'agentModelOverrides'] and keys[2] in workers) or
                keys == ['disabledProviders']))
            if not allowed:
                raise Problem('Зміна цього поля не підтримується')
            if not change.get('remove'):
                if keys[0] == 'modelRoles':
                    valid_route(value)
                    self.validate_role_route(keys[1], value, models)
                elif keys == ['disabledProviders']:
                    if not isinstance(value, list) or len(value) > 200 or any(not isinstance(v, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}', v) for v in value):
                        raise Problem('Некоректний список провайдерів')
                else:
                    if not isinstance(value, list) or len(value) > 30:
                        raise Problem('До 30 моделей у ланцюгу')
                    for v in value:
                        if keys[0] == 'task' and isinstance(v, str) and v.startswith('@') and v[1:] in roles:
                            continue
                        valid_route(v)
                        if keys[0] == 'retry':
                            self.validate_role_route(keys[2], v, models)
                        elif keys[0] == 'task':
                            self.validate_role_route('task', v, models)
                    if keys[0] == 'task' and not value:
                        raise Problem('Агент потребує хоча б одного кандидата')
            target = data
            for key in keys[:-1]:
                target = target.setdefault(key, {})
            if change.get('remove'):
                builtin = (keys[0] in ('modelRoles', 'retry') and keys[-1] in BUILTIN_ROLES) or keys[0] == 'task'
                if name == 'standard' and not builtin:
                    raise Problem('Standard не має батьківського профілю')
                target.pop(keys[-1], None)
            else:
                target[keys[-1]] = copy.deepcopy(value)

    def validate_role_route(self, role, value, models):
        if pool_name(value) is not None:
            candidates = self.pools().get(pool_name(value), [])
        else:
            candidates = [value]
        for candidate in candidates:
            model = models.get(raw_route(candidate))
            if model and not accepts_model(role, model):
                raise Problem('CUT не підтримує роль '+role, 422)
            if not BUILTIN_ROLES.get(role, {}).get('thinking', True) and EFFORT.search(candidate):
                raise Problem('Ця роль не використовує thinking: '+role, 422)

    def save_profile(self, body):
        if 'modeSettings' in body:
            return self.save_mode_profile(body)
        with self.lock:
            self.writable()
            if self.mode_state['profiles'] or self.mode_state.get('pools'):
                raise Problem('Онови Mana Tape перед збереженням профілю з режимами.', 409)
            name = body.get('profile')
            path = self.path(name)
            if not path.exists():
                raise Problem('Профіль не знайдено', 404)
            raw = path.read_bytes()
            base_raw = raw if name == 'standard' else self.path('standard').read_bytes()
            revision = digest(base_raw + b'\0' + (raw if name != 'standard' else b''))
            if body.get('revision') != revision:
                raise Problem('Профіль або Standard уже змінився. Твоя чернетка збережена в цьому вікні. Онови дані перед повторним збереженням.', 409)
            original_hash = digest(raw)
            data = yaml_load(raw.decode('utf-8'))
            base = yaml_load(base_raw.decode('utf-8'))
            roles = set(BUILTIN_ROLES) | set(merge(base, data).get('modelRoles', {}))
            changes = body.get('changes')
            if not isinstance(changes, list) or not 1 <= len(changes) <= 150:
                raise Problem('Немає змін або забагато змін')
            self.patch_profile(data, changes, roles, name, base)
            if name != 'standard' and self.path('standard').read_bytes() != base_raw:
                raise Problem('Standard змінився під час збереження', 409)
            self.replace_yaml(path, data, original_hash)
            return {'ok': True, 'revision': self.revision(name)}

    def profile_action(self, body):
        with self.lock:
            name, action = body.get('profile'), body.get('action')
            path = self.path(name)
            # Adopting a file is also how the owner accepts it after an interrupted transaction.
            self.writable({name} if action == 'adopt' else ())
            if action == 'adopt':
                return self.adopt(name, body)
            if not path.is_file():
                raise Problem('Профіль не знайдено', 404)
            if action == 'clone':
                new_name = profile_name(body.get('name'))
                target = self.path(new_name)
                if target.exists():
                    raise Problem('Профіль із такою назвою вже є', 409)
                base, logical = self.profiles()
                if name not in logical:
                    self.read(path)  # Raises the precise YAML problem of this preset.
                data = merge(base, logical[name])
                if self.mode_state['profiles']:
                    frozen = self.outside_edits(name)
                    settings = self.mode_settings(name)
                    statuses = route_statuses(self.mode_catalog(), self.managed)
                    # Creation participates in the mode journal; no orphan YAML on failure.
                    self.commit_mode({'name': new_name, 'normal': data, 'settings': settings, 'statuses': statuses, 'new': True, 'frozen': frozen})
                else:
                    self.replace_yaml(target, data, digest(b''))
                return {'ok': True, 'name': new_name}
            if body.get('revision') != self.revision(name):
                raise Problem('Профіль змінився; онови дані', 409)
            if action == 'rename' and name != 'standard':
                new_name = profile_name(body.get('name'))
                target = self.path(new_name)
                if target == path:
                    return {'ok': True, 'name': new_name}
                if target.exists():
                    raise Problem('Профіль із такою назвою вже є', 409)
                text = path.read_bytes().decode('utf-8')
                records = copy.deepcopy(self.mode_state['profiles'])
                if name in records:
                    records[new_name] = records.pop(name)
                # One journaled step: the new name holds the exact YAML before the old one disappears.
                mode = path.stat().st_mode & 0o777
                try:
                    self.transact({new_name: {'before': None, 'after': text, 'mode': mode},
                                   name: {'before': text, 'after': None, 'mode': mode}},
                                  {**self.mode_state, 'profiles': records})
                except FileExistsError:
                    raise Problem('Профіль із такою назвою вже є', 409)
                backup = self.state['backups'].pop(str(path), None)
                if backup:
                    self.state['backups'][str(target)] = backup
                self.persist()
                return {'ok': True, 'name': new_name}
            elif action == 'restore':
                record = self.mode_state['profiles'].get(name)
                if record:
                    previous = record.get('previous')
                    if not previous:
                        raise Problem('Ще немає попередньої версії налаштувань режиму')
                    frozen = self.outside_edits(name)
                    return self.commit_mode({'name': name, 'normal': yaml_load(previous['normal']), 'settings': previous['settings'], 'statuses': previous.get('statuses', {}), 'catalog': previous.get('catalog', {}), 'frozen': frozen})
                backup = self.state['backups'].get(str(path))
                if not backup:
                    raise Problem('Ще немає резервної копії')
                self.replace_yaml(path, self.read(Path(backup)), digest(path.read_bytes()))
            elif action == 'delete' and name != 'standard':
                raw = path.read_bytes()
                backup_dir = self.backup_dir()
                atomic(backup_dir / f'{time.time_ns()}-deleted-{name}.yml', raw)
                records = copy.deepcopy(self.mode_state['profiles'])
                if name in records:
                    atomic(backup_dir/(str(time.time_ns())+'-deleted-'+name+'-mode.json'), json.dumps(records.pop(name), ensure_ascii=False).encode())
                self.transact({name: {'before': raw.decode('utf-8'), 'after': None, 'mode': path.stat().st_mode & 0o777}},
                              {**self.mode_state, 'profiles': records})
            else:
                raise Problem('Дія не підтримується')
            return {'ok': True}

    def registry(self, shared=False):
        p = self.agent / 'models.yml'
        return self.read(p, shared) if p.exists() else {'providers': {}}

    def cached(self, fresh=False):
        """OMP's sqlite model cache plus manual models.yml entries.

        Parsed sqlite rows are reused for up to 30 s while models.db and its WAL keep
        the same stat; `fresh` (catalog refresh) always reads them again.
        """
        db = self.agent / 'models.db'
        key = (stat_key(db), stat_key(db.with_name('models.db-wal')))
        hit = self._model_cache
        if fresh or not hit or hit[0] != key or time.monotonic() - hit[1] > 30:
            rows, stamps = {}, {}
            if key[0] is not None:
                con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
                try:
                    for provider_key, stamp, authority, raw in con.execute('SELECT provider_id, updated_at, authoritative, models FROM model_cache ORDER BY updated_at').fetchall():
                        provider = provider_key.split(':', 1)[0]
                        stamps[provider] = {'at': stamp / 1000, 'authoritative': bool(authority)}
                        models = json.loads(raw)
                        if isinstance(models, dict):
                            models = models.get('models', [])
                        for m in models:
                            if isinstance(m, dict) and isinstance(m.get('id'), str):
                                rows[provider + '/' + m['id']] = catalog_entry(m, provider, 'cache')
                finally:
                    con.close()
            hit = self._model_cache = (key, time.monotonic(), rows, stamps)
        result = {r: dict(m) for r, m in hit[2].items()}
        for provider, cfg in (self.registry(shared=True).get('providers') or {}).items():
            for m in (cfg.get('models') or [] if isinstance(cfg, dict) else []):
                if isinstance(m, dict) and isinstance(m.get('id'), str):
                    key = provider + '/' + m['id']
                    result[key] = {**result.get(key, {}), **catalog_entry(m, provider, 'config')}
        return result, copy.deepcopy(hit[3])

    def recovery_status(self):
        if not self.mode_journal.exists():
            return None
        return self.recovery or {'error': RECOVERY + '.', 'files': []}

    def snapshot(self):
        with self.lock:
            base, ps = self.profiles(shared=True)
            cached, stamps = self.cached()
            # Per-request copies: decorating them must never leak UI fields into state.json.
            models = {r: dict(m) for r, m in self.verified_free_models({**cached, **self.state['catalog']}).items()}
            refs = self.refs(base, ps)
            for r in refs:
                provider, mid = r.split('/', 1)
                models.setdefault(r, {'provider': provider, 'id': mid, 'name': mid, 'source': 'reference'})
            available = set(self.state['available'])
            registry = self.registry(shared=True).get('providers') or {}
            provider_ids = sorted({m['provider'] for m in models.values()} | set(registry) | set(self.managed))
            providers = []
            for provider in provider_ids:
                config = registry.get(provider) if isinstance(registry.get(provider), dict) else {}
                managed = self.managed.get(provider, {})
                providers.append({'id': provider, 'custom': provider in registry, 'managed': bool(managed),
                    'name': managed.get('name', provider), 'api': config.get('api', ''),
                    'url': self.safe_url(config.get('baseUrl', '')), 'discovery': config.get('discovery', {}).get('type', ''),
                    'auth': config.get('auth', 'apiKey'), 'hasKey': bool(config.get('apiKey')),
                    'manualModels': [m['id'] for m in config.get('models', [])],
                    'expires': managed.get('expires', 0), 'expired': managed.get('expired', False), 'expiryConflict': managed.get('expiryConflict', False), 'expiryReason': managed.get('expiryReason', ''),
                    'count': sum(m['provider'] == provider and m.get('status') != 'missing' for m in models.values()),
                    'connected': any(r.startswith(provider + '/') for r in available),
                    'used': sorted(set().union(*(v for r, v in refs.items() if r.startswith(provider + '/')))) if any(r.startswith(provider + '/') for r in refs) else [],
                    **stamps.get(provider, {})})
            local = set(self.ui.get('localProviders', []))
            for r, m in models.items():
                m['local'] = m['provider'] in local or (registry.get(m['provider']) or {}).get('discovery', {}).get('type') in ('ollama', 'llama.cpp', 'lm-studio')
                m['available'] = r in available
                m['name'] = m.get('name') or m['id']
                m['usedBy'] = sorted(refs.get(r, set()))
            agents, agent_warnings = self.agents()
            records = self.mode_state['profiles']
            def relevant(p):
                return plain({k: p[k] for k in ('modelRoles', 'retry', 'task', 'disabledProviders') if k in p})
            models_yml = read_or_none(self.agent / 'models.yml')
            return {'source': str(self.project), 'projectId': self.project_id, 'projects': self.projects,
                'ui': self.ui, 'legacyDrafts': self.legacy_drafts, 'demo': self.demo, 'base': relevant(base),
                'builtinRoles': list(BUILTIN_ROLES.values()),
                'agents': list(agents.values()), 'agentWarnings': agent_warnings,
                'presets': {k: relevant(v) for k, v in ps.items() if k != 'standard'},
                'profileWarnings': self.profile_warnings,
                'revisions': {k: self.revision(k) for k in ps},
                'freePools': self.pools(), 'poolsRevision': self.pools_revision(),
                'restorable': [k for k in ps if records.get(k, {}).get('previous') or k not in records and str(self.path(k)) in self.state['backups']],
                'profileModes': {k: {'settings': self.mode_settings(k), 'views': records.get(k, {}).get('views'), 'at': records.get(k, {}).get('at')} for k in ps},
                'modeConflicts': self.mode_conflicts(), 'modeOrphans': self.mode_orphans(),
                'modeRecovery': self.recovery_status(), 'tariff': tariff_status(),
                'models': list(models.values()), 'providers': providers,
                'providerRevision': digest(models_yml if models_yml is not None else b''),
                'favs': self.state['favs'], 'changes': self.state['changes'][-100:],
                'refresh': {'busy': self.busy, 'at': self.state['refreshed'], 'error': self.state['error']},
                'insights': self.insights.snapshot(), 'csrf': self.csrf}

    @staticmethod
    def safe_url(value):
        try:
            u = urlsplit(value)
            if u.username or u.password or u.query or u.fragment:
                return ''
            return value
        except ValueError:
            return ''

    def registry_refs(self):
        refs = {}
        for peer in self.agent_peers:
            for r, profiles in peer.refs().items():
                refs.setdefault(r, set()).update(peer.project_id+"/"+name for name in profiles)
        return refs

    def remove_key_files(self, values, data):
        """Delete Mana Tape key files that no provider references any more.

        Only files directly inside `<agent>/forge-keys` written by this server are
        touched; any other `!cat` target belongs to the owner.
        """
        root = (self.agent / 'forge-keys').resolve()
        live = {str(cfg.get('apiKey')) for cfg in (data.get('providers') or {}).values() if isinstance(cfg, dict) and cfg.get('apiKey')}
        for value in values:
            if not isinstance(value, str) or str(value) in live:
                continue
            try:
                parts = shlex.split(value)
            except ValueError:
                continue
            if len(parts) != 2 or parts[0] != '!cat':
                continue
            keyfile = Path(parts[1])
            if keyfile.is_absolute() and not keyfile.is_symlink() and keyfile.parent.resolve() == root and keyfile.is_file():
                keyfile.unlink()

    def provider_save(self, body):
        with self.lock:
            self.writable()
            pid = body.get('id', '')
            if not isinstance(pid, str) or not ID.fullmatch(pid):
                raise Problem('ID: малі латинські літери, цифри, дефіс')
            path = self.agent / 'models.yml'
            if path.is_symlink():
                raise Problem('models.yml — символьне посилання. Mana Tape не записує через посилання: '
                    'заміни його звичайним файлом або змінюй ціль вручну.', 409, 'symlink')
            current_hash = digest(read_or_none(path) or b'')
            if body.get('revision') != current_hash:
                raise Problem('Провайдери вже змінились. Онови дані.', 409)
            data = self.registry()
            if not isinstance(data.get('providers'), dict):
                data['providers'] = {}
            providers = data['providers']
            exists = pid in providers
            renewing = self.managed.get(pid, {}).get('expired', False)
            if not exists and not renewing and (pid in self.managed or any(m['provider'] == pid for m in self.cached()[0].values())):
                raise Problem('Цей ID уже належить провайдеру OMP; використай інший')
            old_key = (providers.get(pid) or {}).get('apiKey') if exists else None
            if body.get('action') == 'delete':
                if not exists:
                    raise Problem('Вбудований провайдер можна лише вимкнути у профілі')
                uses = sorted({p for r, profiles in self.registry_refs().items() if r.startswith(pid + '/') for p in profiles})
                if uses:
                    raise Problem('Спочатку заміни моделі у профілях: ' + ', '.join(uses), 409)
                providers.pop(pid)
                self.replace_yaml(path, data, current_hash)
                self.remove_key_files([old_key], data)
                self.managed.pop(pid, None)
                self.state['available'] = [r for r in self.state['available'] if not r.startswith(pid + '/')]
                self.persist()
                return {'ok': True}
            url = body.get('url', '')
            u = urlsplit(url)
            if u.scheme not in ('http', 'https') or not u.hostname or not self.safe_url(url) or len(url) > 2000:
                raise Problem('Потрібна HTTP(S)-адреса без ключів, логіна чи параметрів')
            if u.hostname in ('169.254.169.254', 'metadata.google.internal'):
                raise Problem('Ця адреса не є API моделей')
            api = body.get('api')
            if api not in ('openai-completions', 'openai-responses', 'anthropic-messages'):
                raise Problem('Непідтримуваний API')
            discovery = body.get('discovery', '')
            if discovery not in ('', 'openai-models-list', 'ollama', 'llama.cpp', 'lm-studio', 'litellm'):
                raise Problem('Непідтримуваний спосіб отримання моделей')
            ids = body.get('models', [])
            if not isinstance(ids, list) or len(ids) > 500:
                raise Problem('Забагато ручних моделей')
            for mid in ids:
                valid_route(pid + '/' + mid)
            if not ids and not discovery:
                raise Problem('Увімкни отримання списку або вкажи ID моделей')
            auth = body.get('auth', 'apiKey')
            if auth not in ('none', 'apiKey'):
                raise Problem('Непідтримувана авторизація')
            key = body.get('key', '')
            if not isinstance(key, str) or len(key) > 16000 or '\n' in key or '\r' in key:
                raise Problem('Некоректний ключ')
            config = copy.deepcopy(providers.get(pid, {}))
            if not exists or url != config.get('baseUrl'):
                # Never silently send an existing credential to a different endpoint.
                if auth != 'none' and not key:
                    raise Problem('Для нової адреси введи ключ заново')
            if auth != 'none' and not key and not config.get('apiKey'):
                raise Problem('Потрібен API-ключ')
            days = body.get('days', 0)
            if not isinstance(days, int) or isinstance(days, bool) or days not in (-1, 0, 1, 7, 30):
                raise Problem('Некоректний термін')
            previous_meta = self.managed.get(pid)
            deadline = (previous_meta or {}).get('expires', 0) if days == -1 else time.time() + days * 86400 if days else 0
            if deadline and deadline <= time.time():
                raise Problem('Термін минув; обери новий термін дії')
            config.update({'baseUrl': url, 'api': api, 'auth': auth})
            keyfile = None
            if key and auth != 'none':
                keyfile = self.agent / 'forge-keys' / (pid + '-' + secrets.token_hex(6))
                keyfile.parent.mkdir(mode=0o700, exist_ok=True)
                keyfile.parent.chmod(0o700)
                atomic(keyfile, key.encode(), 0o600)
                # The path is generated by the server; the browser cannot submit commands.
                config['apiKey'] = '!cat ' + shlex.quote(str(keyfile))
                config['authHeader'] = True
            if auth == 'none':
                config.pop('apiKey', None)
                config.pop('authHeader', None)
            if discovery:
                config['discovery'] = {'type': discovery, 'timeoutMs': 10000}
            else:
                config.pop('discovery', None)
            old_models = {m['id']: m for m in config.get('models', [])}
            config['models'] = [old_models.get(mid, {'id': mid, 'name': mid}) for mid in dict.fromkeys(ids)]
            providers[pid] = config
            self.managed[pid] = {'name': str(body.get('name') or pid)[:80],
                'expires': deadline, 'expired': False,
                'fingerprint': fingerprint(config)}
            try:
                # Persist expiry before publishing the provider, so a crash cannot lose its deadline.
                self.persist()
                self.replace_yaml(path, data, current_hash)
            except Exception:
                if previous_meta is None:
                    self.managed.pop(pid, None)
                else:
                    self.managed[pid] = previous_meta
                self.persist()
                if keyfile is not None:
                    keyfile.unlink(missing_ok=True)
                raise
            self.remove_key_files([old_key], data)
            return {'ok': True}

    def expire(self):
        with self.lock:
            previous_meta = copy.deepcopy(self.managed)
            previous_available = self.state['available'][:]
            path = self.agent / 'models.yml'
            raw = read_or_none(path) or b''
            data = yaml_load(raw.decode('utf-8')) if raw else {'providers': {}}
            providers = data.get('providers') if isinstance(data.get('providers'), dict) else {}
            try:
                refs = self.registry_refs()
            except Exception as error:
                # Unknown usage is never treated as unused.
                log_failure('expiry references', error)
                refs = None
            linked = path.is_symlink()
            changed, removed_keys, now = False, [], time.time()
            for pid, meta in self.managed.items():
                if not meta.get('expires', 0) or now < meta['expires'] or meta.get('expired'):
                    continue
                config = providers.get(pid)
                reason = ''
                if config is None:
                    meta['expired'] = True
                elif refs is None:
                    reason = 'unchecked'
                elif any(r.startswith(pid + '/') for r in refs):
                    reason = 'used'
                elif linked:
                    reason = 'symlink'
                elif fingerprint(config) == meta.get('fingerprint'):
                    removed_keys.append((providers.pop(pid) or {}).get('apiKey'))
                    meta['expired'] = True
                    changed = True
                    self.state['available'] = [r for r in self.state['available'] if not r.startswith(pid + '/')]
                else:
                    reason = 'edited'
                if reason:
                    meta.update(expiryConflict=True, expiryReason=reason)
                else:
                    meta.pop('expiryConflict', None)
                    meta.pop('expiryReason', None)
            if changed:
                try:
                    self.replace_yaml(path, data, digest(raw))
                except Exception:
                    self.managed = previous_meta
                    self.state['available'] = previous_available
                    raise
                self.remove_key_files(removed_keys, data)
            # Nothing to record most of the time: no state rewrite every 30 s.
            if changed or self.managed != previous_meta:
                self.persist()

    def free_bridge_routes(self, native):
        """A fresh, complete bridge snapshot proves absence without inference.

        Excluded rows still exist upstream. Partial discovery or an offline
        extension cache must never turn a configured CUT into DELETED.
        """
        if self.demo or not (self.agent / 'extensions' / 'opencode-free.js').is_file():
            return None
        home = Path(self.native_env.get('OMP_FREE_HOME') or Path.home() / '.config/omp-free-bridge').expanduser()
        try:
            snapshot = json.loads((home / 'catalog.json').read_text(encoding='utf-8'))
            checked, expires = snapshot['checked_at'], snapshot['expires_at']
            if (snapshot.get('schema') != 1 or snapshot.get('notes') != []
                    or type(checked) not in (int, float) or type(expires) not in (int, float)
                    or not checked <= time.time() < expires or not 0 < expires - checked <= 900):
                return None
            models, excluded = snapshot['models'], snapshot['excluded']
            if not isinstance(models, list) or not isinstance(excluded, list):
                return None
            if any(not isinstance(m, dict) or not isinstance(m.get('id'), str)
                   or not m['id'] or m.get('lane') not in ('zen', 'go') for m in models + excluded):
                return None
            prefix = 'opencode-free/'
            allowed = {prefix + m['id'] for m in models}
            if allowed != {m['provider'] + '/' + m['id'] for m in native if m['provider'] == 'opencode-free'}:
                return None
            return allowed | {prefix + m['id'] for m in excluded}
        except (OSError, ValueError, TypeError, KeyError):
            return None

    def withdrawn_routes(self, native):
        """Per gateway: withdrawn FREE routes, or None when the public list proves nothing."""
        result = {}
        for pid, url in PUBLIC_MODEL_LISTS.items():
            if self.demo or not any(m.get('provider') == pid for m in native):
                continue
            try:
                listing = public_listing(url)
            except Exception:
                listing = None
            result[pid] = withdrawn_free_routes(pid, native, listing)
        return result

    def refresh(self):
        if not self.refresh_lock.acquire(blocking=False):
            return
        start = time.time()
        self.busy = True
        try:
            with self.lock:
                self.state['attempted'] = start
                prior = set(self.state['available'])
                cached_before, before_stamps = self.cached(fresh=True)
                known_before = set(self.state.get('known', set(cached_before) | set(self.state['catalog'])))
            # No prompt, no inference, no project extensions or active sessions touched.
            command = [self.omp, 'models', 'refresh', '--kind', 'all', '--json', '--no-extensions']
            # Discovery stays disabled; load only this explicitly installed bridge.
            extension = self.agent / 'extensions' / 'opencode-free.js'
            if not self.demo and extension.is_file():
                command += ['-e', str(extension)]
            run = subprocess.run(command,
                cwd=self.state_dir, env=self.native_env, capture_output=True, timeout=120)
            if run.returncode or b'models.yml validation failed' in run.stderr:
                raise Problem('OMP не оновив каталог. Попередні дані збережено.')
            data = json.loads(run.stdout)
            native = data['models']
            if not isinstance(native, list):
                raise ValueError('models')
            bridge_routes = self.free_bridge_routes(native)
            withdrawn = self.withdrawn_routes(native)
            with self.lock:
                cache, stamps = self.cached(fresh=True)
                old = self.state['catalog']
                was_missing = {r for r, m in old.items() if m.get('status') == 'missing'}
                was_withdrawn = {r for r, m in old.items() if m.get('withdrawn')}
                seen = set()
                changes = []
                for raw in native:
                    provider, mid = raw['provider'], raw['id']
                    r = provider + '/' + mid
                    seen.add(r)
                    model = catalog_entry(raw, provider, 'omp')
                    model['status'] = 'present'
                    if self.state['refreshed'] and r not in known_before:
                        model['newAt'] = start
                        changes.append({'kind': 'new', 'route': r, 'at': start})
                    elif old.get(r, {}).get('newAt'):
                        model['newAt'] = old[r]['newAt']
                    old[r] = model
                for pid, routes in withdrawn.items():
                    if routes is None:
                        # A failed or unconvincing list keeps the last confirmed result.
                        routes = {r for r in was_withdrawn if r.startswith(pid + '/')}
                    for r in routes & seen:
                        if r not in was_missing:
                            changes.append({'kind': 'missing', 'route': r, 'at': start})
                        old[r].update(status='missing', withdrawn=True)
                candidates = set(prior)
                if bridge_routes is not None:
                    configured = set(self.refs()) | {raw_route(r) for members in self.pools().values() for r in members}
                    candidates.update(r for r in set(old) | set(cached_before) | configured if r.startswith('opencode-free/'))
                for r in candidates - seen:
                    pid = r.split('/', 1)[0]
                    stamp = stamps.get(pid, {})
                    # Absence only counts after fresh authoritative discovery; failures retain cache.
                    removed = (r not in bridge_routes if pid == 'opencode-free' and bridge_routes is not None else
                        stamp.get('authoritative') and stamp.get('at', 0) >= start - 2
                            and stamp.get('at', 0) > before_stamps.get(pid, {}).get('at', 0)
                            and any(r.startswith(pid + '/') for r in seen))
                    if removed:
                        if old.get(r, {}).get('status') != 'missing':
                            changes.append({'kind': 'missing', 'route': r, 'at': start})
                        old.setdefault(r, dict(cached_before.get(r, {'provider': pid, 'id': r.split('/', 1)[1], 'source': 'reference'})))['status'] = 'missing'
                self.state['available'] = sorted(seen)
                self.state['known'] = sorted(known_before | set(cache) | seen)
                self.state['changes'] = (self.state['changes'] + changes)[-500:]
                self.state['refreshed'], self.state['error'] = time.time(), ''
                self.persist()
        except Exception as error:
            log_failure('catalog refresh', error)
            with self.lock:
                self.state['error'] = 'Оновлення не завершилось. Показано останній каталог; моделі не видалено.'
                self.persist()
        finally:
            self.busy = False
            self.refresh_lock.release()

    def refresh_async(self):
        threading.Thread(target=self.refresh, daemon=True).start()

    def maintain_once(self):
        # Expiry and refresh fail separately: one bad file must not stop catalog updates.
        try:
            self.expire()
        except Exception as error:
            log_failure('provider expiry', error)
            self.state['error'] = 'Не вдалося виконати фонову перевірку; конфігурації збережено.'
        try:
            if time.time() - self.state['attempted'] >= 900:
                self.refresh_async()
        except Exception as error:
            log_failure('catalog refresh start', error)

    def maintain(self):
        while True:
            self.maintain_once()
            time.sleep(30)


_GZIP, _GZIP_LOCK = OrderedDict(), threading.Lock()


def gzip_cached(tag, raw):
    """Compressed static bytes, reused per content ETag."""
    with _GZIP_LOCK:
        hit = _GZIP.get(tag)
        if hit is not None:
            _GZIP.move_to_end(tag)
            return hit
    packed = gzip.compress(raw, 6, mtime=0)
    with _GZIP_LOCK:
        _GZIP[tag] = packed
        while len(_GZIP) > 64:
            _GZIP.popitem(last=False)
    return packed


# Local assets linked from index.html; any hand-written ?v= is replaced by the content version.
SHELL_ASSET = re.compile(r'(\b(?:src|href)=")(/[A-Za-z0-9_./-]+\.(?:js|css|svg|png|webmanifest|woff2))(?:\?v=[^"]*)?"')


def asset_version(raw):
    return digest(raw)[:12]


def pinned_shell(raw):
    """index.html with every local asset URL pinned to its current content (`?v=<sha256 prefix>`).

    Such a URL can be cached as immutable: new content always gets a new URL,
    without anyone remembering to bump a version by hand.
    """
    def pin(match):
        asset = (STATIC / match[2].lstrip('/')).resolve()
        if not asset.is_relative_to(STATIC) or not asset.is_file():
            return match[0]
        return f'{match[1]}{match[2]}?v={asset_version(asset.read_bytes())}"'
    return SHELL_ASSET.sub(pin, raw.decode('utf-8')).encode('utf-8')


def accepts_gzip(header):
    explicit, wildcard = None, 0.0
    for part in (header or '').split(','):
        name, _, params = part.strip().partition(';')
        q = 1.0
        for param in params.split(';'):
            key, _, value = param.strip().partition('=')
            if key.strip().lower() == 'q':
                try:
                    q = float(value)
                except ValueError:
                    q = 0.0
        name = name.strip().lower()
        if name == 'gzip':
            explicit = q
        elif name == '*':
            wildcard = q
    return (explicit if explicit is not None else wildcard) > 0


def etag_matches(header, tag):
    if not header:
        return False
    if header.strip() == '*':
        return True
    return tag.removeprefix('W/') in {t.strip().removeprefix('W/') for t in header.split(',')}


class Handler(BaseHTTPRequestHandler):
    server_version = 'Forge'
    # Keep-alive; every response carries Content-Length (304 has no body).
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(30)
        self.peer = False

    def log_message(self, *_):
        pass  # Do not log paths, form contents, credentials or model output.

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except ConnectionError:
            self.close_connection = True  # The client went away; there is nobody to answer.

    def trusted_proxy(self):
        """Tailscale identity counts only from tailscaled (root) or this server's own user.

        Another local account cannot read local-token and must not pass as the proxy.
        Without Linux /proc the peer is unknowable; SECURITY.md documents that residual risk.
        """
        if getattr(self, 'peer', False) is False:
            self.peer = peer_uid(self.client_address[1], self.server.server_port)
        return self.peer is None or self.peer in (0, os.getuid())

    def check_access(self):
        app = self.server.app
        # Identity headers are meaningful only behind the local private proxy.
        if self.client_address[0] not in ('127.0.0.1', '::1'):
            raise Problem('Доступ лише через локальний приватний проксі', 403)
        host = self.headers.get('Host', '')
        allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        remote_host = urlsplit(app.origin).netloc
        if remote_host:
            allowed.add(remote_host)
        if host not in allowed:
            raise Problem('Невідомий хост', 403)
        if host == remote_host or any(self.headers.get(h) for h in ('X-Forwarded-For', 'X-Forwarded-Proto', 'Tailscale-User-Login')):
            if not app.owner or self.headers.get('Tailscale-User-Login') != app.owner:
                raise Problem('Потрібен доступ власника через Tailscale', 403)
            if not self.trusted_proxy():
                raise Problem('Заголовки Tailscale приймаються лише від локального tailscaled', 403)
        elif app.origin and not secrets.compare_digest(self.headers.get('X-Forge-Local', ''), app.local_token):
            raise Problem('Відкрий панель через приватну HTTPS-адресу', 403)
        origin = self.headers.get('Origin')
        expected = app.origin if host == remote_host else 'http://' + host
        if origin and origin != expected:
            raise Problem('Запит з іншого сайту відхилено', 403)
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise Problem('Запит з іншого сайту відхилено', 403)
        if self.command == 'POST':
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json' or self.headers.get('X-Forge-CSRF') != app.csrf:
                raise Problem('Онови сторінку перед збереженням', 403)

    def selected_app(self):
        apps = getattr(self.server, 'apps', None)
        if not apps:
            return self.server.app
        values = parse_qs(urlsplit(self.path).query).get('project', [self.server.app.project_id])
        if len(values) != 1 or values[0] not in apps:
            raise Problem('Проєкт не знайдено', 404)
        return apps[values[0]]

    def respond(self, status, data, kind='application/json; charset=utf-8', etag=None, cache=None, packed=None):
        raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False, default=json_value).encode()
        if etag and status == 200 and etag_matches(self.headers.get('If-None-Match'), etag):
            status, raw = 304, b''
        compressible = kind.startswith(COMPRESSIBLE)
        encoding = ''
        if status != 304 and compressible and len(raw) > 1024 and accepts_gzip(self.headers.get('Accept-Encoding')):
            raw, encoding = (packed() if packed else gzip.compress(raw, 6, mtime=0)), 'gzip'
        self.send_response(status)
        if status != 304:
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(raw)))
        if encoding:
            self.send_header('Content-Encoding', encoding)
        if compressible:
            self.send_header('Vary', 'Accept-Encoding')
        if etag:
            self.send_header('ETag', etag)
        api = self.path.startswith('/api/')
        self.send_header('Cache-Control', 'no-store' if api or status >= 400 else cache or 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
        if self.close_connection:
            self.send_header('Connection', 'close')
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    def do_GET(self):
        try:
            self.check_access()
            parts = urlsplit(self.path)
            if parts.path == '/api/state':
                app = self.selected_app()
                with app.lock:
                    data = app.snapshot()
                    raw = json.dumps(data, ensure_ascii=False, default=json_value).encode()
                    # The panel ignores the server clock in tariff.at when comparing snapshots; so does the ETag.
                    stable = json.dumps({**data, 'tariff': {**data['tariff'], 'at': 0}}, ensure_ascii=False, default=json_value).encode()
                return self.respond(200, raw, etag='W/"' + digest(stable)[:32] + '"')
            filename = 'index.html' if parts.path == '/' else parts.path.lstrip('/')
            p = (STATIC / filename).resolve()
            if not p.is_relative_to(STATIC) or not p.is_file():
                raise Problem('Не знайдено', 404)
            raw = p.read_bytes()
            if p == STATIC / 'index.html':
                raw = pinned_shell(raw)
            tag = '"' + digest(raw)[:32] + '"'
            # Only a URL pinned to this exact content is immutable; the shell, sw.js and
            # any other ?v= are revalidated with the ETag instead.
            pinned = parse_qs(parts.query).get('v') == [asset_version(raw)] and p.name not in ('index.html', 'sw.js')
            self.respond(200, raw, mimetypes.guess_type(p)[0] or 'application/octet-stream', etag=tag,
                cache='public, max-age=31536000, immutable' if pinned else 'no-cache', packed=lambda: gzip_cached(tag, raw))
        except Problem as e:
            self.respond(e.status, e.body())
        except ConnectionError:
            raise
        except Exception:
            log_failure('GET')
            self.respond(500, {'error': 'Не вдалося прочитати дані. Конфігурації не змінено.'})

    def do_POST(self):
        consumed = False
        try:
            self.check_access()
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > 200000:
                raise Problem('Неприпустимий розмір запиту', 413)
            raw = self.rfile.read(size)
            consumed = True
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise Problem('Очікується об’єкт')
            app = self.selected_app()
            path = urlsplit(self.path).path
            if path == '/api/free-pools':
                result = app.save_pools(body)
            elif path == '/api/profile-preview':
                result = app.preview_profile(body)
            elif path == '/api/profile':
                result = app.save_profile(body)
            elif path == '/api/profile-action':
                result = app.profile_action(body)
            elif path == '/api/provider':
                result = app.provider_save(body)
                app.refresh_async()
            elif path == '/api/refresh':
                if time.time() - app.state['attempted'] < 20:
                    raise Problem('Оновлення вже виконано. Зачекай кілька секунд.', 429)
                app.refresh_async()
                threading.Thread(target=app.insights.update, daemon=True).start()
                result = {'ok': True}
            elif path == '/api/favorites':
                values = body.get('values')
                if not isinstance(values, list) or len(values) > 500:
                    raise Problem('Некоректний список обраних')
                for value in values:
                    valid_route(value)
                with app.lock:
                    app.writable()
                    app.state['favs'] = list(dict.fromkeys(values))
                    app.persist()
                result = {'ok': True}
            else:
                raise Problem('Не знайдено', 404)
            self.respond(200, result)
        except Problem as e:
            # An unread request body would be parsed as the next request on this connection.
            self.close_connection = self.close_connection or not consumed
            self.respond(e.status, e.body())
        except ConnectionError:
            raise
        except (ValueError, TypeError, KeyError):
            log_failure('POST')
            self.close_connection = self.close_connection or not consumed
            self.respond(400, {'error': 'Некоректні дані запиту'})
        except Exception:
            log_failure('POST')
            self.close_connection = self.close_connection or not consumed
            self.respond(500, {'error': 'Не вдалося виконати дію. Онови сторінку й перевір збережений стан.'})


def load_installation(config_path):
    """Load trusted local installation config. Never accepts paths from HTTP clients."""
    config_path = Path(config_path).expanduser().resolve()
    cfg = yaml_load(config_path.read_text(encoding='utf-8'))
    def location(value):
        path = Path(os.path.expandvars(str(value))).expanduser()
        return (config_path.parent / path).resolve() if not path.is_absolute() else path.resolve()
    entries = cfg.get('projects')
    if not isinstance(entries, list) or not entries:
        raise ValueError('У конфігурації потрібен непорожній список projects')
    state_root = location(cfg.get('state', '~/.local/share/mana-tape'))
    default_agent = cfg.get('agent', '~/.omp/agent')
    omp = os.path.expandvars(os.path.expanduser(cfg.get('omp', 'omp')))
    omp = shutil.which(omp) or omp
    apps, paths, states, locks = {}, set(), set(), {}
    for entry in entries:
        pid = entry.get('id', '')
        if not ID.fullmatch(pid) or pid in apps:
            raise ValueError('Кожен проєкт потребує унікального id: a-z, 0-9, _ або -')
        project = location(entry['path'])
        state = location(entry['state']) if entry.get('state') else state_root / pid
        if project in paths or state in states:
            raise ValueError('Проєкти та каталоги стану не можуть дублюватися')
        if not (project / '.omp/config.yml').is_file():
            raise ValueError(f'Немає .omp/config.yml для проєкту {pid}')
        paths.add(project); states.add(state)
        agent = location(entry.get('agent', default_agent))
        app = Forge(project, agent, state, omp, cfg.get('origin', ''), cfg.get('owner', ''), cfg.get('demo', False))
        app.project_id = pid
        app.ui = entry.get('ui', {})
        app.legacy_drafts = bool(entry.get('legacyDrafts', False))
        # Registry writes for projects sharing an OMP agent use the same lock.
        app.lock = locks.setdefault(agent, threading.RLock())
        apps[pid] = app
    stores = {}
    for agent in locks:
        shared_path = state_root / 'registries' / digest(str(agent).encode())[:16] / 'providers.json'
        if shared_path.exists():
            managed = json.loads(shared_path.read_text(encoding='utf-8'))
        else:
            managed = {}
            for app in apps.values():
                if app.agent != agent:
                    continue
                for pid, meta in app.managed.items():
                    if pid in managed and managed[pid] != meta:
                        raise ValueError('Конфлікт старих метаданих спільного провайдера: '+pid)
                    managed[pid] = copy.deepcopy(meta)
            atomic(shared_path, json.dumps(managed, ensure_ascii=False).encode())
        stores[agent] = {'path': shared_path, 'managed': managed}
    menu = [{'id': e['id'], 'name': str(e.get('name', e['id']))} for e in entries]
    first = next(iter(apps.values()))
    for app in apps.values():
        app.projects = menu
        app.provider_store = stores[app.agent]
        app.agent_peers = [peer for peer in apps.values() if peer.agent == app.agent]
        app.csrf, app.local_token = first.csrf, first.local_token
        atomic(app.state_dir / 'local-token', first.local_token.encode())
    return cfg, apps


def main():
    p = argparse.ArgumentParser(description='Mana Tape — редактор профілів OMP')
    p.add_argument('--config', help='Локальний YAML зі списком проєктів')
    p.add_argument('--project')
    p.add_argument('--agent', default=os.path.expanduser('~/.omp/agent'))
    p.add_argument('--state')
    p.add_argument('--omp', default=shutil.which('omp') or 'omp')
    p.add_argument('--origin', default='')
    p.add_argument('--owner', default='')
    p.add_argument('--port', type=int)
    p.add_argument('--no-refresh', action='store_true')
    p.add_argument('--demo', action='store_true', help='Позначити ізольовану тестову інсталяцію')
    a = p.parse_args()
    os.umask(0o077)
    if a.config:
        cfg, apps = load_installation(a.config)
    else:
        if not a.project or not a.state:
            p.error('Потрібен --config або обидва --project і --state')
        cfg = {}
        app = Forge(Path(a.project).expanduser().resolve(), Path(a.agent).expanduser().resolve(), Path(a.state).expanduser().resolve(), a.omp, a.origin, a.owner, a.demo)
        app.projects = [{'id': 'default', 'name': app.project.name}]
        apps = {'default': app}
    port = a.port or cfg.get('port', 19421)
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.app, server.apps = next(iter(apps.values())), apps
    server.daemon_threads = True
    if not a.no_refresh and not cfg.get('noRefresh', False):
        for app in apps.values():
            threading.Thread(target=app.maintain, daemon=True).start()
            threading.Thread(target=app.insights.loop, daemon=True).start()
    print(f'Mana Tape: http://127.0.0.1:{port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
