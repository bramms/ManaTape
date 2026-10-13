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
from profile_modes import (EFFORT, POOL_NAMES, POOL_PREFIX, chain_entries, collapse_pools, compile_profile, default_settings, is_deepseek, is_free_model, pool_name, raw_route,
    route_statuses, route_text, tariff_status, thinking_efforts, validate_pools, validate_settings)
from omp_roles import BUILTIN_ROLES, agent_catalog, accepts_model, fallback_chain
from scopes import (PRESET_NAME, PRESET_PREFIX, THINKING_LEVELS, active_preset, changed_keys, discover, effective as layered_config,
    layer_presets, legacy_project, managed_part, model_chain_keys, omp_merge, parse_preset, preset_view, project_config, project_layer,
    onto, role_selector, scope_id, short_diff, sources as value_sources, visible_presets, with_unmanaged)
from insights import Insights
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, quote
import html
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
# Top-level files OMP discovers in an extensions directory; the catalog refresh loads the agent's own explicitly.
EXTENSION_SUFFIXES = ('.js', '.ts')


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


def compile_input(data):
    """A layer as Mana Tape compiles it. Values OMP does not read as model selectors (a null or list role, a chain
    that is not a list of selectors, a null agent) take no part; the file keeps them exactly as they are."""
    if not isinstance(data, dict):
        return {}
    out = dict(data)
    def selectors(value):
        return isinstance(value, list) and all(isinstance(v, str) for v in value)
    if 'modelRoles' in out:
        roles = out['modelRoles']
        out['modelRoles'] = {k: v for k, v in roles.items() if isinstance(v, str) and v} if isinstance(roles, dict) else {}
    for group, key, ok in (('retry', 'fallbackChains', selectors), ('task', 'agentModelOverrides', lambda v: isinstance(v, str) or selectors(v))):
        node = out.get(group)
        if group in out and not isinstance(node, dict):
            del out[group]  # OMP ignores a scalar in place of a settings group.
        elif isinstance(node, dict) and key in node:
            values = node[key]
            out[group] = {**node, key: {k: v for k, v in values.items() if ok(v)} if isinstance(values, dict) else {}}
    if 'disabledProviders' in out and not selectors(out['disabledProviders']):
        del out['disabledProviders']
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
    def __init__(self, project, agent, state, omp, origin='', owner='', demo=False, omp_dir=None, parent=None, machine=None):
        self.project, self.agent, self.state_dir = Path(project), Path(agent), Path(state)
        # A project scope keeps <project>/.omp; the Global scope is the OMP agent directory itself.
        self.omp_dir = Path(omp_dir) if omp_dir else self.project / '.omp'
        self.omp, self.origin, self.owner = omp, origin.rstrip('/'), owner
        self.demo = demo
        self.ui = {}
        self.project_id = "default"
        self.projects = []
        self.agent_peers = [self]
        self.provider_store = None
        self.legacy_drafts = False
        # Layers: a project scope inherits the Global scope (OMP merges <agent>/config.yml, then <cwd>/.omp/config.yml).
        self.parent, self.machine, self.installation = parent, machine, None
        self.kind = 'global' if omp_dir is not None and Path(omp_dir) == Path(agent) else 'project'
        # The Global config may not exist yet; it is created on the first explicit save.
        self.optional_standard = self.kind == 'global'
        self.origin_kind = 'explicit'
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
        self._diff_cache = {}
        # The scope whose catalogue, refresh loop and telemetry this one shares (one per OMP agent directory).
        self.catalog_owner = None
        try:
            self.recover_modes()
        except Exception as error:
            # Start read-only instead of crash-looping under systemd/launchd; the journal stays.
            self.recovery_failed(error)
        if machine is None and self.recovery is None:
            try:
                self.backfill_written()
            except Exception as error:
                log_failure('record backfill', error)
        self.insights = Insights(self, atomic)

    @property
    def cat(self):
        """Catalogue state (catalog, available, known, changes, refresh times and error): the lead scope's for every
        scope of one agent directory, so one refresh loop serves them all."""
        return (self.catalog_owner or self).state

    @property
    def lead(self):
        return self.catalog_owner or self

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
        owner = self.catalog_owner
        if owner is not None:
            # The shared catalogue lives in the lead scope's state.json.
            if owner.provider_store is not None:
                owner.state['managed'] = copy.deepcopy(owner.managed)
            atomic(owner.state_file, json.dumps(owner.state, ensure_ascii=False).encode())

    def backup_dir(self):
        backup_dir = self.state_dir / 'backups'
        backup_dir.mkdir(mode=0o700, exist_ok=True)
        backup_dir.chmod(0o700)
        return backup_dir

    def path(self, profile, read=False):
        """The native file of a profile. A native preset (`preset:<name>`) lives inside the scope's config file.

        A scope file that is a symbolic link (dotfiles) is read through the link (`read`) but never written: every
        write refuses it with code `symlink`. That scope is read-only; every other scope keeps working.
        """
        if isinstance(profile, str) and profile.startswith(PRESET_PREFIX):
            if not PRESET_NAME.fullmatch(profile[len(PRESET_PREFIX):]):
                raise Problem('Некоректна назва котушки OMP')
            profile = 'standard'
        if not isinstance(profile, str) or not ID.fullmatch(profile):
            raise Problem('Некоректна назва профілю')
        p = self.omp_dir / ('config.yml' if profile == 'standard' else f'presets/{profile}.yml')
        if p.is_symlink():
            if read and profile == 'standard':
                return p
            raise Problem(self.symlink_text(p), 409, 'symlink', scope=self.project_id, file=self.file_label(p))
        if not p.resolve().is_relative_to(self.omp_dir.resolve()):
            raise Problem('Посилання замість конфігурації не підтримується')
        return p

    def file_label(self, path):
        """A file as the panel names it: `.omp/config.yml`, `.omp/presets/gpu.yml`, Global `agent/config.yml`."""
        path = Path(path)
        return str(path.relative_to(self.omp_dir.parent)) if path.is_relative_to(self.omp_dir.parent) else path.name

    def scope_title(self, lower=False):
        title = ('глобальна область' if self.kind == 'global' else 'проєкт ' + self.scope_name()) if self.installation is not None else 'проєкт'
        return title if lower else title[0].upper() + title[1:]

    def symlink_text(self, path):
        return (f'{self.scope_title()}: {self.file_label(path)} — символьне посилання (наприклад, dotfiles). Mana Tape читає '
            'цей файл, але не записує через посилання: зміни вноси в ціль посилання вручну або заміни посилання звичайним файлом.')

    def read_only(self):
        """Why this scope's file cannot be written (a symbolic link), or None."""
        p = self.omp_dir / 'config.yml'
        return {'code': 'symlink', 'error': self.symlink_text(p), 'file': self.file_label(p)} if p.is_symlink() else None

    def read(self, p, shared=False):
        """Round-trip YAML for writes, or cached read-only plain data with `shared`."""
        if self.optional_standard and not p.exists() and p == self.omp_dir / 'config.yml':
            return freeze({}) if shared else yaml_load('{}')
        try:
            raw = p.read_bytes()
            data = yaml_shared(raw) if shared else yaml_load(raw.decode('utf-8'))
        except Exception as e:
            raise Problem('Не вдалося прочитати YAML; оригінал не змінено', 422) from e
        if not isinstance(data, dict):
            raise Problem('Очікується YAML-об’єкт', 422)
        return data

    def standard_bytes(self):
        return read_or_none(self.path('standard', read=True)) or b''

    def parent_data(self, strict=False):
        """The Global config file as OMP reads it (compiled routes), or None for the Global scope itself.

        An unreadable Global file reads as empty for display; `strict` (every write) refuses instead, because a
        project compiled against nothing would drop the overrides it needs.
        """
        if self.parent is None:
            return None
        try:
            return self.parent.read(self.parent.path('standard', read=True), shared=True)
        except Problem as error:
            if strict:
                raise Problem('Глобальний файл ' + self.parent.file_label(self.parent.omp_dir / 'config.yml') + ' не читається як '
                    'YAML-об’єкт. Запис у проєкт зупинено, доки його не виправлено.', 409, 'parent') from error
            return {}

    def parent_tag(self):
        """What a project's revision follows of its Global file: only the keys its compile and apply read."""
        raw = self.parent.standard_bytes()
        try:
            data = yaml_shared(raw) if raw else {}
            if not isinstance(data, dict):
                raise ValueError('not a mapping')
        except Exception:
            return digest(raw)
        return fingerprint({'managed': managed_part(data), 'storage': data.get('modelRoleStorage')})

    def layered(self, data, parent=None):
        """This layer as OMP sees it: Global config, then this project's config (OMP merge rules)."""
        parent = self.parent_data() if parent is None else parent
        return data if parent is None else layered_config(parent, data)

    def revision(self, profile):
        base = self.standard_bytes()
        records = self.mode_state['profiles']
        native = isinstance(profile, str) and profile.startswith(PRESET_PREFIX)
        meta = {k: {x: records[k].get(x) for x in ('normal', 'settings')} for k in ('standard', profile) if k in records}
        # The profile name is not part of a revision; renaming preserves its contents.
        if profile != 'standard' and profile in meta:
            meta['selected'] = meta.pop(profile)
        if native and profile[len(PRESET_PREFIX):] in self.mode_state.get('presets', {}):
            meta['selected'] = {'settings': self.mode_state['presets'][profile[len(PRESET_PREFIX):]].get('settings')}
        suffix = json.dumps(meta, sort_keys=True).encode() if meta else b''
        pool_suffix = self.pools_revision().encode() if any(self.pools().values()) or self.mode_state.get('pools') else b''
        # A project revision also follows the Global file it inherits from, but only the keys a project compiles
        # against: OMP rewriting the Global theme or thinking level does not invalidate project drafts.
        parent = b'\0\0' + self.parent_tag().encode() if self.parent is not None else b''
        own = self.path(profile).read_bytes() if profile != 'standard' and not native else b''
        return digest(base + b'\0' + own + suffix + pool_suffix + parent)

    def pools(self):
        if self.machine is not None:
            return self.machine.pools()
        return copy.deepcopy(self.mode_state.get('pools', {name: [] for name in POOL_NAMES}))

    def pools_revision(self):
        return fingerprint(self.pools())

    def save_pools(self, body):
        if self.machine is not None:
            return self.machine.save_pools(self, body)
        with self.lock:
            self.writable()
            if body.get('revision') != self.pools_revision():
                raise Problem('Спільні пули вже змінилися. Чернетка пулів лишилась у вікні; «Скинути» завантажить збережені.', 409, 'revision')
            frozen = self.outside_edits('standard')
            try:
                pools = validate_pools(body.get('pools'), self.mode_catalog())
            except ValueError as e:
                raise Problem(str(e), 422) from e
            base, _ = self.profiles()
            return self.commit_mode({'name': 'standard', 'normal': base, 'pools': pools, 'poolsOnly': True, 'frozen': frozen})

    def native_profiles(self, shared=False):
        """Standard plus every readable legacy preset file. A broken or linked preset is reported, never fatal."""
        base = self.read(self.path('standard', read=True), shared)
        profiles, warnings = {'standard': base}, []
        for p in sorted((self.omp_dir / 'presets').glob('*.yml')):
            if ID.fullmatch(p.stem):
                try:
                    profiles[p.stem] = self.read(self.path(p.stem), shared)
                except Problem as error:
                    warnings.append(f'{p.name}: {error}')
        self.profile_warnings = warnings
        return base, profiles

    def profiles(self, shared=False):
        """Logical profiles: the recorded version of each file Mana Tape wrote, the file itself otherwise.

        A file OMP or the owner changed only outside the keys Mana Tape manages (theme, thinking level, ...) is no
        conflict: its logical version takes those keys from the file, so the next write keeps them.
        """
        _, ps = self.native_profiles(shared)
        load = yaml_shared if shared else yaml_load
        for name in ps:
            record = self.mode_state['profiles'].get(name)
            if record:
                logical = load(record['normal'])
                if self.drift(name) == 'soft':
                    logical = with_unmanaged(logical, ps[name])
                    logical = freeze(plain(logical)) if shared else logical
                ps[name] = logical
        return ps['standard'], ps

    def drift(self, name):
        """How a recorded profile's file stands against what Mana Tape last wrote: 'clean'; 'soft' when only keys Mana
        Tape does not manage changed; 'conflict'; 'missing' (removed outside)."""
        record = self.mode_state['profiles'].get(name) or {}
        try:
            raw = read_or_none(self.path(name, read=True))
        except Problem:
            return 'conflict'
        if raw is None:
            return 'missing'
        if digest(raw) == record.get('hash'):
            return 'clean'
        written = record.get('written')
        if written is None:
            return 'conflict'
        try:
            now, then = yaml_shared(raw), yaml_shared(written)
        except Exception:
            return 'conflict'
        if not isinstance(now, dict) or not isinstance(then, dict):
            return 'conflict'
        return 'soft' if managed_part(now) == managed_part(then) else 'conflict'

    def native_presets(self, base=None):
        """This scope's own OMP model presets (`modelPresets` in its config file), logical form: {name: entry}."""
        if base is None:
            base, _ = self.profiles(shared=True)
        return {name: entry for name, entry in layer_presets(plain(base)).items() if 'invalid' not in entry}

    def uses_pools(self):
        """Logical profiles, presets or replacement lists of this scope that hold a FREE pool block."""
        return POOL_PREFIX in json.dumps(self.mode_state, ensure_ascii=False)

    def preset_settings(self, name):
        record = self.mode_state.get('presets', {}).get(name)
        return copy.deepcopy(record['settings']) if record and record.get('settings') else default_settings()

    def mode_conflicts(self):
        """Recorded profiles whose file changed outside Mana Tape in the keys Mana Tape manages."""
        return [name for name in self.mode_state['profiles'] if self.drift(name) == 'conflict']

    def mode_orphans(self):
        """Mode records whose native file was removed outside Mana Tape."""
        orphans = []
        for name in self.mode_state['profiles']:
            try:
                if not self.path(name, read=True).exists():
                    orphans.append(name)
            except Problem:
                pass
        return orphans

    def outside_edits(self, name):
        """Conflicting profiles a write must leave untouched. The target and Standard must be clean.

        The refusal names the scope and the file: a project action that also writes the Global file (promote,
        apply) can be blocked by the Global scope, and the owner accepts the file there.
        """
        conflicts = self.mode_conflicts()
        blocking = [n for n in conflicts if n in ('standard', name)]
        if blocking:
            diffs = self.conflict_diffs(blocking)
            files = ', '.join(diffs[n]['file'] for n in blocking)
            raise Problem(f'{self.scope_title()}: файл {files} змінено поза Mana Tape у значеннях, якими керує панель. '
                'Запис зупинено, щоб не затерти ці зміни. Прийми поточний файл у цій області («Прийняти файл») або віднови його.',
                409, 'mode-conflict', profiles=conflicts, diffs=diffs, scope=self.project_id, scopes={self.project_id: sorted(conflicts)})
        return set(conflicts)

    def conflict_diffs(self, names=None):
        """What changed outside Mana Tape, per conflicting file: at most six human lines (`+`, `−`, `~`).

        Compared with the exact text Mana Tape wrote. A record saved before that text was kept compares with what
        its logical version compiles to now (`approximate`): pool blocks and DeepSeek replacements are no noise.
        """
        out = {}
        for name in self.mode_conflicts() if names is None else names:
            record = self.mode_state['profiles'].get(name) or {}
            try:
                path = self.path(name, read=True)
                raw = read_or_none(path)
                now = plain(self.read(path, shared=True))
            except Problem:
                out[name] = {'file': f'{name}', 'lines': ['файл не читається як YAML-об’єкт'], 'approximate': False}
                continue
            written = record.get('written')
            key = (name, digest(raw or b''), record.get('hash'), written is None)
            if key in self._diff_cache:
                out[name] = self._diff_cache[key]
                continue
            try:
                old = plain(yaml_shared(written)) if written is not None else self.compiled_estimate(name, record)
            except Exception:
                old = {}
            out[name] = self._diff_cache[key] = {'file': self.file_label(path), 'lines': short_diff(old, now), 'approximate': written is None}
            if len(self._diff_cache) > 64:
                self._diff_cache.pop(next(iter(self._diff_cache)))
        return out

    def compiled_estimate(self, name, record):
        """What Mana Tape most likely wrote for a record that predates `written`: its logical version compiled with
        the settings and catalogue it was saved with. Falls back to the logical version itself."""
        logical = yaml_load(record.get('normal') or '')
        try:
            conflicts = set(self.mode_conflicts()) - {name}
            plan = self.plan_commit({'name': name, 'normal': logical, 'settings': record.get('settings') or default_settings(),
                'statuses': record.get('statuses', {}), 'catalog': record.get('catalog', {}), 'frozen': conflicts}, check=False)
            return plain(yaml_shared(plan['outputs'][name]))
        except Exception:
            return plain(logical)

    def backfill_written(self):
        """Records saved before `written` existed get the exact text of their file when it is still in sync (a
        state-only write, once): later outside edits then show exact diffs, and edits outside the keys Mana Tape
        manages are recognised as no conflict."""
        if self.mode_journal.exists() or (self.machine is not None and self.machine.journal.exists()):
            return False
        records, changed = copy.deepcopy(self.mode_state['profiles']), False
        for name, record in records.items():
            if record.get('written') is not None:
                continue
            try:
                raw = read_or_none(self.path(name, read=True))
            except Problem:
                continue
            if raw is not None and digest(raw) == record.get('hash'):
                try:
                    record['written'] = raw.decode('utf-8')
                    changed = True
                except UnicodeDecodeError:
                    continue
        if changed:
            self.mode_state = {**self.mode_state, 'profiles': records}
            atomic(self.mode_file, json.dumps(self.mode_state, ensure_ascii=False).encode())
        return changed

    def recovery_failed(self, error):
        log_failure('mode recovery', error)
        if isinstance(error, Problem):
            self.recovery = {'error': str(error), 'files': error.details.get('files', [])}
        else:
            self.recovery = {'error': RECOVERY + ': файли не вдалося повернути. Перевір місце на диску й права доступу.', 'files': []}

    def writable(self, accept=()):
        """Every write first finishes or rolls back an interrupted mode transaction (cross-scope first)."""
        if self.machine is not None:
            self.machine.writable({str(self.path(n)) for n in accept})
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
        return self.verified_free_models({**cached, **self.cat['catalog']})

    def mode_settings(self, name):
        record = self.mode_state['profiles'].get(name)
        return copy.deepcopy(record['settings']) if record else default_settings()

    def preview_profile(self, body):
        with self.lock:
            self.writable()
            return self.prepare_mode(body, shared=True)['public']

    def prepare_mode(self, body, shared=False):
        """Patch and compile one profile. `shared` previews on cached read-only YAML; saves use round-trip YAML.

        A native preset (`preset:<name>`) is an entry of the scope file: the file is what gets written, the preset
        keeps its own DeepSeek mode, and only its role models and thinking level can change.
        """
        name = body.get('profile')
        native = isinstance(name, str) and name.startswith(PRESET_PREFIX)
        # A preview reads a linked scope file; the write itself refuses it (plan_commit).
        path = self.path(name, read=True)
        if not path.is_file() and not (self.optional_standard and path == self.omp_dir / 'config.yml'):
            raise Problem('Профіль не знайдено', 404)
        if body.get('revision') != self.revision(name):
            raise Problem('Профіль або його режим змінився в іншому вікні чи редакторі. Чернетка лишилась у вікні: «Конфлікт…» на кромці переносить її на актуальні файли.', 409, 'revision')
        frozen = self.outside_edits('standard' if native else name)
        base, ps = self.profiles(shared)
        changes = body.get('changes', [])
        if not isinstance(changes, list) or len(changes) > 150:
            raise Problem('Забагато змін')
        models = self.mode_catalog()
        if native:
            pname = name[len(PRESET_PREFIX):]
            data = copy.deepcopy(ps['standard'])
            entries = data.get('modelPresets') if isinstance(data.get('modelPresets'), dict) else {}
            if pname not in entries or isinstance(parse_preset(plain(entries[pname])), str):
                raise Problem('Котушку OMP не знайдено або її запис некоректний', 404)
            scope_full = compile_input(self.layered(data))
            roles = set(BUILTIN_ROLES) | set(scope_full.get('modelRoles', {})) | set(plain(entries[pname]).get('modelRoles', {}))
            self.patch_preset(entries[pname], changes, roles, models)
            entry = parse_preset(plain(entries[pname]))
            if isinstance(entry, str):
                raise Problem('Котушка OMP: ' + entry, 422)
            full = preset_view(scope_full, entry)
            requested = body['modeSettings'] if 'modeSettings' in body else self.preset_settings(pname)
        else:
            if name not in ps:
                self.read(path)  # Raises the precise YAML problem of this preset.
            data = copy.deepcopy(ps[name])
            roles = set(BUILTIN_ROLES) | set(compile_input(self.layered(data) if name == 'standard' else merge(self.layered(base), data)).get('modelRoles', {}))
            self.patch_profile(data, changes, roles, name, base, models)
            full = compile_input(self.layered(data) if name == 'standard' else merge(self.layered(base), data))
            requested = body['modeSettings'] if 'modeSettings' in body else self.mode_settings(name)
        try:
            settings = validate_settings(requested, roles, models, full.get('task', {}).get('agentModelOverrides', {}))
        except ValueError as e:
            raise Problem(str(e)) from e
        statuses = route_statuses(models, self.managed)
        plan = compile_profile(full, settings, models, statuses, self.pools(), self.ui.get('visionRoles', ['vision']))
        if native:
            # A preset carries primaries only: problems of chains and agents belong to the scope file.
            plan['issues'] = [i for i in plan['issues'] if i['key'].startswith('role:') and i['key'][5:] in entry['modelRoles']]
        # Only what Mana Tape compiles: an OMP edit of the Global theme between preview and save changes no plan.
        token = fingerprint({'revision': self.revision(name), 'normal': data, 'settings': settings, 'effective': managed_part(plain(plan['effective']))})
        public = {k: plain(v) for k, v in plan.items() if k != 'effective'}
        public.update({'token': token, 'settings': settings, 'statuses': {r: statuses.get(r, {'status': 'unknown', 'reason': 'Немає даних'}) for r in {raw_route(v) for v in settings['alternatives'] + [x for a in settings['overrides'].values() for x in a]}}, 'tariff': tariff_status()})
        if native:
            return {'name': 'standard', 'profile': name, 'preset': pname, 'presetSettings': settings, 'normal': data,
                'settings': self.mode_settings('standard'), 'plan': plan, 'statuses': statuses, 'public': public, 'frozen': frozen}
        return {'name': name, 'normal': data, 'settings': settings, 'plan': plan, 'statuses': statuses, 'public': public, 'frozen': frozen}

    def patch_preset(self, entry, changes, roles, models):
        """The only edits a native OMP preset can carry: role models and defaultThinkingLevel."""
        for change in changes:
            keys, value = change.get('path'), change.get('value')
            if isinstance(keys, list) and len(keys) == 2 and keys[0] == 'modelRoles' and keys[1] in roles:
                target = entry.setdefault('modelRoles', {})
                if change.get('remove'):
                    target.pop(keys[1], None)
                else:
                    valid_route(value)
                    self.validate_role_route(keys[1], value, models)
                    target[keys[1]] = value
            elif keys == ['defaultThinkingLevel']:
                if change.get('remove') or value is None:
                    entry.pop('defaultThinkingLevel', None)
                elif value in THINKING_LEVELS:
                    entry['defaultThinkingLevel'] = value
                else:
                    raise Problem('Невідомий рівень thinking')
            else:
                raise Problem('Котушка OMP зберігає лише моделі ролей і рівень thinking. Резерви, агенти й провайдери '
                    'належать області: змінюй їх у Standard.', 422, 'preset-field')

    def save_mode_profile(self, body):
        with self.lock:
            self.writable()
            prepared = self.prepare_mode(body)
            if prepared['plan']['issues']:
                raise Problem('Додай доступні альтернативи: '+', '.join(i['key'] for i in prepared['plan']['issues']), 422)
            if body.get('previewToken') != prepared['public']['token']:
                raise Problem('План змінився. Онови заміни, переглянь карту та збережи ще раз.', 409)
            return self.commit_mode(prepared, body=body)

    def commit_mode(self, prepared, dry=False, body=None):
        """Write one profile's logical version and every native file it changes; `dry` only returns those files.

        With `body` (an owner's action in an installation) a change the action did not ask for — what any write of
        this scope would carry now, see `extra_changes` — is written only with the `confirm` token of its preview.
        """
        plan = self.plan_commit(prepared)
        if dry:
            return plan['files']
        if body is not None and self.machine is not None and plan['files']:
            confirm_extra(body, extra_changes([(self, plan, self.drift_plan())]))
        self.apply_plan(plan)
        return {'ok': True, 'revision': self.revision(prepared.get('profile', prepared['name']))}

    def drift_plan(self):
        """What any write of this scope would carry whatever the action: its logical Standard recompiled unchanged
        against the current Global file, catalogue and pools. Never written; None when it cannot be compiled."""
        try:
            return self.plan_commit(self.server_prepared(self.logical_standard()), check=False)
        except Exception:
            return None

    def frozen_catalog(self, models, references):
        return {r: {k: copy.deepcopy(models[r].get(k)) for k in ('id', 'name', 'kind', 'webSearch', 'cost', 'input', 'thinking', 'freeEvidence')} if r in models else None for r in references}

    @staticmethod
    def references(full, settings, pools):
        refs = set(raw_route(r) for r in settings['alternatives'] + [r for values in settings['overrides'].values() for r in values]
            + list(full.get('modelRoles', {}).values()) + [r for values in full.get('retry', {}).get('fallbackChains', {}).values() for r in values]
            + [r for values in full.get('task', {}).get('agentModelOverrides', {}).values() for r in ([values] if isinstance(values, str) else values) if not r.startswith('@')])
        return {raw_route(member) for ref in refs for member in (pools.get(pool_name(ref), []) if pool_name(ref) is not None else [ref])}

    def plan_commit(self, prepared, parent=None, check=True):
        """Native files, logical metadata and backups of one change, without writing anything.

        `parent` replaces the Global file a project inherits, when one cross-scope transaction writes both.
        """
        name = prepared['name']
        parent = self.parent_data(strict=True) if parent is None else parent
        def layered(data):
            return data if parent is None else layered_config(parent, data)
        # Profiles changed outside Mana Tape stay byte-for-byte untouched until adopted.
        frozen = set(prepared.get('frozen', ())) - {name}
        soft = {n for n in self.mode_state['profiles'] if self.drift(n) == 'soft'}
        _, normals = self.profiles()
        before_bytes = {n: read_or_none(self.path(n)) for n in normals}
        if prepared.get('new'):
            if self.path(name).exists():
                raise Problem('Профіль із такою назвою вже є', 409)
            before_bytes[name] = None
        old_standard = normals['standard']
        normals[name] = prepared['normal']
        records = copy.deepcopy(self.mode_state['profiles'])
        removed = prepared.get('remove')
        if removed is not None:
            # A migrated legacy preset leaves in the same journal as the file that takes it over.
            normals.pop(removed)
            records.pop(removed, None)
        presets = copy.deepcopy(prepared['presetRecords'] if 'presetRecords' in prepared else self.mode_state.get('presets', {}))
        prior = records.get(name)
        before_text = before_bytes[name].decode('utf-8') if before_bytes.get(name) is not None else ''
        previous = {k: copy.deepcopy(prior.get(k, {})) for k in ('normal', 'settings', 'statuses', 'catalog')} if prior else {
            'normal': yaml_dump(prepared['normal']) if prepared.get('new') else before_text, 'settings': default_settings(), 'statuses': {}, 'catalog': {}}
        models = self.mode_catalog()
        pools = prepared.get('pools', self.pools())
        settings = prepared['settings'] if 'settings' in prepared else self.mode_settings(name)
        full = compile_input(layered(normals['standard']) if name == 'standard' else merge(layered(normals['standard']), normals[name]))
        references = self.references(full, settings, pools)
        frozen_catalog = prepared.get('catalog', self.frozen_catalog(models, references))
        if prepared.get('preset') or prepared.get('keepStandardMode'):
            # A preset edit rewrites the scope file but keeps the file's own mode, availability and Restore point.
            records['standard'] = {**(records.get('standard') or {'settings': default_settings(), 'statuses': {}, 'catalog': {}}),
                'normal': yaml_dump(prepared['normal'])}
            if prepared.get('preset'):
                pname, psettings = prepared['preset'], prepared['presetSettings']
                entry = (plain(prepared['normal']).get('modelPresets') or {}).get(pname) or {}
                view = preset_view(full, parse_preset(entry) if isinstance(parse_preset(entry), dict) else {})
                refs = self.references({'modelRoles': view.get('modelRoles', {})}, psettings, pools)
                old_entry = (plain(old_standard).get('modelPresets') or {}).get(pname)
                old_record = presets.get(pname) or {}
                presets[pname] = {'settings': psettings,
                    'statuses': {r: v for r, v in prepared['statuses'].items() if r in refs},
                    'catalog': prepared.get('presetCatalog', self.frozen_catalog(models, refs)),
                    'previous': prepared.get('presetPrevious', {'entry': old_entry, 'settings': old_record.get('settings', default_settings()),
                        'statuses': old_record.get('statuses', {}), 'catalog': old_record.get('catalog', {})}),
                    'at': time.time()}
        elif not prepared.get('poolsOnly'):
            # An adopted file keeps its exact text; other saves (and an adoption that kept pool blocks) store the
            # patched logical profile.
            normal = prepared['text'] if prepared.get('text') is not None and not prepared.get('collapsed') else yaml_dump(prepared['normal'])
            records[name] = {**(prior or {}), 'normal': normal, 'settings': settings,
                'statuses': {r: v for r, v in prepared['statuses'].items() if r in references},
                'catalog': frozen_catalog, 'previous': previous, 'at': time.time()}
        vision = self.ui.get('visionRoles', ['vision'])
        def catalog_for(record):
            # Availability and capabilities are fixed when this mode is saved.
            # Saving another profile must not silently reselect its routes.
            out = dict(models)
            for raw, model in (record or {}).get('catalog', {}).items():
                if model is None:
                    out.pop(raw, None)
                else:
                    out[raw] = {**out.get(raw, {}), **model}
            return out
        projections = {}
        for n, overlay in normals.items():
            if n in frozen:
                continue
            full = compile_input(layered(overlay) if n == 'standard' else merge(layered(normals['standard']), overlay))
            record = records.get(n)
            projection = compile_profile(full, record['settings'] if record else default_settings(),
                catalog_for(record), (record or {}).get('statuses', {}), pools, vision)
            if projection['issues']:
                raise Problem('Неможливо зберегти робочий режим '+n+': '+projection['issues'][0]['message'], 422)
            projections[n] = projection
        compiled_base = projections['standard']['effective'] if 'standard' in projections else layered(normals['standard'])
        outputs = {}
        for n, overlay in normals.items():
            if n in frozen:
                continue
            desired = projections[n]['effective']
            output = copy.deepcopy(overlay)
            inherited = compile_input(layered(output) if n == 'standard' else merge(compiled_base, output))
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
            if n == 'standard':
                self.compile_presets(output, compile_input(layered(overlay)), presets, catalog_for, pools, vision)
            normal_text = records[n]['normal'] if n in records else (before_bytes[n].decode('utf-8') if before_bytes[n] is not None else '')
            if n in soft and n != name:
                normal_text = yaml_dump(overlay)  # Its logical version took the file's own edits (theme, ...) along.
            rendered = normal_text if plain(output) == plain(overlay) else yaml_dump(output)
            # An adopted file stays byte for byte when its logical profile writes the same data (F5).
            if n == name and prepared.get('text') is not None and plain(output) == plain(yaml_load(prepared['text'])):
                rendered = prepared['text']
            if n in soft and before_bytes[n] is not None:
                # A file edited outside the keys Mana Tape manages is written over its current text: the owner's
                # comments stay wherever their values do.
                try:
                    rendered = yaml_dump(onto(yaml_load(before_bytes[n].decode('utf-8')), output))
                except Exception:
                    pass
            rendered = self.kept_text(rendered, before_bytes[n], output)
            if plain(yaml_load(rendered) or {}) != plain(output):
                raise Problem('Перевірка YAML не пройдена', 422)
            if n in records or rendered != normal_text:
                records[n] = {**records.get(n, {}), 'normal': normal_text, 'settings': records.get(n, {}).get('settings', default_settings()), 'statuses': records.get(n, {}).get('statuses', {}), 'hash': digest(rendered.encode('utf-8')), 'written': rendered, 'views': projections[n]['views']}
            outputs[n] = rendered
        files = {}
        for n, text in outputs.items():
            if text.encode('utf-8') == before_bytes[n]:
                continue
            if before_bytes[n] is None and (n != name or not plain(yaml_load(text) or {})):
                # Never create a file this change did not target, nor an empty one (an absent Global stays absent).
                continue
            files[n] = {'before': before_bytes[n].decode('utf-8') if before_bytes[n] is not None else None, 'after': text}
            if before_bytes[n] is not None:
                files[n]['mode'] = self.path(n).stat().st_mode & 0o777
        if removed is not None:
            files[removed] = {'before': before_bytes[removed].decode('utf-8'), 'after': None, 'mode': self.path(removed).stat().st_mode & 0o777}
        for n, raw in before_bytes.items():
            if check and n not in frozen and read_or_none(self.path(n)) != raw:
                raise Problem('Файл змінився під час підготовки. Збереження скасовано.', 409)
        after = {**self.mode_state, 'profiles': records}
        if presets or 'presets' in self.mode_state:
            after['presets'] = presets
        if 'pools' in prepared and self.machine is None:
            after['pools'] = pools
        return {'files': files, 'after': after, 'pools': pools if 'pools' in prepared else None, 'outputs': outputs}

    @staticmethod
    def kept_text(rendered, before, output):
        """What to write for one file: its own bytes when its data does not change (formatting, comments and a
        missing final newline stay), else the rendered text, without a final newline the file did not have."""
        if before is None:
            return rendered
        try:
            old = before.decode('utf-8')
            if yaml_shared(before) == plain(output):
                return old
        except Exception:
            return rendered
        if old and not old.endswith('\n') and rendered.endswith('\n'):
            try:
                if plain(yaml_load(rendered[:-1]) or {}) == plain(output):
                    return rendered[:-1]
            except Exception:
                pass
        return rendered

    def compile_presets(self, output, scope_full, presets, catalog_for, pools, vision):
        """Native presets in the scope file get OMP routes: a FREE pool or a paused DeepSeek becomes its first usable
        CUT. Chains are the scope's own; a preset carries only primaries and the thinking level."""
        entries = output.get('modelPresets')
        if not isinstance(entries, dict):
            return
        for pname, entry in entries.items():
            parsed = parse_preset(plain(entry))
            if not isinstance(pname, str) or not PRESET_NAME.fullmatch(pname) or isinstance(parsed, str):
                continue  # Left exactly as written; OMP reports a malformed preset itself.
            record = presets.get(pname) or {}
            projection = compile_profile(preset_view(scope_full, parsed), record.get('settings') or default_settings(),
                catalog_for(record), record.get('statuses', {}), pools, vision)
            issues = [i for i in projection['issues'] if i['key'].startswith('role:') and i['key'][5:] in parsed['modelRoles']]
            if issues:
                raise Problem('Неможливо зберегти котушку OMP '+pname+': '+issues[0]['message'], 422)
            if pname in presets:
                presets[pname] = {**presets[pname], 'views': projection['views']}
            target = entry['modelRoles']
            for role in parsed['modelRoles']:
                value = projection['effective'].get('modelRoles', {}).get(role, parsed['modelRoles'][role])
                if target.get(role) != value:
                    target[role] = value

    def apply_plan(self, plan):
        """Backups, then the journaled write of one scope's files and metadata."""
        files = plan['files']
        backup_dir = self.backup_dir()
        atomic(backup_dir/(str(time.time_ns())+'-profile-modes.json'), json.dumps(self.mode_state, ensure_ascii=False).encode())
        for n, row in files.items():
            if row['before'] is None:
                continue
            backup = backup_dir/(str(time.time_ns())+'-'+self.path(n).name)
            atomic(backup, row['before'].encode('utf-8')); self.state['backups'][str(self.path(n))] = str(backup)
        self.transact(files, plan['after'])
        if plan.get('pools') is not None and self.machine is not None:
            self.machine.store_pools(plan['pools'])
        self.persist()

    # ---- layers: reset, promote, presets, migration ------------------------------------------------------------

    TRACKED_PATHS = ('modelRoles', 'retry.fallbackChains', 'task.agentModelOverrides')

    def scope_action(self, body):
        """/api/scope-action: reset to Global, promote to Global, configure a candidate project, rescan."""
        action = body.get('action')
        if action == 'reset':
            return self.reset_to_global(body)
        if action == 'promote':
            return self.promote_to_global(body)
        if self.installation is None:
            raise Problem('Ця дія потребує інсталяції з областями', 409)
        if action == 'configure':
            for machine in self.installation.machines.values():
                machine.writable()
            return self.installation.configure(body.get('candidate'))
        if action == 'rescan':
            self.installation.rescan(force=True)
            return {'ok': True, 'scopes': self.installation.menu(), 'candidates': self.installation.candidate_list()}
        raise Problem('Дія не підтримується')

    def tracked_path(self, keys):
        """A value path the panel may reset or promote: one role, one role chain, one agent, or the provider list."""
        if keys == ['disabledProviders']:
            return keys
        if isinstance(keys, list) and all(isinstance(k, str) and k for k in keys) and (
                (len(keys) == 2 and keys[0] == 'modelRoles') or (len(keys) == 3 and keys[:2] in (['retry', 'fallbackChains'], ['task', 'agentModelOverrides']))):
            return keys
        raise Problem('Цей шлях не можна скинути чи перенести')

    @staticmethod
    def get_path(data, keys):
        node = data
        for key in keys:
            if not isinstance(node, dict) or key not in node:
                return None, False
            node = node[key]
        return node, True

    @staticmethod
    def drop_path(data, keys):
        """Remove one value and the containers it leaves empty."""
        trail, node = [], data
        for key in keys[:-1]:
            if not isinstance(node.get(key), dict):
                return
            trail.append((node, key))
            node = node[key]
        node.pop(keys[-1], None)
        for parent, key in reversed(trail):
            if parent[key] == {}:
                del parent[key]

    def server_prepared(self, data, **extra):
        """A server-side logical change of the scope file, compiled exactly like a Save of Standard."""
        return {'name': 'standard', 'normal': data, 'settings': self.mode_settings('standard'),
            'statuses': route_statuses(self.mode_catalog(), self.managed), 'frozen': self.outside_edits('standard'), **extra}

    def logical_standard(self):
        base, _ = self.profiles()
        return copy.deepcopy(base)

    def scope_paths(self, body):
        paths = body.get('paths')
        if not isinstance(paths, list) or not 1 <= len(paths) <= 60:
            raise Problem('Вкажи значення, які треба змінити')
        return [self.tracked_path(keys) for keys in paths]

    def reset_to_global(self, body):
        """Remove project values so OMP reads them from the Global config again."""
        with self.lock:
            self.writable()
            if self.parent is None:
                raise Problem('Глобальна область не має батьківського рівня', 409)
            if body.get('revision') != self.revision('standard'):
                raise Problem('Проєкт змінився; онови дані', 409, 'revision')
            data = self.logical_standard()
            for keys in self.scope_paths(body):
                self.drop_path(data, keys)
            return self.commit_mode(self.server_prepared(data), body=body)

    def promote_to_global(self, body):
        """Move project values into the Global config (one journal for both files)."""
        if self.parent is None or self.machine is None:
            raise Problem('Перенести можна лише значення проєкту', 409)
        return self.machine.promote(self, body)

    def apply_preset(self, body):
        """OMP /modelpreset switch: the preset's role map replaces the stored roles; thinking goes to Global.

        With modelRoleStorage: project a project stores roles in its .omp/config.yml (missing roles fall back to
        Global); otherwise the Global config holds them. Chains, agents and providers stay as they are.
        """
        if self.machine is None:
            raise Problem('Застосування котушки OMP потребує інсталяції з областями', 409)
        return self.machine.apply_preset(self, body)

    def preset_entry(self, pname, scope=None):
        """(owning scope, logical entry) of a preset visible here; a project preset shadows a Global one."""
        for owner in filter(None, (self, self.parent) if scope is None else (scope,)):
            entry = owner.native_presets().get(pname)
            if entry is not None:
                return owner, entry
        raise Problem('Котушку OMP не знайдено', 404)

    def preset_action(self, action, name, body):
        """clone / rename / delete / restore for a native preset, as one compiled change of the scope file."""
        pname = name[len(PRESET_PREFIX):] if name.startswith(PRESET_PREFIX) else None
        data = self.logical_standard()
        records = copy.deepcopy(self.mode_state.get('presets', {}))
        entries = data.get('modelPresets') if isinstance(data.get('modelPresets'), dict) else None
        if action == 'clone':
            new = self.new_preset_name(body.get('name'), data)
            if pname is not None:
                _, entry = self.preset_entry(pname, self)
                roles, thinking, settings = copy.deepcopy(entry['modelRoles']), entry.get('defaultThinkingLevel'), self.preset_settings(pname)
            else:
                base, ps = self.profiles()
                if name not in ps:
                    self.read(self.path(name))
                full = self.layered(base) if name == 'standard' else merge(self.layered(base), ps[name])
                # OMP /modelpreset save keeps every role in effect, so applying the preset reproduces the profile.
                roles = {r: v for r, v in plain(full.get('modelRoles') or {}).items() if isinstance(v, str) and v}
                thinking, settings = None, self.mode_settings(name)
            if entries is None:
                data['modelPresets'] = entries = {}
            entries[new] = {'modelRoles': roles, **({'defaultThinkingLevel': thinking} if thinking else {})}
            records[new] = {'settings': settings}
            self.commit_mode(self.server_prepared(data, keepStandardMode=True, presetRecords=records), body=body)
            return {'ok': True, 'name': PRESET_PREFIX + new}
        if pname is None or entries is None or pname not in entries:
            raise Problem('Котушку OMP не знайдено', 404)
        if body.get('revision') != self.revision(name):
            raise Problem('Котушка змінилась; онови дані', 409, 'revision')
        if action == 'rename':
            new = self.new_preset_name(body.get('name'), data, allow=pname)
            if new == pname:
                return {'ok': True, 'name': name}
            items = list(entries.items())
            for key, _ in items:
                del entries[key]
            for key, value in items:
                entries[new if key == pname else key] = value
            if pname in records:
                records[new] = records.pop(pname)
            self.commit_mode(self.server_prepared(data, keepStandardMode=True, presetRecords=records), body=body)
            return {'ok': True, 'name': PRESET_PREFIX + new}
        if action == 'delete':
            atomic(self.backup_dir() / f'{time.time_ns()}-deleted-preset-{pname}.json',
                json.dumps({'entry': plain(entries[pname]), 'record': records.get(pname)}, ensure_ascii=False).encode())
            del entries[pname]
            records.pop(pname, None)
            if not entries:
                del data['modelPresets']
            self.commit_mode(self.server_prepared(data, keepStandardMode=True, presetRecords=records), body=body)
            return {'ok': True}
        if action == 'restore':
            previous = (records.get(pname) or {}).get('previous')
            if not previous or not isinstance(previous.get('entry'), dict):
                raise Problem('Ще немає попередньої версії котушки')
            # The version being replaced becomes the next Restore point (a second Restore returns to it).
            current = records.get(pname) or {}
            replaced = {'entry': plain(entries[pname]), 'settings': self.preset_settings(pname),
                'statuses': current.get('statuses', {}), 'catalog': current.get('catalog', {})}
            entries[pname] = copy.deepcopy(previous['entry'])
            prepared = self.server_prepared(data, preset=pname, presetSettings=previous.get('settings') or default_settings(),
                presetCatalog=previous.get('catalog', {}), presetPrevious=replaced)
            prepared['statuses'] = {**route_statuses(self.mode_catalog(), self.managed), **previous.get('statuses', {})}
            self.commit_mode(prepared, body=body)
            return {'ok': True}
        raise Problem('Дія не підтримується')

    def new_preset_name(self, value, data, allow=None):
        new = profile_name(value)
        if not PRESET_NAME.fullmatch(new):
            raise Problem('Назва котушки OMP починається з латинської літери: літери, цифри, дефіс або підкреслення.')
        taken = data.get('modelPresets') if isinstance(data.get('modelPresets'), dict) else {}
        if new in taken and new != allow:
            raise Problem('Котушка з такою назвою вже є', 409)
        return new

    def legacy_plan(self, name, target=None):
        """What a legacy `.omp/presets/<name>.yml` котушка becomes as a native OMP preset; nothing is written.

        Native presets carry the role map and defaultThinkingLevel only. Everything else the file changes is
        listed (`lost`); a role chain becomes a model-keyed fallback chain only where that is exact (`modelChains`).
        """
        if name == 'standard' or name.startswith(PRESET_PREFIX):
            raise Problem('Переносяться лише котушки з .omp/presets', 409)
        if not self.path(name).is_file():
            raise Problem('Старої котушки ' + name + ' уже немає (перенесено чи архівовано). Онови дані.', 404)
        base, ps = self.profiles(shared=True)
        files_base, files = self.native_profiles(shared=True)
        if name not in ps:
            self.read(self.path(name))  # Raises the precise YAML problem of this file.
            raise Problem('Профіль не знайдено', 404)
        scope_full, full = self.layered(base), merge(self.layered(base), ps[name])
        roles = {r: v for r, v in plain(full.get('modelRoles') or {}).items() if isinstance(v, str) and v}
        overlay = plain(ps[name])
        thinking = overlay.get('defaultThinkingLevel') if overlay.get('defaultThinkingLevel') in THINKING_LEVELS else None
        def rest(d):
            return {k: v for k, v in plain(d).items() if k not in ('modelRoles', 'defaultThinkingLevel', 'modelPresets')}
        # Compared as written: exactly what OMP ran with `--config` on this file over the scope file.
        written_scope, written_full = self.layered(files_base), merge(self.layered(files_base), files[name])
        lost = short_diff(rest(written_scope), rest(written_full), limit=12)
        chains = []
        scope_heads = {raw_route(v) for v in (written_scope.get('modelRoles') or {}).values() if isinstance(v, str)}
        for role, head in (written_full.get('modelRoles') or {}).items():
            wanted, standard = fallback_chain(written_full, role), fallback_chain(written_scope, role)
            if not isinstance(head, str) or wanted == standard:
                continue
            others = [r for r, v in (written_full.get('modelRoles') or {}).items() if r != role and isinstance(v, str) and raw_route(v) == raw_route(head)]
            exact = raw_route(head) not in scope_heads and not others and '/' in head
            chains.append({'role': role, 'selector': head, 'chain': list(wanted), 'exact': exact,
                'reason': '' if exact else 'основна модель ролі та сама, що в Standard або в іншій ролі'})
        target = target or (name if PRESET_NAME.fullmatch(name) else 'p-' + name)
        if not PRESET_NAME.fullmatch(target):
            raise Problem('Назва котушки OMP починається з латинської літери')
        plan = {'profile': name, 'preset': target, 'roles': roles, 'thinking': thinking,
            'carried': [f'modelRoles: {len(roles)} ролей'] + ([f'defaultThinkingLevel: {thinking}'] if thinking else []),
            'lost': lost, 'modelChains': chains,
            # What the котушка changes against Standard in roles and thinking: archiving drops that too.
            'roleChanges': short_diff({k: v for k, v in plain(written_scope).items() if k in ('modelRoles', 'defaultThinkingLevel')},
                {k: v for k, v in plain(written_full).items() if k in ('modelRoles', 'defaultThinkingLevel')}, limit=12),
            # As a native preset it would hold the very roles the scope already runs with: OMP would call it active.
            'sameAsStandard': plain(written_full.get('modelRoles') or {}) == plain(written_scope.get('modelRoles') or {}) and not thinking,
            'collision': target in self.native_presets(base), 'settings': self.mode_settings(name),
            # A project котушка of this name hides the Global one in this project (OMP: project shadows Global).
            'shadowsGlobal': self.parent is not None and target in self.parent.native_presets()}
        plan['token'] = fingerprint({**plan, 'revision': self.revision(name)})
        return plan

    def migration_extra(self, name):
        """What moving a legacy котушка also writes into the scope file beyond the котушка itself (see
        `extra_changes`): the plan shows it, and `migrate` needs its token as `confirm`."""
        if self.machine is None:
            return {'derived': {}, 'derivedToken': ''}
        try:
            prepared = self.server_prepared(self.logical_standard(), keepStandardMode=True, remove=name, frozen=self.outside_edits(name))
            extra = extra_changes([(self, self.plan_commit(prepared, check=False), self.drift_plan())])
        except Problem:
            extra = {}
        return {'derived': extra, 'derivedToken': fingerprint(extra) if extra else ''}

    def migrate_legacy(self, name, body):
        """Turn a legacy котушка into a native preset (or archive it). The file and its record go to backups first,
        then leave `.omp/presets` in the same journal as the scope file that takes the preset over."""
        plan = self.legacy_plan(name, body.get('name') or None)
        if body.get('token') != plan['token']:
            raise Problem('План перенесення змінився. Переглянь його ще раз.', 409, 'revision')
        mode = body.get('mode')
        if mode not in ('roles', 'model-chains', 'archive'):
            raise Problem('Обери спосіб: roles, model-chains або archive')
        if mode != 'archive' and plan['collision']:
            raise Problem('Котушка OMP з назвою ' + plan['preset'] + ' уже є. Обери іншу назву.', 409)
        unconverted = [c for c in plan['modelChains'] if mode != 'model-chains' or not c['exact']]
        if mode != 'archive' and (plan['lost'] or unconverted) and body.get('acceptLoss') is not True:
            raise Problem('Нативна котушка не переносить частину налаштувань (див. план). Підтверди перенесення без них.', 422, 'migration-loss')
        frozen = self.outside_edits(name)
        data = self.logical_standard()
        records = copy.deepcopy(self.mode_state.get('presets', {}))
        if mode != 'archive':
            if not isinstance(data.get('modelPresets'), dict):
                data['modelPresets'] = {}
            data['modelPresets'][plan['preset']] = {'modelRoles': copy.deepcopy(plan['roles']),
                **({'defaultThinkingLevel': plan['thinking']} if plan['thinking'] else {})}
            records[plan['preset']] = {'settings': plan['settings']}
            if mode == 'model-chains':
                pools = self.pools()
                for chain in plan['modelChains']:
                    if chain['exact']:
                        # A model-keyed chain is no role: nothing compiles it later, so it holds CUTS, never a pool block.
                        routes = [m for r in chain['chain'] for m in (pools.get(pool_name(r), []) if pool_name(r) is not None else [r])]
                        data.setdefault('retry', {}).setdefault('fallbackChains', {})[chain['selector']] = routes
        stamp = time.time_ns()
        atomic(self.backup_dir() / f'{stamp}-migrated-{name}.yml', self.path(name).read_bytes())
        record = self.mode_state['profiles'].get(name)
        if record is not None:
            atomic(self.backup_dir() / f'{stamp}-migrated-{name}-mode.json', json.dumps(record, ensure_ascii=False).encode())
        self.commit_mode(self.server_prepared(data, keepStandardMode=True, presetRecords=records, remove=name, frozen=frozen), body=body)
        return {'ok': True, 'name': PRESET_PREFIX + plan['preset'] if mode != 'archive' else 'standard', 'mode': mode}

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
            raise Problem('Профіль змінився; онови дані', 409, 'revision')
        if record is None or digest(raw) == record.get('hash'):
            return {'ok': True, 'revision': self.revision(name)}
        conflicts = self.mode_conflicts()
        if name != 'standard' and 'standard' in conflicts:
            raise Problem('Спочатку прийми файл Standard: від нього залежать інші профілі.', 409, 'mode-conflict', profiles=conflicts)
        prepared, _, _ = self.adoption(name, raw, conflicts)
        return self.commit_mode(prepared)

    def adoption(self, name, raw, conflicts):
        """What «Прийняти файл» commits (F5), plus the FREE pool blocks it keeps and the ones that become the file's
        own CUTS. The file is taken as written, so DeepSeek is ON; saved replacements stay for the next OFF. A pool
        block stays a block only where the file still holds its exact expansion, and only when the logical profile
        with the blocks compiles to this very file: the adoption never rewrites the adopted file.
        """
        written = self.read(self.path(name))
        settings = {**self.mode_settings(name), 'mode': 'deepseek'}
        statuses = route_statuses(self.mode_catalog(), self.managed)
        prepared = {'name': name, 'normal': written, 'text': raw.decode('utf-8'), 'settings': settings,
            'statuses': statuses, 'frozen': set(conflicts) - {name}}
        if name == 'standard' and self.mode_state.get('presets'):
            # Native presets in the adopted file are taken as written too: their DeepSeek mode is ON again.
            prepared['presetRecords'] = {p: {**r, 'settings': {**(r.get('settings') or default_settings()), 'mode': 'deepseek'}}
                for p, r in self.mode_state['presets'].items()}
        prepared, kept, lost = self.adoption_blocks(name, written, prepared)
        if name == 'standard':
            prepared = self.adopt_preset_tokens(prepared)
        return prepared, kept, lost

    def adopt_preset_tokens(self, prepared):
        """A preset primary that still is the first CUT of its former FREE pool stays that pool, when the logical file
        then compiles to the very bytes that were adopted."""
        record, pools = self.mode_state['profiles'].get('standard'), self.pools()
        if not record or not any(pools.values()):
            return prepared
        former = layer_presets(plain(yaml_load(record['normal'])))
        trial = copy.deepcopy(prepared['normal'])
        entries = trial.get('modelPresets') if isinstance(trial.get('modelPresets'), dict) else {}
        changed = False
        for pname, entry in former.items():
            current = entries.get(pname)
            if 'invalid' in entry or not isinstance(current, dict) or not isinstance(current.get('modelRoles'), dict):
                continue
            for role, value in entry['modelRoles'].items():
                members = pools.get(pool_name(value)) if pool_name(value) is not None else None
                if members and current['modelRoles'].get(role) == members[0]:
                    current['modelRoles'][role] = value
                    changed = True
        if not changed:
            return prepared
        candidate = {**prepared, 'normal': trial, 'collapsed': True}
        try:
            return candidate if 'standard' not in self.commit_mode(candidate, dry=True) else prepared
        except (Problem, ValueError, TypeError, KeyError):
            return prepared

    def adoption_blocks(self, name, written, prepared):
        """FREE pool blocks of the former logical chains that the adopted file still holds exactly (F5)."""
        record, pools = self.mode_state['profiles'].get(name), self.pools()
        if not record or not any(pools.values()):
            return prepared, [], []
        logical = yaml_load(record['normal'])
        inherited = {} if name == 'standard' else self.profiles()[0]
        _, kept_all, lost_all = collapse_pools(written, logical, pools, inherited)
        if not kept_all:
            return prepared, [], lost_all
        def exact(keys):
            # The logical profile with these blocks must write this very file again, byte for byte. Dependent
            # presets then compile from the same logical Standard as before the outside edit.
            trial = collapse_pools(written, logical, pools, inherited, keys)[0]
            try:
                return name not in self.commit_mode({**prepared, 'normal': trial, 'collapsed': True}, dry=True)
            except (Problem, ValueError, TypeError, KeyError):
                return False  # The plain adoption then reports the file's own problem.
        # Normally every block re-expands exactly; otherwise only the chains that do on their own keep theirs.
        # A chain can change without a block of its own (an @role head folds back, a spelled-out chain goes).
        before, after = chain_entries(plain(written)), chain_entries(plain(collapse_pools(written, logical, pools, inherited)[0]))
        keys = sorted({k['key'] for k in kept_all} | {k for k in set(before) | set(after) if before.get(k) != after.get(k)})
        if not exact(keys):
            keys = [key for key in keys if exact([key])]
            if keys and not exact(keys):
                keys = []
        if not keys:
            return prepared, [], lost_all + kept_all
        candidate, kept, _ = collapse_pools(written, logical, pools, inherited, keys)
        return {**prepared, 'normal': candidate, 'collapsed': True}, kept, lost_all + [k for k in kept_all if k['key'] not in keys]

    def adopt_plan(self, name):
        """The pool blocks an adoption keeps and loses, for its confirmation; nothing is written."""
        path = self.path(name)
        raw, record = read_or_none(path), self.mode_state['profiles'].get(name)
        if raw is None or record is None or digest(raw) == record.get('hash'):
            return {'kept': [], 'lost': []}
        _, kept, lost = self.adoption(name, raw, self.mode_conflicts())
        return {'kept': kept, 'lost': lost}

    def refs(self, base=None, ps=None):
        """Routes this scope uses: {raw route: {profile}}. Native котушки count as `preset:<name>` with their logical
        roles (FREE pool blocks expand), the routes their file entry holds and their DeepSeek replacements: expiry
        and provider deletion must never take away a provider only a котушка uses."""
        if ps is None:
            base, ps = self.profiles(shared=True)
        pools = self.pools()
        out = {}
        def add(name, entries):
            for r in (member for r in entries for member in (pools.get(pool_name(r), []) if pool_name(r) is not None else [r])):
                if isinstance(r, str) and '/' in r:
                    out.setdefault(raw_route(r), set()).add(name)
        def replacements(settings):
            return list(settings.get('alternatives', [])) + [v for values in (settings.get('overrides') or {}).values() for v in values]
        for name, overlay in ps.items():
            p = compile_input(merge(base, overlay))
            entries = list(p.get('modelRoles', {}).values())
            for a in p.get('retry', {}).get('fallbackChains', {}).values():
                entries += a
            for a in p.get('task', {}).get('agentModelOverrides', {}).values():
                entries += a if isinstance(a, list) else [a]
            add(name, entries + replacements(self.mode_state['profiles'].get(name, {}).get('settings', {})))
        try:
            written = layer_presets(plain(self.read(self.path('standard', read=True), shared=True)))
        except Problem:
            written = {}
        logical, records = layer_presets(plain(base)), self.mode_state.get('presets', {})
        for pname in set(written) | set(logical) | set(records):
            entries = [v for entry in (written.get(pname), logical.get(pname)) if entry and 'invalid' not in entry
                for v in entry['modelRoles'].values()]
            add(PRESET_PREFIX + pname, entries + replacements((records.get(pname) or {}).get('settings') or {}))
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
        full = self.layered(data) if name == 'standard' else merge(self.layered(base), data)
        workers = set(known_agents) | set(full.get('task', {}).get('agentModelOverrides', {}))
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
                # In a project scope removing a value is «reset to Global»: OMP then reads the Global config.
                if name == 'standard' and not builtin and self.parent is None:
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
            # One vision rule for direct CUTs and pools (compile_profile checks pools the same way).
            if model and role in self.ui.get('visionRoles', ['vision']) and 'image' not in model.get('input', []):
                raise Problem('Для доріжки зору '+role+' потрібен CUT, що читає зображення: '+raw_route(candidate), 422)
            if not BUILTIN_ROLES.get(role, {}).get('thinking', True) and EFFORT.search(candidate):
                raise Problem('Ця роль не використовує thinking: '+role, 422)

    def save_profile(self, body):
        if 'modeSettings' in body:
            return self.save_mode_profile(body)
        with self.lock:
            self.writable()
            if self.mode_state['profiles'] or self.mode_state.get('pools') or any(self.pools().values()):
                raise Problem('Онови Mana Tape перед збереженням профілю з режимами.', 409)
            name = body.get('profile')
            if isinstance(name, str) and name.startswith(PRESET_PREFIX):
                raise Problem('Котушка OMP зберігається разом із режимом: онови панель.', 409)
            path = self.path(name)
            if not path.exists() and not (name == 'standard' and self.optional_standard):
                raise Problem('Профіль не знайдено', 404)
            raw = read_or_none(path) or b''
            base_raw = raw if name == 'standard' else self.standard_bytes()
            if body.get('revision') != self.revision(name):
                raise Problem('Профіль або Standard уже змінився. Твоя чернетка збережена в цьому вікні. Онови дані перед повторним збереженням.', 409, 'revision')
            original_hash = digest(raw)
            data = yaml_load(raw.decode('utf-8'))
            base = yaml_load(base_raw.decode('utf-8'))
            roles = set(BUILTIN_ROLES) | set((self.layered(data) if name == 'standard' else merge(self.layered(base), data)).get('modelRoles', {}))
            changes = body.get('changes')
            if not isinstance(changes, list) or not 1 <= len(changes) <= 150:
                raise Problem('Немає змін або забагато змін')
            self.patch_profile(data, changes, roles, name, base)
            if name != 'standard' and self.standard_bytes() != base_raw:
                raise Problem('Standard змінився під час збереження', 409)
            self.replace_yaml(path, data, original_hash)
            return {'ok': True, 'revision': self.revision(name)}

    def profile_action(self, body):
        with self.lock:
            name, action = body.get('profile'), body.get('action')
            if action == 'apply-preset':
                return self.apply_preset(body)
            path = self.path(name)
            # Adopting a file is also how the owner accepts it after an interrupted transaction.
            if action == 'adopt-plan':
                return self.adopt_plan(name)
            if action == 'migrate-plan':
                return {**self.legacy_plan(name, body.get('name') or None), **self.migration_extra(name)}
            self.writable({name} if action == 'adopt' else ())
            if action == 'adopt':
                return self.adopt(name, body)
            if action == 'migrate':
                return self.migrate_legacy(name, body)
            if not path.is_file() and not (self.optional_standard and name == 'standard'):
                raise Problem('Профіль не знайдено', 404)
            if name.startswith(PRESET_PREFIX) or action == 'clone' and (self.machine is not None or self.mode_state.get('presets')):
                # Котушки are native OMP presets now: a copy of any profile becomes one in this scope's file.
                return self.preset_action(action, name, body)
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
                raise Problem('Профіль змінився; онови дані', 409, 'revision')
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
                    return self.commit_mode({'name': name, 'normal': yaml_load(previous['normal']), 'settings': previous['settings'], 'statuses': previous.get('statuses', {}), 'catalog': previous.get('catalog', {}), 'frozen': frozen}, body=body)
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
                    try:
                        found = con.execute('SELECT m.provider_id, m.updated_at, m.authoritative, m.models, r.payload_updated_at, r.updated_at, r.authoritative '
                            'FROM model_cache m LEFT JOIN model_cache_refresh r ON r.provider_id = m.provider_id').fetchall()
                    except sqlite3.OperationalError:  # An OMP without refresh records.
                        found = [(*row, None, None, None) for row in con.execute('SELECT provider_id, updated_at, authoritative, models FROM model_cache').fetchall()]
                    # A refresh that returns the same payload only updates its refresh record (OMP 18).
                    found = [(key, refreshed, refreshed_authority, raw) if refreshed is not None and payload == stamp and refreshed_authority is not None
                             else (key, stamp, authority, raw) for key, stamp, authority, raw, payload, refreshed, refreshed_authority in found]
                    for provider_key, stamp, authority, raw in sorted(found, key=lambda row: row[1]):
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
        if self.machine is not None and self.machine.journal.exists():
            return self.machine.recovery or {'error': RECOVERY + '.', 'files': []}
        if not self.mode_journal.exists():
            return None
        return self.recovery or {'error': RECOVERY + '.', 'files': []}

    def snapshot(self):
        with self.lock:
            base, ps = self.profiles(shared=True)
            cached, stamps = self.cached()
            # Per-request copies: decorating them must never leak UI fields into state.json.
            models = {r: dict(m) for r, m in self.verified_free_models({**cached, **self.cat['catalog']}).items()}
            refs = self.refs(base, ps)
            for r in refs:
                provider, mid = r.split('/', 1)
                models.setdefault(r, {'provider': provider, 'id': mid, 'name': mid, 'source': 'reference'})
            available = set(self.cat['available'])
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
            layers = self.layer_snapshot(base)
            native = {PRESET_PREFIX + n: e for n, e in self.native_presets(base).items()}
            preset_records = self.mode_state.get('presets', {})
            return {'source': str(self.project), 'projectId': self.project_id,
                'projects': self.installation.menu() if self.installation is not None else self.projects,
                'ui': self.ui, 'legacyDrafts': self.legacy_drafts, 'demo': self.demo, 'base': relevant(base),
                'builtinRoles': list(BUILTIN_ROLES.values()),
                'agents': list(agents.values()), 'agentWarnings': agent_warnings,
                'presets': {**{k: relevant(v) for k, v in ps.items() if k != 'standard'}, **{k: plain(e) for k, e in native.items()}},
                'profileWarnings': self.profile_warnings,
                'revisions': {**{k: self.revision(k) for k in ps}, **{k: self.revision(k) for k in native}},
                'freePools': self.pools(), 'poolsRevision': self.pools_revision(),
                'restorable': [k for k in ps if records.get(k, {}).get('previous') or k not in records and str(self.path(k, read=True)) in self.state['backups']]
                    + [k for k in native if (preset_records.get(k[len(PRESET_PREFIX):]) or {}).get('previous')],
                'profileModes': {**{k: {'settings': self.mode_settings(k), 'views': records.get(k, {}).get('views'), 'at': records.get(k, {}).get('at')} for k in ps},
                    **{k: {'settings': self.preset_settings(k[len(PRESET_PREFIX):]), 'views': (preset_records.get(k[len(PRESET_PREFIX):]) or {}).get('views'),
                        'at': (preset_records.get(k[len(PRESET_PREFIX):]) or {}).get('at')} for k in native}},
                **layers,
                'modeConflicts': self.mode_conflicts(), 'modeOrphans': self.mode_orphans(),
                'modeRecovery': self.recovery_status(), 'tariff': tariff_status(),
                'models': list(models.values()), 'providers': providers,
                'providerRevision': digest(models_yml if models_yml is not None else b''),
                'favs': self.state['favs'], 'changes': self.cat['changes'][-100:],
                'refresh': {'busy': self.lead.busy, 'at': self.cat['refreshed'], 'error': self.cat['error']},
                'insights': self.insights.snapshot(self), 'csrf': self.csrf}

    def layer_snapshot(self, base):
        """Scope, inheritance and native-preset fields of /api/state (see review/layers-spec.md)."""
        def relevant(data):
            return plain({k: data[k] for k in ('modelRoles', 'retry', 'task', 'disabledProviders') if k in data})
        parent = self.parent_data()
        own_file = plain(self.read(self.path('standard', read=True), shared=True))
        effective_file = layered_config(parent, own_file) if parent is not None else own_file
        visible = visible_presets(parent, own_file) if parent is not None else visible_presets(own_file)
        logical = self.native_presets(base)
        nonnative = [k for k in self.native_profiles(shared=True)[1] if k != 'standard']
        presets = {}
        for pname, entry in visible.items():
            own = parent is None or entry['source'] == 'project'
            presets[pname] = {'source': 'project' if parent is not None and own else 'global', 'own': own,
                'profile': PRESET_PREFIX + pname if own and pname in logical else None,
                'roles': entry.get('modelRoles'), 'thinking': entry.get('defaultThinkingLevel'),
                'invalid': entry.get('invalid'), 'shadows': bool(entry.get('shadows'))}
        registry = self.installation
        return {
            'scope': {'id': self.project_id, 'kind': self.kind, 'name': self.scope_name(), 'path': str(self.project),
                'parent': self.parent.project_id if self.parent is not None else None,
                'origin': self.origin_kind, 'storage': effective_file.get('modelRoleStorage', 'global'),
                'configExists': self.path('standard', read=True).is_file(), 'readOnly': self.read_only(),
                'globalReadOnly': self.parent.read_only() if self.parent is not None else None},
            # What OMP reads from the Global file (compiled routes) and what the Global scope holds logically (FREE
            # pool blocks, DeepSeek before its OFF replacement): «Перевизначити в проєкті» copies the logical value.
            'inherited': relevant(parent) if parent is not None else None,
            'inheritedLogical': relevant(self.parent.profiles(shared=True)[0]) if parent is not None else None,
            'sources': value_sources(parent, plain(base)) if parent is not None else value_sources(plain(base)),
            'nativePresets': presets, 'activePreset': active_preset(effective_file, visible),
            'legacyPresets': nonnative, 'modelChains': model_chain_keys(effective_file),
            'modeConflictDiffs': self.conflict_diffs(),
            'candidates': registry.candidate_list() if registry is not None else [],
            'poolScopes': self.machine.pool_scopes() if self.machine is not None else [],
            'poolConflict': [{'sources': row['sources'], 'pools': row['pools']} for row in self.machine.pool_conflict] if self.machine is not None else [],
        }

    def scope_name(self):
        for row in (self.installation.menu() if self.installation is not None else self.projects):
            if row.get('id') == self.project_id:
                return row.get('name', self.project_id)
        return self.project.name

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
        for peer in (self.machine.ordered() if self.machine is not None else self.agent_peers):
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
                raise Problem('Провайдери вже змінились. Онови дані.', 409, 'revision')
            data = self.registry()
            if not isinstance(data.get('providers'), dict):
                data['providers'] = {}
            providers = data['providers']
            exists = pid in providers
            # «+ Провайдер» only creates: an ID that is taken is refused, editing goes through «Підключення…».
            if body.get('mode') == 'create' and body.get('action') != 'delete' and (exists or pid in self.managed and not self.managed[pid].get('expired')):
                raise Problem('Цей ID уже має провайдер. Змінити його можна через «Підключення…».', 409, 'provider-exists')
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
                self.cat['available'] = [r for r in self.cat['available'] if not r.startswith(pid + '/')]
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
        if self.catalog_owner is not None:
            return self.catalog_owner.expire()  # Providers are per agent directory: the lead scope checks them.
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

    def installed_extensions(self):
        """Extension files the owner installed in `<agent>/extensions`, resolved, in name order.

        The same top-level files OMP itself discovers there (`*.js`, `*.ts`): a regular file, or a
        symlink placed there that resolves to one. Hidden names, directories and broken links are skipped.
        """
        try:
            entries = sorted(os.scandir(self.agent / 'extensions'), key=lambda entry: entry.name)
        except OSError:
            return []
        found = []
        for entry in entries:
            if entry.name.startswith('.') or not entry.name.endswith(EXTENSION_SUFFIXES):
                continue
            try:
                if not (entry.is_symlink() or entry.is_file(follow_symlinks=False)):
                    continue
                target = Path(entry.path).resolve(strict=True)
                if not target.is_file():
                    continue
            except (OSError, RuntimeError):
                continue
            if str(target) not in found:
                found.append(str(target))
        return found

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
        if self.catalog_owner is not None:
            return self.catalog_owner.refresh()  # One catalogue per agent directory, refreshed by the lead scope.
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
            # No prompt, no inference, no project extensions or active sessions touched. Discovery stays
            # off; the extensions installed in the agent directory load explicitly.
            command = [self.omp, 'models', 'refresh', '--kind', 'all', '--json', '--no-extensions']
            if not self.demo:
                for path in self.installed_extensions():
                    command += ['-e', path]
            run = subprocess.run(command,
                cwd=self.state_dir, env=self.native_env, capture_output=True, timeout=120)
            if run.returncode or b'models.yml validation failed' in run.stderr:
                raise Problem('OMP не оновив каталог. Попередні дані збережено.')
            # An extension that failed to load leaves the catalogue partial: it proves no absence.
            complete = b'Failed to load extension' not in run.stderr
            data = json.loads(run.stdout)
            native = data['models']
            if not isinstance(native, list):
                raise ValueError('models')
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
                listed = {r.split('/', 1)[0] for r in seen}
                def fresh(pid):
                    stamp = stamps[pid]
                    return (stamp['authoritative'] and stamp['at'] >= start - 2
                            and stamp['at'] > before_stamps.get(pid, {}).get('at', 0))
                # This run reached the providers: OMP refreshed some discovery authoritatively. Offline, it did not.
                online = any(fresh(pid) for pid in stamps)
                # Providers without OMP discovery or a public list (models.yml, an installed extension): a complete
                # online refresh that still lists the provider proves which routes it no longer has.
                proven = {pid for pid in listed if pid not in stamps and pid not in PUBLIC_MODEL_LISTS} if complete and online else set()
                candidates = set(prior)
                if proven:
                    # Earlier and configured routes too, so an absence missed before does not stay `present`.
                    try:
                        configured = set(self.registry_refs())
                    except Exception as error:
                        log_failure('refresh references', error)
                        configured = set()
                    configured |= {raw_route(r) for members in self.pools().values() for r in members}
                    candidates.update(r for r in set(old) | configured if r.split('/', 1)[0] in proven)
                for r in candidates - seen:
                    pid = r.split('/', 1)[0]
                    # Otherwise OMP's own discovery decides: absence counts only after its fresh authoritative fetch.
                    if pid in proven or (pid in stamps and pid in listed and fresh(pid)):
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
        if self.catalog_owner is not None:
            return self.catalog_owner.maintain_once()
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


def extra_changes(steps, own=None):
    """What a write changes beyond what the owner asked for, per file: {label: {scope, file, lines}}.

    `steps` are (scope, plan, drift); `drift` is that scope's unchanged recompile (`Forge.drift_plan`). A key the
    write changes exactly as the unchanged recompile would is not the action's doing: an override for a Global role
    that DeepSeek OFF reaches now, a FREE pool or catalogue change since the last save (M1). `own(scope, profile,
    key)` names the keys an action targets; every other key it changes is extra too (apply: only role models and
    the thinking level are OMP's /modelpreset switch).
    """
    out = {}
    for scope, plan, drift in steps:
        for name, row in plan['files'].items():
            if row['after'] is None:
                continue  # A migrated legacy file leaves: that is the action itself.
            try:
                before, after = yaml_shared(row['before'] or ''), yaml_shared(row['after'])
            except Exception:
                continue
            changed = changed_keys(before, after)
            extra = {k for k in changed if not own(scope, name, k)} if own is not None else set()
            drifted = (drift or {}).get('files', {}).get(name)
            if drifted and drifted['after'] is not None:
                try:
                    baseline = changed_keys(before, yaml_shared(drifted['after']))
                except Exception:
                    baseline = {}
                extra |= {k for k, v in baseline.items() if k in changed and changed[k] == v}
            if extra:
                out[scope.project_id + '/' + name] = {'scope': scope.project_id, 'file': scope.file_label(scope.path(name, read=True)),
                    'lines': short_diff(before, after, limit=8, keys=extra)}
    return out


def file_preview(steps):
    """Every file a write changes, at most eight human lines each: what a confirmation drawer shows."""
    out = {}
    for scope, plan, *_ in steps:
        for name, row in plan['files'].items():
            label = scope.file_label(scope.path(name, read=True))
            if row['after'] is None:
                out[scope.project_id + '/' + name] = {'scope': scope.project_id, 'file': label, 'lines': ['− файл (у резервних копіях)']}
                continue
            try:
                lines = short_diff(yaml_shared(row['before'] or ''), yaml_shared(row['after']), limit=8)
            except Exception:
                lines = ['файл зміниться']
            out[scope.project_id + '/' + name] = {'scope': scope.project_id, 'file': label, 'lines': lines or ['лише форматування']}
    return out


def confirm_extra(body, extra):
    """Refuse a write with unrequested changes unless the owner confirmed exactly these (409 `derived`)."""
    token = fingerprint(extra) if extra else ''
    if extra and body.get('confirm') != token:
        where = '; '.join(f"{row['file']}: " + ', '.join(row['lines'][:3]) + (' …' if len(row['lines']) > 3 else '') for row in extra.values())
        raise Problem('Окрім цієї дії запис змінить ще й це (перекомпіляція проти поточного глобального файлу, каталогу чи '
            'пулів): ' + where + '. Переглянь і підтверди, щоб записати й це.', 409, 'derived', derived=extra, token=token)
    return token


class Machine:
    """What the OMP scopes of one agent directory share: the write lock, FREE pools and a cross-scope journal.

    FREE pools are machine-wide: every scope (Global and projects) and every profile uses the same two pools.
    A pool save rewrites every scope that uses them in one journal; so do promote and apply-preset.
    """
    def __init__(self, agent, state_root):
        self.agent = Path(agent)
        self.dir = Path(state_root) / 'registries' / digest(str(agent).encode())[:16]
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.pools_file = self.dir / 'pools.json'
        self.journal = self.dir / 'transaction.json'
        self.scopes = {}
        self.global_scope = None
        self.recovery = None
        self.pool_conflict = []
        self.provider_store = None
        # The scope that runs the catalogue refresh, provider expiry and telemetry for the whole agent directory.
        self.lead = None
        self.pool_data = json.loads(self.pools_file.read_text(encoding='utf-8')) if self.pools_file.exists() else None

    def pools(self):
        pools = (self.pool_data or {}).get('pools') or {}
        return {name: list(pools.get(name, [])) for name in POOL_NAMES}

    def pool_record(self, pools, sources=None):
        return {'version': 1, 'pools': copy.deepcopy(pools), 'at': time.time(),
            **({'migratedFrom': sources} if sources else {'migratedFrom': (self.pool_data or {}).get('migratedFrom', [])})}

    def store_pools(self, pools, sources=None):
        record = self.pool_record(pools, sources)
        atomic(self.pools_file, json.dumps(record, ensure_ascii=False).encode())
        self.pool_data = record

    def migrate_pools(self, sources):
        """First start with machine-wide pools: one distinct legacy pool set is adopted; several wait for the owner.

        Legacy per-project pools stay where they were (read-only), so this is repeatable and loses nothing.
        """
        if self.pools_file.exists():
            return
        distinct = []
        for label, pools in sources:
            if not isinstance(pools, dict) or not any(pools.get(n) for n in POOL_NAMES):
                continue
            pools = {n: list(pools.get(n) or []) for n in POOL_NAMES}
            for row in distinct:
                if row['pools'] == pools:
                    row['sources'].append(label)
                    break
            else:
                distinct.append({'sources': [label], 'pools': pools})
        if len(distinct) > 1:
            self.pool_conflict = distinct
            return
        self.store_pools(distinct[0]['pools'] if distinct else {n: [] for n in POOL_NAMES}, distinct[0]['sources'] if distinct else [])

    def pool_scopes(self):
        return sorted(scope.project_id for scope in self.scopes.values() if scope.uses_pools())

    def recovery_failed(self, error):
        log_failure('cross-scope recovery', error)
        if isinstance(error, Problem):
            self.recovery = {'error': str(error), 'files': error.details.get('files', [])}
        else:
            self.recovery = {'error': RECOVERY + ': файли не вдалося повернути. Перевір місце на диску й права доступу.', 'files': []}

    def writable(self, accept=()):
        if not self.journal.exists():
            self.recovery = None
            return
        try:
            self.recover(accept)
        except Exception as error:
            self.recovery_failed(error)
            raise Problem(self.recovery['error'], 409 if isinstance(error, Problem) else 503,
                'mode-recovery', files=self.recovery['files']) from error

    def recover(self, accept=()):
        """Finish or roll back an interrupted cross-scope write; never overwrite a file changed meanwhile."""
        if not self.journal.exists():
            return
        journal = json.loads(self.journal.read_text(encoding='utf-8'))
        files, states = journal['files'], journal['states']
        def encoded(text):
            return None if text is None else text.encode('utf-8')
        def current(path):
            p = Path(path)
            return OUTSIDE if p.is_symlink() else read_or_none(p)
        if all(current(p) == encoded(row['after']) for p, row in files.items()):
            for path, row in states.items():
                if read_or_none(Path(path)) != encoded(row['after']):
                    atomic(Path(path), encoded(row['after']))
        else:
            for path, row in files.items():
                now, before = current(path), encoded(row['before'])
                if now == before or now != encoded(row['after']):
                    continue
                target = Path(path)
                if before is None:
                    target.unlink()
                    fsync_dir(target.parent)
                else:
                    atomic(target, before, row.get('mode') or 0o600)
            outside = [p for p, row in files.items() if current(p) != encoded(row['before'])]
            if set(outside) - set(accept):
                labels = sorted(files[p].get('label', p) for p in outside)
                raise Problem(RECOVERY + ': ' + ', '.join(labels) + ' змінено поза Mana Tape під час запису. '
                    'Інші файли повернуто. Перевір ці файли й прийми їх як є.', 409, 'mode-recovery', files=labels)
            if outside:
                atomic(self.dir / f'{time.time_ns()}-transaction.json', self.journal.read_bytes())
            for path, row in states.items():
                if row['before'] is None:
                    Path(path).unlink(missing_ok=True)
                else:
                    atomic(Path(path), encoded(row['before']))
        for scope in self.scopes.values():
            if str(scope.mode_file) in states:
                scope.mode_state = json.loads(scope.mode_file.read_text(encoding='utf-8')) if scope.mode_file.exists() else {'profiles': {}}
        if str(self.pools_file) in states:
            self.pool_data = json.loads(self.pools_file.read_text(encoding='utf-8')) if self.pools_file.exists() else None
        self.journal.unlink()
        fsync_dir(self.dir)
        self.recovery = None

    def transact(self, steps, pools=None, sources=None):
        """Journal, backups, native files of every scope, their metadata, the pools; then drop the journal."""
        if self.journal.exists():
            raise Problem(RECOVERY + '.', 409, 'mode-recovery')
        files, states = {}, {}
        for scope, plan in steps:
            for name, row in plan['files'].items():
                files[str(scope.path(name))] = {**row, 'label': scope.project_id + '/' + name}
            states[str(scope.mode_file)] = {'before': scope.mode_file.read_text(encoding='utf-8') if scope.mode_file.exists() else None,
                'after': json.dumps(plan['after'], ensure_ascii=False)}
        if pools is not None:
            raw = read_or_none(self.pools_file)
            states[str(self.pools_file)] = {'before': raw.decode('utf-8') if raw is not None else None,
                'after': json.dumps(self.pool_record(pools, sources), ensure_ascii=False)}
        for scope, plan in steps:
            backup_dir = scope.backup_dir()
            atomic(backup_dir/(str(time.time_ns())+'-profile-modes.json'), json.dumps(scope.mode_state, ensure_ascii=False).encode())
            for name, row in plan['files'].items():
                if row['before'] is not None:
                    backup = backup_dir/(str(time.time_ns())+'-'+scope.path(name).name)
                    atomic(backup, row['before'].encode('utf-8'))
                    scope.state['backups'][str(scope.path(name))] = str(backup)
        atomic(self.journal, json.dumps({'files': files, 'states': states}, ensure_ascii=False).encode())
        try:
            for path, row in files.items():
                target = Path(path)
                if target.is_symlink() or read_or_none(target) != (None if row['before'] is None else row['before'].encode('utf-8')):
                    raise Problem('Зовнішня зміна під час запису', 409)
                if row['after'] is None:
                    target.unlink()
                    fsync_dir(target.parent)
                elif row['before'] is None:
                    create_new(target, row['after'].encode('utf-8'), row.get('mode') or 0o600)
                else:
                    atomic(target, row['after'].encode('utf-8'), row.get('mode') or 0o600)
            for path, row in states.items():
                atomic(Path(path), row['after'].encode('utf-8'))
        except Exception:
            try:
                self.recover()
            except Exception as error:
                self.recovery_failed(error)
            raise
        for scope, plan in steps:
            scope.mode_state = plan['after']
        if pools is not None:
            self.pool_data = json.loads(states[str(self.pools_file)]['after'])
        self.journal.unlink()
        fsync_dir(self.dir)
        for scope, _ in steps:
            scope.persist()

    def ordered(self):
        rest = [s for s in self.scopes.values() if s is not self.global_scope]
        return ([self.global_scope] if self.global_scope is not None else []) + rest

    def save_pools(self, origin, body):
        """One pools editor for every scope: each scope and profile using a pool is recompiled in one journal.

        A scope whose file was changed outside Mana Tape blocks the save when its Standard is affected; other
        changed profiles stay byte for byte as they are (frozen), as in a single scope. Adopting one of several
        legacy pool sets is the same save: every scope compiled from another set is rewritten with the chosen one.
        """
        with self.lock:
            for scope in self.ordered():
                scope.writable()
            adopting = body.get('action') == 'adopt-legacy'
            if adopting:
                choice = next((row for row in self.pool_conflict if body.get('source') in row['sources']), None)
                if choice is None:
                    raise Problem('Немає такого джерела старих пулів', 404)
                pools = copy.deepcopy(choice['pools'])
            else:
                if self.pool_conflict:
                    raise Problem('Старі пули проєктів різняться. Спершу обери, які пули стануть спільними.', 409, 'pools-conflict')
                if body.get('revision') != origin.pools_revision():
                    raise Problem('Спільні пули вже змінилися. Чернетка пулів лишилась у вікні; «Скинути» завантажить збережені.', 409, 'revision')
                try:
                    pools = validate_pools(body.get('pools'), origin.mode_catalog())
                except ValueError as e:
                    raise Problem(str(e), 422) from e
            steps, blocked, diffs, parent_after = [], {}, {}, None
            for scope in self.ordered():
                if not scope.uses_pools():
                    continue
                conflicts = set(scope.mode_conflicts())
                if 'standard' in conflicts:
                    blocked[scope.project_id] = sorted(conflicts)
                    diffs[scope.project_id] = scope.conflict_diffs(['standard'])
                    continue
                base, _ = scope.profiles()
                parent = parent_after if scope.parent is not None and scope.parent is self.global_scope else None
                plan = scope.plan_commit({'name': 'standard', 'normal': base, 'pools': pools, 'poolsOnly': True, 'frozen': conflicts}, parent=parent)
                # While legacy sets conflict nothing compiles against the empty shared pools: no baseline then.
                steps.append((scope, plan, None if adopting else scope.drift_plan()))
                if scope is self.global_scope and 'standard' in plan['files']:
                    parent_after = plain(yaml_load(plan['files']['standard']['after']) or {})
            if blocked:
                names = ', '.join(f"{self.scopes[k].scope_title()} ({diffs[k]['standard']['file']})" for k in blocked)
                raise Problem('Файл змінено поза Mana Tape: ' + names + '. Пули не збережено, щоб не затерти ці зміни. '
                    'Прийми файл у цій області.', 409, 'mode-conflict',
                    profiles=sorted(f'{k}/{n}' for k, names in blocked.items() for n in names), scopes=blocked, diffs=diffs)
            if not adopting:
                confirm_extra(body, extra_changes(steps))
            self.transact([(scope, plan) for scope, plan, _ in steps], pools, choice['sources'] if adopting else None)
            if adopting:
                self.pool_conflict = []
            return {'ok': True, 'revision': origin.pools_revision(), 'scopes': [scope.project_id for scope, plan, _ in steps if plan['files']]}

    def promote(self, project, body):
        """Move project values into Global: set them in the Global file, remove them from the project, one journal.
        `dry` previews every file it would change."""
        with self.lock:
            glob = project.parent
            project.writable()
            glob.writable()
            if body.get('revision') != project.revision('standard'):
                raise Problem('Проєкт або глобальні налаштування змінились; онови дані', 409, 'revision')
            paths = project.scope_paths(body)
            project_data, global_data = project.logical_standard(), glob.logical_standard()
            for keys in paths:
                value, found = project.get_path(project_data, keys)
                if not found:
                    raise Problem('У проєкті немає власного значення ' + '.'.join(keys), 422)
                node = global_data
                for key in keys[:-1]:
                    if not isinstance(node.get(key), dict):
                        node[key] = {}
                    node = node[key]
                node[keys[-1]] = copy.deepcopy(value)
                project.drop_path(project_data, keys)
            global_plan = glob.plan_commit(glob.server_prepared(global_data))
            after = global_plan['files'].get('standard', {}).get('after')
            parent = plain(yaml_load(after) or {}) if after is not None else None
            project_plan = project.plan_commit(project.server_prepared(project_data), parent=parent)
            steps = [(glob, global_plan, glob.drift_plan()), (project, project_plan, project.drift_plan())]
            extra = extra_changes(steps)
            if body.get('dry'):
                return {'ok': True, 'dry': True, 'files': file_preview(steps), 'derived': extra, 'token': fingerprint(extra) if extra else ''}
            confirm_extra(body, extra)
            self.transact([(glob, global_plan), (project, project_plan)])
            return {'ok': True, 'revision': project.revision('standard')}

    def apply_preset(self, scope, body):
        """OMP `/modelpreset switch <name>`, nothing more (config/model-presets.ts).

        The котушка's role models as its file entry holds them (what OMP reads: a FREE pool already its first CUT, a
        DeepSeek OFF котушка already its replacement) replace the role map of the layer `modelRoleStorage` names:
        the project file (project storage, in a project) or the Global file. Its thinking level goes to the Global
        file. Chains, agents and providers are not the котушка's: anything else a write would change needs the
        owner's confirmation (`derived`). A target scope in DeepSeek OFF would replace a paid DeepSeek role of the
        котушка at once, so that is refused (`deepseek-mode`) instead of writing something else. `dry` previews.
        """
        with self.lock:
            scope.writable()
            glob = scope if scope.parent is None else scope.parent
            if glob is not scope:
                glob.writable()
            if body.get('revision') != scope.revision('standard'):
                raise Problem('Область змінилась; онови дані', 409, 'revision')
            pname = body.get('preset')
            if not isinstance(pname, str) or not PRESET_NAME.fullmatch(pname):
                raise Problem('Некоректна назва котушки OMP')
            owner, _ = scope.preset_entry(pname)
            written = layer_presets(plain(owner.read(owner.path('standard', read=True), shared=True))).get(pname)
            if not written or 'invalid' in written:
                raise Problem('Запис котушки OMP ' + pname + ' у файлі некоректний; OMP її не застосує.', 422)
            roles, thinking = dict(written['modelRoles']), written.get('defaultThinkingLevel')
            own_file = plain(scope.read(scope.path('standard', read=True), shared=True))
            storage = scope.layered(own_file).get('modelRoleStorage', 'global')
            target = scope if scope.parent is not None and storage == 'project' else glob
            if target.mode_settings('standard')['mode'] == 'no-deepseek':
                models = target.mode_catalog()
                paid = sorted(r for r, v in roles.items() if is_deepseek(v, models))
                if paid:
                    raise Problem(f'Котушка {pname} запускає платний DeepSeek ({", ".join(paid)}), а {target.scope_title(lower=True)} '
                        'у режимі DeepSeek OFF: її Standard одразу замінив би ці ролі, і OMP не отримав би котушку. Перемкни котушку '
                        'в OFF (тоді вона запише свої заміни) або область — в ON, і застосуй ще раз.', 409, 'deepseek-mode',
                        roles=paid, scope=target.project_id)
            data = target.logical_standard()
            current = data.get('modelRoles')
            if not isinstance(current, dict):
                data['modelRoles'] = current = {}
            for role in [r for r in current if r not in roles]:
                del current[role]
            for role, value in roles.items():
                current[role] = value
            steps, parent_after = [], None
            if thinking:
                global_data = data if target is glob else glob.logical_standard()
                global_data['defaultThinkingLevel'] = thinking
                if target is not glob:
                    plan = glob.plan_commit(glob.server_prepared(global_data))
                    steps.append((glob, plan, glob.drift_plan()))
                    after = plan['files'].get('standard', {}).get('after')
                    parent_after = plain(yaml_load(after) or {}) if after is not None else None
            plan = target.plan_commit(target.server_prepared(data), parent=parent_after if target is not glob else None)
            steps.append((target, plan, target.drift_plan()))
            # The file OMP will read must hold exactly the котушка's roles (and thinking): never «ok» without them. The
            # one addition: a project in DeepSeek OFF keeps replacing a paid DeepSeek role it inherits from Global and
            # the котушка does not name (OMP would show that Global role through; OFF replaces it, as on every save).
            result = yaml_shared(plan['outputs']['standard'])
            got = {r: role_selector(v) for r, v in ((result.get('modelRoles') or {}) if isinstance(result, dict) else {}).items() if role_selector(v)}
            inherited = ((target.parent_data() or {}).get('modelRoles') or {}) if target is not glob else {}
            wrong = sorted(r for r in set(got) | set(roles) if got.get(r) != roles.get(r) and not (r not in roles and r in inherited))
            if wrong:
                raise Problem('Застосування не дало б ролей котушки ' + pname + ': ' + ', '.join(wrong) + '. Нічого не записано.', 409, 'apply-mismatch')
            def own(where, name, key):
                return name == 'standard' and ((where is target and (key == 'modelRoles' or key.startswith('modelRoles.')))
                    or (where is glob and key == 'defaultThinkingLevel'))
            extra = extra_changes(steps, own)
            # OMP reports roles a higher layer still sets ("still set elsewhere"); with project storage the Global
            # roles the котушка does not name keep showing through.
            layer = project_layer(own_file).get('modelRoles') or {} if scope is not glob else {}
            shadowed = sorted(r for r, v in layer.items() if target is glob and role_selector(v) != roles.get(r))
            parent_roles = (scope.parent_data() or {}).get('modelRoles') or {} if target is scope and scope is not glob else {}
            from_global = sorted(r for r, v in parent_roles.items() if role_selector(v) and r not in roles)
            result = {'ok': True, 'target': target.project_id, 'shadowed': shadowed, 'fromGlobal': from_global}
            if body.get('dry'):
                return {**result, 'dry': True, 'files': file_preview(steps), 'derived': extra, 'token': fingerprint(extra) if extra else ''}
            confirm_extra(body, extra)
            writes = [(where, plan) for where, plan, _ in steps if plan['files']]
            if writes:
                self.transact(writes)
            return {**result, 'unchanged': not writes, 'revision': scope.revision('standard')}


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


def pinned_shell(raw, project=''):
    """index.html with every local asset URL pinned to its current content (`?v=<sha256 prefix>`).

    Such a URL can be cached as immutable: new content always gets a new URL,
    without anyone remembering to bump a version by hand. A `?project=` page preloads
    that project's state: the same URL the panel fetches first.
    """
    def pin(match):
        asset = (STATIC / match[2].lstrip('/')).resolve()
        if not asset.is_relative_to(STATIC) or not asset.is_file():
            return match[0]
        return f'{match[1]}{match[2]}?v={asset_version(asset.read_bytes())}"'
    text = SHELL_ASSET.sub(pin, raw.decode('utf-8'))
    if project:
        text = text.replace('href="/api/state"', 'href="/api/state?project=' + html.escape(quote(project, safe=''), quote=True) + '"', 1)
    return text.encode('utf-8')


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
        registry = getattr(self.server, 'registry', None)
        values = parse_qs(urlsplit(self.path).query).get('project', [self.server.app.project_id])
        app = (registry.resolve(values[0]) if registry is not None else apps.get(values[0])) if len(values) == 1 else None
        if app is None:
            raise Problem('Проєкт не знайдено', 404)
        return app

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
                registry = getattr(self.server, 'registry', None)
                if registry is not None:
                    registry.rescan()
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
                raw = pinned_shell(raw, parse_qs(parts.query).get('project', [''])[0])
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
            elif path == '/api/scope-action':
                result = app.scope_action(body)
            elif path == '/api/provider':
                result = app.provider_save(body)
                app.refresh_async()
            elif path == '/api/refresh':
                if time.time() - app.cat['attempted'] < 20:
                    raise Problem('Оновлення вже виконано. Зачекай кілька секунд.', 429)
                app.refresh_async()
                threading.Thread(target=app.insights.update, kwargs={'force': True}, daemon=True).start()
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


PROJECT_CONFIG_HEADER = ('# OMP project settings. Created by Mana Tape on request.\n'
    '# Keys here override the Global config (<agent>/config.yml) for OMP sessions started in this directory.\n')


class Registry:
    """Every scope of one installation, kept live.

    One Global scope per OMP agent directory (always present), projects listed in installation.yml, and
    projects OMP has run in (session history) or that live under `projectRoots`. Directories without
    `.omp/config.yml` are candidates: they become scopes only through an explicit «configure» request, by the
    server-side candidate id. HTTP clients never send paths.
    """
    RESCAN = 60

    def __init__(self, cfg, config_dir, state_root, omp):
        self.cfg, self.config_dir, self.state_root, self.omp = cfg, config_dir, state_root, omp
        self.apps, self.aliases, self.machines, self.candidates, self.rows = {}, {}, {}, {}, {}
        self.lock = threading.RLock()
        self.scanned, self.on_add, self.csrf, self.local_token = 0.0, None, None, None
        self.default_agent = None
        self.global_ui = cfg.get('ui') if isinstance(cfg.get('ui'), dict) else {}
        self.global_ids, self.global_names = {}, {}
        roots = cfg.get('projectRoots') or []
        if not isinstance(roots, list):
            raise ValueError('projectRoots: список каталогів')
        self.roots = [self.location(r) for r in roots]
        self.discovering = cfg.get('discover', True) is not False
        self.index_file = state_root / 'scopes.json'
        self.index = json.loads(self.index_file.read_text(encoding='utf-8')) if self.index_file.exists() else {'version': 1, 'scopes': {}}
        self.index_dirty = not self.index_file.exists()

    def location(self, value):
        path = Path(os.path.expandvars(str(value))).expanduser()
        return (self.config_dir / path).resolve() if not path.is_absolute() else path.resolve()

    def machine(self, agent):
        if agent not in self.machines:
            self.machines[agent] = Machine(agent, self.state_root)
        return self.machines[agent]

    def taken(self):
        return set(self.apps) | set(self.candidates) | {row['id'] for row in self.index['scopes'].values()}

    def claim(self, path, wanted=None, state=None):
        """(id, state dir) of a scope: explicit settings win, then the index, then an automatic key."""
        key = str(path)
        row = self.index['scopes'].get(key)
        if wanted is None and row is not None:
            return row['id'], Path(row['state'])
        pid = wanted or scope_id(path, self.taken())
        state = Path(state) if state else (Path(row['state']) if row and row['id'] == pid else self.state_root / pid)
        if row != {'id': pid, 'state': str(state)}:
            self.index['scopes'][key] = {'id': pid, 'state': str(state)}
            self.index_dirty = True
        return pid, state

    def legacy_dirs(self):
        """Map state directories of older installations to their projects through their backup paths."""
        try:
            dirs = sorted(d for d in self.state_root.iterdir() if d.is_dir() and (d / 'state.json').is_file())
        except OSError:
            return
        known = {row['state'] for row in self.index['scopes'].values()}
        for folder in dirs:
            if str(folder) in known:
                continue
            try:
                backups = json.loads((folder / 'state.json').read_text(encoding='utf-8')).get('backups') or {}
            except (OSError, ValueError, AttributeError):
                continue
            projects = {legacy_project(k) for k in backups} - {None}
            if len(projects) != 1:
                continue
            path = next(iter(projects)).resolve()
            if str(path) in self.index['scopes']:
                continue
            pid = folder.name if ID.fullmatch(folder.name) and folder.name not in self.taken() else scope_id(path, self.taken())
            self.index['scopes'][str(path)] = {'id': pid, 'state': str(folder), 'legacy': True}
            self.index_dirty = True

    def add(self, forge, name, origin):
        machine = forge.machine
        forge.installation, forge.origin_kind, forge.lock = self, origin, machine.lock
        if self.csrf is None:
            self.csrf, self.local_token = forge.csrf, forge.local_token
        forge.csrf, forge.local_token = self.csrf, self.local_token
        atomic(forge.state_dir / 'local-token', self.local_token.encode())
        if machine.provider_store is not None:
            forge.provider_store = machine.provider_store
        machine.scopes[forge.project_id] = forge
        self.share(forge)
        self.apps[forge.project_id] = forge
        self.rows[forge.project_id] = {'id': forge.project_id, 'name': name, 'kind': forge.kind, 'path': str(forge.project),
            'parent': forge.parent.project_id if forge.parent is not None else None, 'origin': origin}
        if self.on_add is not None:
            self.on_add(forge)
        return forge

    @staticmethod
    def share(forge):
        """A scope added to an agent directory that already has a lead uses the lead's catalogue and telemetry: one
        `omp models refresh`, one `omp usage` and one expiry check per agent directory, however many projects."""
        lead = forge.machine.lead
        if lead is not None and lead is not forge:
            forge.catalog_owner, forge.insights = lead, lead.insights

    def make_global(self, agent, entry=None):
        machine = self.machine(agent)
        if machine.global_scope is not None:
            return machine.global_scope
        if entry is not None:
            pid, state = self.claim(agent, entry['id'], self.location(entry['state']) if entry.get('state') else None)
        else:
            row = self.index['scopes'].get(str(agent))
            pid = row['id'] if row else ('global' if 'global' not in self.taken() else 'global-' + digest(str(agent).encode())[:6])
            pid, state = self.claim(agent, pid, row['state'] if row else None)
        forge = Forge(agent, agent, state, self.omp, self.cfg.get('origin', ''), self.cfg.get('owner', ''), self.cfg.get('demo', False),
            omp_dir=agent, machine=machine)
        forge.project_id = pid
        forge.ui = omp_merge(self.global_ui, (entry or {}).get('ui') or {})
        forge.legacy_drafts = bool((entry or {}).get('legacyDrafts', False))
        machine.global_scope = forge
        if pid != 'global' and 'global' not in self.aliases and agent == self.default_agent:
            self.aliases['global'] = pid
        return self.add(forge, str((entry or {}).get('name') or 'Global · OMP'), 'explicit' if entry else 'global')

    def make_project(self, path, agent, entry=None, origin='explicit', wanted=None):
        machine = self.machine(agent)
        glob = self.make_global(agent)
        if entry is not None:
            pid, state = self.claim(path, entry['id'], self.location(entry['state']) if entry.get('state') else None)
        else:
            pid, state = self.claim(path, wanted if wanted and str(path) not in self.index['scopes'] else None)
        forge = Forge(path, agent, state, self.omp, self.cfg.get('origin', ''), self.cfg.get('owner', ''), self.cfg.get('demo', False),
            parent=glob, machine=machine)
        forge.project_id = pid
        forge.ui = omp_merge(glob.ui, (entry or {}).get('ui') or {})
        forge.legacy_drafts = bool((entry or {}).get('legacyDrafts', False))
        return self.add(forge, str((entry or {}).get('name') or path.name or path), origin)

    def menu(self):
        # Copies first: a rescan or configure may add scopes while another thread builds a snapshot.
        rows = list(self.rows.values())
        explicit = [r for r in rows if r['origin'] == 'explicit']
        rest = sorted((r for r in rows if r['origin'] != 'explicit'), key=lambda r: (r['kind'] != 'global', r['name'].lower()))
        return [dict(r) for r in explicit + rest]

    def candidate_list(self):
        return sorted(({k: v for k, v in row.items() if k != 'agent'} for row in list(self.candidates.values())),
            key=lambda r: (-r['lastSeen'], r['path']))

    def default(self):
        return self.apps[self.menu()[0]['id']]

    def resolve(self, key):
        return self.apps.get(key) or self.apps.get(self.aliases.get(key, ''))

    def rescan(self, force=False):
        """Find projects OMP has used since the last look. Cheap: session headers are cached by file."""
        if not self.discovering or not force and time.time() - self.scanned < self.RESCAN:
            return
        with self.lock:
            self.scanned = time.time()
            known = {str(app.project.resolve()) for app in self.apps.values()}
            # A candidate keeps its id for as long as it is a candidate: the id the panel got from the last snapshot
            # must still configure it. Only ids of other paths are taken.
            previous = {row['path']: pid for pid, row in list(self.candidates.items())}
            candidates = {}
            for agent in list(self.machines):
                try:
                    found = discover(agent, self.roots, exclude=(agent, self.state_root))
                except Exception as error:
                    log_failure('project discovery', error)
                    continue
                for real, row in found.items():
                    if str(real) in known:
                        continue
                    if row['status'] == 'configured':
                        try:
                            self.make_project(real, agent, origin=row['origin'])
                            known.add(str(real))
                        except Exception as error:
                            log_failure('discovered project', error)
                        continue
                    others = (set(self.apps) | set(candidates)
                        | {r['id'] for path, r in self.index['scopes'].items() if path != str(real)})
                    kept = previous.get(row['path'])
                    pid = ((self.index['scopes'].get(str(real)) or {}).get('id')
                        or (kept if kept and kept not in others else scope_id(real, others)))
                    # Minute resolution: an active session elsewhere must not change every /api/state ETag.
                    candidates[pid] = {'id': pid, 'name': row['name'], 'path': row['path'], 'status': row['status'],
                        'lastSeen': int(row['lastSeen']) // 60 * 60, 'sessions': row['sessions'], 'agent': agent}
            self.candidates = candidates
            self.save_index()

    def save_index(self):
        if self.index_dirty:
            atomic(self.index_file, json.dumps(self.index, ensure_ascii=False, indent=1).encode())
            self.index_dirty = False

    def configure(self, candidate):
        """Create <dir>/.omp/config.yml for a candidate the server found, and serve it as a project scope."""
        with self.lock:
            row = self.candidates.get(candidate) if isinstance(candidate, str) else None
            if row is None:
                raise Problem('Немає такого кандидата. Онови список проєктів.', 404)
            machine = self.machines[row['agent']]
            with machine.lock:
                path = Path(row['path'])
                config, status = project_config(path)
                if status == 'symlink':
                    raise Problem('.omp — символьне посилання; Mana Tape не створює конфігурацію через посилання.', 409, 'symlink')
                if status == 'configured' or config.exists():
                    raise Problem('Проєкт уже має .omp/config.yml. Онови список проєктів.', 409)
                if not path.is_dir():
                    raise Problem('Каталогу проєкту більше немає', 404)
                created = not config.parent.exists()
                config.parent.mkdir(mode=0o755, exist_ok=True)
                if config.parent.is_symlink():
                    raise Problem('.omp — символьне посилання', 409, 'symlink')
                if created:
                    # Like the file (0644): readable by the project's group whatever the server's umask (077).
                    config.parent.chmod(0o755)
                try:
                    create_new(config, PROJECT_CONFIG_HEADER.encode(), 0o644)
                except FileExistsError:
                    raise Problem('Проєкт уже має .omp/config.yml. Онови список проєктів.', 409)
                self.candidates.pop(candidate, None)
                forge = self.make_project(path.resolve(), row['agent'], origin='configured', wanted=row['id'])
                # A record left by an older installation for a file that no longer existed is kept as a backup only.
                stale = forge.mode_state['profiles'].get('standard')
                if stale is not None and stale.get('hash') != digest(config.read_bytes()):
                    atomic(forge.backup_dir() / f'{time.time_ns()}-forgotten-standard-mode.json', json.dumps(stale, ensure_ascii=False).encode())
                    records = copy.deepcopy(forge.mode_state['profiles'])
                    del records['standard']
                    forge.transact({}, {**forge.mode_state, 'profiles': records})
                self.candidates.pop(candidate, None)
                self.save_index()
                return {'ok': True, 'id': forge.project_id}

    def migrate_pools(self):
        """Machine-wide pools from the per-project pools of older installations (once; legacy files stay)."""
        default = self.machines.get(self.default_agent)
        for agent, machine in self.machines.items():
            sources = [(scope.project_id, scope.mode_state.get('pools')) for scope in machine.ordered()]
            if machine is default:
                served = {str(scope.state_dir) for scope in machine.scopes.values()}
                for path, row in self.index['scopes'].items():
                    if row['state'] in served:
                        continue
                    try:
                        legacy = json.loads((Path(row['state']) / 'profile-modes.json').read_text(encoding='utf-8'))
                    except (OSError, ValueError):
                        continue
                    sources.append((row['id'], legacy.get('pools')))
            machine.migrate_pools(sources)


def load_installation(config_path=None, cfg=None):
    """Load the trusted local installation. installation.yml is optional; it never accepts paths from HTTP clients."""
    if config_path is not None:
        config_path = Path(config_path).expanduser().resolve()
        cfg = yaml_load(config_path.read_text(encoding='utf-8'))
        config_dir = config_path.parent
    else:
        cfg, config_dir = dict(cfg or {}), Path.cwd()
    if not isinstance(cfg, dict):
        raise ValueError('installation.yml: очікується YAML-об’єкт')
    entries = cfg.get('projects') or []
    if not isinstance(entries, list) or 'projects' in cfg and not entries:
        raise ValueError('У конфігурації потрібен непорожній список projects (або без ключа projects)')
    def location(value):
        path = Path(os.path.expandvars(str(value))).expanduser()
        return (config_dir / path).resolve() if not path.is_absolute() else path.resolve()
    state_root = location(cfg.get('state', '~/.local/share/mana-tape'))
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    omp = os.path.expandvars(os.path.expanduser(cfg.get('omp', 'omp')))
    omp = shutil.which(omp) or omp
    registry = Registry(cfg, config_dir, state_root, omp)
    registry.default_agent = location(cfg.get('agent', '~/.omp/agent'))
    paths, states, ids, user_entries = set(), set(), set(), {}
    for entry in entries:
        pid = entry.get('id', '') if isinstance(entry, dict) else ''
        if not ID.fullmatch(pid) or pid in ids:
            raise ValueError('Кожен проєкт потребує унікального id: a-z, 0-9, _ або -')
        ids.add(pid)
        scope = entry.get('scope', 'project')
        if scope not in ('project', 'user'):
            raise ValueError(f'Невідомий scope для проєкту {pid}: project або user')
        agent = location(entry.get('agent', registry.default_agent))
        # scope: user is the Global scope of that agent directory (the stopgap of 62df75b, kept compatible).
        project = agent if scope == 'user' else location(entry['path'])
        state = location(entry['state']) if entry.get('state') else state_root / pid
        if project in paths or state in states:
            raise ValueError('Проєкти та каталоги стану не можуть дублюватися')
        if scope == 'user' and agent in user_entries:
            raise ValueError('Для одного каталогу агента може бути лише один scope: user')
        if scope == 'project' and not (project / '.omp/config.yml').is_file():
            raise ValueError(f'Немає .omp/config.yml для проєкту {pid}')
        if scope == 'user' and not (agent / 'config.yml').is_file():
            raise ValueError(f'Немає config.yml в каталозі агента для проєкту {pid}')
        paths.add(project); states.add(state)
        if scope == 'user':
            user_entries[agent] = entry
    for agent, entry in user_entries.items():
        registry.make_global(agent, entry)
    for entry in entries:
        if entry.get('scope', 'project') == 'project':
            registry.make_global(location(entry.get('agent', registry.default_agent)))
    registry.make_global(registry.default_agent)
    for entry in entries:
        if entry.get('scope', 'project') == 'project':
            registry.make_project(location(entry['path']), location(entry.get('agent', registry.default_agent)), entry)
    registry.legacy_dirs()
    registry.rescan(force=True)
    stores = {}
    for agent, machine in registry.machines.items():
        apps = list(machine.scopes.values())
        shared_path = machine.dir / 'providers.json'
        if shared_path.exists():
            managed = json.loads(shared_path.read_text(encoding='utf-8'))
        else:
            managed = {}
            for app in apps:
                for pid, meta in app.state['managed'].items():
                    if pid in managed and managed[pid] != meta:
                        raise ValueError('Конфлікт старих метаданих спільного провайдера: '+pid)
                    managed[pid] = copy.deepcopy(meta)
            atomic(shared_path, json.dumps(managed, ensure_ascii=False).encode())
        machine.provider_store = stores[agent] = {'path': shared_path, 'managed': managed}
        for app in apps:
            app.provider_store = machine.provider_store
            app.agent_peers = apps
    for machine in registry.machines.values():
        try:
            machine.recover()
        except Exception as error:
            # Start read-only instead of crash-looping; every write reports mode-recovery until it is resolved.
            machine.recovery_failed(error)
    registry.migrate_pools()
    for machine in registry.machines.values():
        # The lead keeps the state an older installation already has (catalogue, telemetry, the CodexBar file the
        # Mac launcher pushes): the first explicit entry, else the Global scope.
        machine.lead = next((s for s in machine.scopes.values() if s.origin_kind == 'explicit'), machine.global_scope)
        for scope in machine.scopes.values():
            registry.share(scope)
            if machine.recovery is None and scope.recovery is None:
                try:
                    scope.backfill_written()
                except Exception as error:
                    log_failure('record backfill', error)
    for app in registry.apps.values():
        app.projects = registry.menu()
    registry.save_index()
    return cfg, registry.apps


DEFAULT_INSTALLATION = Path('~/.config/mana-tape/installation.yml').expanduser()


def main():
    p = argparse.ArgumentParser(description='Mana Tape — редактор профілів OMP')
    p.add_argument('--config', help='Локальний YAML інсталяції; без нього — ~/.config/mana-tape/installation.yml, якщо є')
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
    registry = None
    if a.project:
        # The single-project invocation of older installations: no Global scope, no discovery.
        if not a.state:
            p.error('Для --project потрібен --state')
        cfg = {}
        app = Forge(Path(a.project).expanduser().resolve(), Path(a.agent).expanduser().resolve(), Path(a.state).expanduser().resolve(), a.omp, a.origin, a.owner, a.demo)
        app.projects = [{'id': 'default', 'name': app.project.name}]
        apps = {'default': app}
        default = app
    else:
        if a.config or DEFAULT_INSTALLATION.is_file():
            cfg, apps = load_installation(a.config or DEFAULT_INSTALLATION)
        else:
            # installation.yml is optional: Global scope of the agent directory plus discovered projects.
            cfg, apps = load_installation(None, {'agent': a.agent, 'omp': a.omp, 'origin': a.origin, 'owner': a.owner,
                **({'state': a.state} if a.state else {}), **({'demo': True} if a.demo else {})})
        registry = next(iter(apps.values())).installation
        default = registry.default()
    port = a.port or cfg.get('port', 19421)
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.app, server.apps, server.registry = default, apps, registry
    server.daemon_threads = True
    if not a.no_refresh and not cfg.get('noRefresh', False):
        def start(app):
            # One catalogue refresh, expiry check and telemetry loop per OMP agent directory (its lead scope).
            if app.catalog_owner is not None:
                return
            threading.Thread(target=app.maintain, daemon=True).start()
            threading.Thread(target=app.insights.loop, daemon=True).start()
        for app in list(apps.values()):
            start(app)
        if registry is not None:
            registry.on_add = start
    print(f'Mana Tape: http://127.0.0.1:{port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
