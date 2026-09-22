#!/usr/bin/env python3
"""Private OMP profile editor. Run behind Tailscale Serve, bound to loopback."""
import argparse
import copy
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from profile_modes import compile_profile, default_settings, route_statuses, tariff_status, validate_settings, validate_pools, pool_name, POOL_NAMES
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

from ruamel.yaml import YAML

EFFORT = re.compile(r':(off|minimal|low|medium|high|xhigh|max|auto)$')
ID = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
MODEL_FIELDS = ('id', 'name', 'reasoning', 'thinking', 'input', 'contextWindow', 'maxTokens', 'cost')


class Problem(Exception):
    def __init__(self, message, status=400):
        self.status = status
        super().__init__(message)


def profile_name(value):
    name = re.sub(r'\s+', '-', value.strip().lower()) if isinstance(value, str) else ''
    if not ID.fullmatch(name):
        raise Problem('Вкажи назву латиницею: літери, цифри, пробіли, дефіс або підкреслення; до 64 символів. Почни з літери чи цифри.')
    return name


def yaml_load(data):
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
    if isinstance(x, dict):
        return {str(k): plain(v) for k, v in x.items()}
    if isinstance(x, list):
        return [plain(v) for v in x]
    return x


def merge(a, b):
    out = copy.deepcopy(a)
    for k, v in b.items():
        out[k] = merge(out.get(k, {}), v) if isinstance(v, dict) else copy.deepcopy(v)
    return out


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fingerprint(data):
    return digest(json.dumps(plain(data), sort_keys=True, separators=(',', ':')).encode())


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
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def route(raw):
    return EFFORT.sub('', raw)


def valid_route(value):
    if not isinstance(value, str) or len(value) > 300 or not re.fullmatch(r'[^\s\x00-\x1f/]+/[^\s\x00-\x1f]+', value):
        raise Problem('Некоректний ідентифікатор моделі')


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
        self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {
            'managed': {}, 'catalog': {}, 'available': [], 'changes': [], 'favs': [],
            'refreshed': 0, 'error': '', 'backups': {}, 'attempted': 0}
        self.state.setdefault('attempted', 0)
        self.mode_file = self.state_dir / 'profile-modes.json'
        self.mode_journal = self.state_dir / 'profile-mode-transaction.json'
        self.mode_state = json.loads(self.mode_file.read_text()) if self.mode_file.exists() else {'profiles': {}}
        self.recover_modes()
        from insights import Insights
        self.insights = Insights(self)

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

    def path(self, profile):
        if not isinstance(profile, str) or not ID.fullmatch(profile):
            raise Problem('Некоректна назва профілю')
        p = self.project / '.omp' / ('config.yml' if profile == 'standard' else f'presets/{profile}.yml')
        if p.is_symlink() or not p.resolve().is_relative_to((self.project / '.omp').resolve()):
            raise Problem('Посилання замість конфігурації не підтримується')
        return p

    def read(self, p):
        try:
            data = yaml_load(p.read_text())
        except Exception as e:
            raise Problem('Не вдалося прочитати YAML; оригінал не змінено', 422) from e
        if not isinstance(data, dict):
            raise Problem('Очікується YAML-об’єкт', 422)
        return data

    def revision(self, profile):
        base = self.path('standard').read_bytes()
        records = self.mode_state['profiles']
        meta = {k: {x: records[k].get(x) for x in ('normal', 'settings')} for k in ('standard', profile) if k in records}
        suffix = json.dumps(meta, sort_keys=True).encode() if meta else b''
        # The profile name is not part of a revision; renaming preserves its contents.
        if profile != 'standard' and profile in meta:
            meta['selected'] = meta.pop(profile); suffix = json.dumps(meta, sort_keys=True).encode()
        pool_suffix = self.pools_revision().encode() if self.mode_state.get('pools') else b''
        return digest(base + b'\0' + (self.path(profile).read_bytes() if profile != 'standard' else b'') + suffix + pool_suffix)

    def pools(self):
        return copy.deepcopy(self.mode_state.get('pools', {name: [] for name in POOL_NAMES}))

    def pools_revision(self):
        return fingerprint(self.pools())

    def save_pools(self, body):
        with self.lock:
            if body.get('revision') != self.pools_revision():
                raise Problem('Спільні пули вже змінилися. Онови дані; чернетка лишиться у вікні.', 409)
            conflicts = self.mode_conflicts()
            if conflicts:
                raise Problem('Файл змінено поза Mana Tape: '+', '.join(conflicts), 409)
            try:
                pools = validate_pools(body.get('pools'), self.mode_catalog())
            except ValueError as e:
                raise Problem(str(e), 422) from e
            base, _ = self.profiles()
            return self.commit_mode({'name': 'standard', 'normal': base, 'pools': pools, 'poolsOnly': True})

    def native_profiles(self):
        base = self.read(self.path('standard'))
        profiles = {'standard': base}
        for p in sorted((self.project / '.omp/presets').glob('*.yml')):
            if ID.fullmatch(p.stem):
                profiles[p.stem] = self.read(self.path(p.stem))
        return base, profiles

    def profiles(self):
        _, ps = self.native_profiles()
        for name in ps:
            record = self.mode_state['profiles'].get(name)
            if record:
                ps[name] = yaml_load(record['normal'])
        return ps['standard'], ps

    def mode_conflicts(self):
        return [name for name, r in self.mode_state['profiles'].items()
            if self.path(name).exists() and digest(self.path(name).read_bytes()) != r['hash']]

    def recover_modes(self):
        if not self.mode_journal.exists():
            return
        journal = json.loads(self.mode_journal.read_text())
        files = journal['files']
        current = {name: self.path(name).read_text() if self.path(name).exists() else None for name in files}
        if all(current[n] == row['after'] for n, row in files.items()):
            self.mode_state = journal['afterState']
        else:
            if any(current[n] not in (row['before'], row['after']) for n, row in files.items()):
                raise Problem('Незавершене збереження та зовнішні зміни. Потрібне відновлення журналу режимів.', 409)
            for name, row in files.items():
                path = self.path(name)
                if row['before'] is None:
                    path.unlink(missing_ok=True)
                else:
                    atomic(path, row['before'].encode(), path.stat().st_mode & 0o777)
            self.mode_state = journal['beforeState']
        atomic(self.mode_file, json.dumps(self.mode_state, ensure_ascii=False).encode())
        self.mode_journal.unlink()

    def mode_catalog(self):
        cached, _ = self.cached()
        return {**cached, **self.state['catalog']}

    def mode_settings(self, name, normal, models):
        record = self.mode_state['profiles'].get(name)
        return copy.deepcopy(record['settings']) if record else default_settings(models, self.state['available'], normal.get('disabledProviders', []))

    def preview_profile(self, body):
        with self.lock:
            return self.prepare_mode(body)['public']

    def prepare_mode(self, body):
        name = body.get('profile')
        if not self.path(name).is_file():
            raise Problem('Профіль не знайдено', 404)
        if body.get('revision') != self.revision(name):
            raise Problem('Профіль або його режим змінився. Онови дані; чернетка лишиться у вікні.', 409)
        conflicts = self.mode_conflicts()
        if conflicts:
            raise Problem('Файл змінено поза Mana Tape: '+', '.join(conflicts)+'. Збереження режимів зупинене, щоб не затерти ці зміни.', 409)
        base, ps = self.profiles()
        data = copy.deepcopy(ps[name])
        roles = set(merge(base, data).get('modelRoles', {}))
        changes = body.get('changes', [])
        if not isinstance(changes, list) or len(changes) > 150:
            raise Problem('Забагато змін')
        self.patch_profile(data, changes, roles, name)
        full = data if name == 'standard' else merge(base, data)
        models = self.mode_catalog()
        try:
            settings = validate_settings(body.get('modeSettings', self.mode_settings(name, full, models)), roles, models, full.get('task', {}).get('agentModelOverrides', {}))
        except ValueError as e:
            raise Problem(str(e)) from e
        statuses = route_statuses(models, self.managed)
        plan = compile_profile(full, settings, models, statuses, self.pools(), self.ui.get('visionRoles', ['vision']))
        token = fingerprint({'revision': self.revision(name), 'normal': data, 'settings': settings, 'effective': plan['effective']})
        public = {k: plain(v) for k, v in plan.items() if k != 'effective'}
        public.update({'token': token, 'settings': settings, 'statuses': {r: statuses.get(r, {'status': 'unknown', 'reason': 'Немає даних'}) for r in {route(v) for v in settings['alternatives'] + [x for a in settings['overrides'].values() for x in a]}}, 'tariff': tariff_status()})
        return {'name': name, 'normal': data, 'settings': settings, 'plan': plan, 'statuses': statuses, 'public': public}

    def save_mode_profile(self, body):
        with self.lock:
            prepared = self.prepare_mode(body)
            if prepared['plan']['issues']:
                raise Problem('Додай доступні альтернативи: '+', '.join(i['key'] for i in prepared['plan']['issues']), 422)
            if body.get('previewToken') != prepared['public']['token']:
                raise Problem('План змінився. Онови заміни, переглянь карту та збережи ще раз.', 409)
            return self.commit_mode(prepared)

    def commit_mode(self, prepared, restoring=False):
        name = prepared['name']
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
            'normal': yaml_dump(prepared['normal']) if prepared.get('new') else self.path(name).read_text(), 'settings': {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}, 'statuses': {}, 'catalog': {}}
        models = self.mode_catalog()
        pools = prepared.get('pools', self.pools())
        settings = prepared.get('settings', self.mode_settings(name, normals['standard'], models))
        full = normals['standard'] if name == 'standard' else merge(normals['standard'], normals[name])
        references = set(route(r) for r in settings['alternatives'] + [r for values in settings['overrides'].values() for r in values]
            + list(full.get('modelRoles', {}).values()) + [r for values in full.get('retry', {}).get('fallbackChains', {}).values() for r in values]
            + [r for values in full.get('task', {}).get('agentModelOverrides', {}).values() for r in ([values] if isinstance(values, str) else values) if not r.startswith('@')])
        references = {route(member) for ref in references for member in (pools.get(pool_name(ref), []) if pool_name(ref) is not None else [ref])}
        frozen_catalog = prepared.get('catalog', {r: {k: copy.deepcopy(models[r].get(k)) for k in ('id', 'name', 'cost', 'input', 'thinking')} if r in models else None for r in references})
        if not prepared.get('poolsOnly'):
            records[name] = {**(prior or {}), 'normal': yaml_dump(prepared['normal']), 'settings': settings,
                'statuses': {r: v for r, v in prepared['statuses'].items() if r in references},
                'catalog': frozen_catalog, 'previous': previous, 'at': time.time()}
        projections = {}
        for n, overlay in normals.items():
            full = overlay if n == 'standard' else merge(normals['standard'], overlay)
            settings = records[n]['settings'] if n in records else {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}
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
            desired = projections[n]['effective']
            output = copy.deepcopy(overlay)
            inherited = output if n == 'standard' else merge(compiled_base, output)
            wanted_default = desired.get('retry', {}).get('fallbackChains', {}).get('default', [])
            if wanted_default != inherited.get('retry', {}).get('fallbackChains', {}).get('default', []):
                output.setdefault('retry', {}).setdefault('fallbackChains', {})['default'] = copy.deepcopy(wanted_default)
            for role, model in desired.get('modelRoles', {}).items():
                if inherited.get('modelRoles', {}).get(role) != model:
                    output.setdefault('modelRoles', {})[role] = model
                wanted = desired.get('retry', {}).get('fallbackChains', {}).get(role, desired.get('retry', {}).get('fallbackChains', {}).get('default', []))
                actual = inherited.get('retry', {}).get('fallbackChains', {}).get(role, inherited.get('retry', {}).get('fallbackChains', {}).get('default', []))
                if wanted != actual:
                    output.setdefault('retry', {}).setdefault('fallbackChains', {})[role] = copy.deepcopy(wanted)
            for worker, values in desired.get('task', {}).get('agentModelOverrides', {}).items():
                if values != inherited.get('task', {}).get('agentModelOverrides', {}).get(worker):
                    output.setdefault('task', {}).setdefault('agentModelOverrides', {})[worker] = copy.deepcopy(values)
            normal_text = records[n]['normal'] if n in records else before_bytes[n].decode()
            rendered = normal_text if plain(output) == plain(overlay) else yaml_dump(output)
            if plain(yaml_load(rendered)) != plain(output):
                raise Problem('Перевірка YAML не пройдена', 422)
            if n in records or rendered != normal_text:
                records[n] = {**records.get(n, {}), 'normal': normal_text, 'settings': records.get(n, {}).get('settings', {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}), 'statuses': records.get(n, {}).get('statuses', {}), 'hash': digest(rendered.encode()), 'views': projections[n]['views']}
            outputs[n] = rendered
        files = {n: {'before': before_bytes[n].decode() if before_bytes[n] is not None else None, 'after': text} for n, text in outputs.items() if text.encode() != before_bytes[n]}
        for n, raw in before_bytes.items():
            if (self.path(n).read_bytes() if self.path(n).exists() else None) != raw:
                raise Problem('Файл змінився під час підготовки. Збереження скасовано.', 409)
        after = {**self.mode_state, 'profiles': records}
        if 'pools' in prepared:
            after['pools'] = pools
        journal = {'files': files, 'beforeState': self.mode_state, 'afterState': after}
        backup_dir = self.state_dir/'backups'; backup_dir.mkdir(mode=0o700, exist_ok=True)
        atomic(backup_dir/(str(time.time_ns())+'-profile-modes.json'), json.dumps(self.mode_state, ensure_ascii=False).encode())
        for n, row in files.items():
            if row['before'] is None:
                continue
            backup = backup_dir/(str(time.time_ns())+'-'+self.path(n).name)
            atomic(backup, row['before'].encode()); self.state['backups'][str(self.path(n))] = str(backup)
        atomic(self.mode_journal, json.dumps(journal, ensure_ascii=False).encode())
        try:
            for n, row in files.items():
                if (self.path(n).read_bytes() if self.path(n).exists() else None) != before_bytes[n]:
                    raise Problem('Зовнішня зміна під час запису', 409)
                atomic(self.path(n), row['after'].encode(), self.path(n).stat().st_mode & 0o777 if self.path(n).exists() else 0o600)
            atomic(self.mode_file, json.dumps(after, ensure_ascii=False).encode())
        except Exception:
            self.recover_modes()
            raise
        self.mode_state = after
        self.mode_journal.unlink()
        self.persist()
        return {'ok': True, 'revision': self.revision(name)}

    def refs(self):
        base, ps = self.profiles()
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
            entries = [member for r in entries for member in (self.pools().get(pool_name(r), []) if pool_name(r) is not None else [r])]
            for r in entries:
                if isinstance(r, str) and '/' in r:
                    out.setdefault(route(r), set()).add(name)
        return out

    def replace_yaml(self, path, data, expected=None):
        old = path.read_bytes() if path.exists() else b''
        if expected is not None and digest(old) != expected:
            raise Problem('Файл уже змінився. Онови дані й повтори зміну.', 409)
        rendered = yaml_dump(data).encode()
        if plain(yaml_load(rendered)) != plain(data):
            raise Problem('Перевірка YAML не пройдена', 422)
        if old == rendered:
            return
        backup_dir = self.state_dir / 'backups'
        backup_dir.mkdir(mode=0o700, exist_ok=True)
        backup_dir.chmod(0o700)
        backup = backup_dir / f'{time.time_ns()}-{path.name}'
        if old:
            atomic(backup, old)
        # Compare once more immediately before replacing; external OMP writers do not share our lock.
        if (path.read_bytes() if path.exists() else b'') != old:
            raise Problem('Файл змінився під час збереження', 409)
        atomic(path, rendered, (path.stat().st_mode & 0o777) if path.exists() else 0o600)
        if old:
            self.state['backups'][str(path)] = str(backup)
        self.persist()
        for expired in sorted(backup_dir.glob(f'*-{path.name}'))[:-20]:
            expired.unlink()

    def patch_profile(self, data, changes, roles, name):
        base, _ = self.profiles()
        workers = set(merge(base, data).get('task', {}).get('agentModelOverrides', {}))
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
                    if keys[0] == 'task' and not value:
                        raise Problem('Агент потребує хоча б одного кандидата')
            target = data
            for key in keys[:-1]:
                target = target.setdefault(key, {})
            if change.get('remove'):
                if name == 'standard':
                    raise Problem('Standard не має батьківського профілю')
                target.pop(keys[-1], None)
            else:
                target[keys[-1]] = copy.deepcopy(value)

    def save_profile(self, body):
        if 'modeSettings' in body:
            return self.save_mode_profile(body)
        if self.mode_state['profiles'] or self.mode_state.get('pools'):
            raise Problem('Онови Mana Tape перед збереженням профілю з режимами.', 409)
        with self.lock:
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
            data = yaml_load(raw)
            base = yaml_load(base_raw)
            roles = set(merge(base, data).get('modelRoles', {}))
            changes = body.get('changes')
            if not isinstance(changes, list) or not 1 <= len(changes) <= 150:
                raise Problem('Немає змін або забагато змін')
            self.patch_profile(data, changes, roles, name)
            if name != 'standard' and self.path('standard').read_bytes() != base_raw:
                raise Problem('Standard змінився під час збереження', 409)
            self.replace_yaml(path, data, original_hash)
            return {'ok': True, 'revision': self.revision(name)}

    def profile_action(self, body):
        with self.lock:
            name, action = body.get('profile'), body.get('action')
            path = self.path(name)
            if not path.is_file():
                raise Problem('Профіль не знайдено', 404)
            if action == 'clone':
                new_name = profile_name(body.get('name'))
                target = self.path(new_name)
                if target.exists():
                    raise Problem('Профіль із такою назвою вже є', 409)
                base, logical = self.profiles()
                data = merge(base, logical[name])
                if self.mode_state['profiles']:
                    if self.mode_conflicts():
                        raise Problem('Профіль змінено поза Mana Tape. Онови дані перед копіюванням.', 409)
                    settings = self.mode_settings(name, data, self.mode_catalog())
                    statuses = route_statuses(self.mode_catalog(), self.managed)
                    # Creation participates in the mode journal; no orphan YAML on failure.
                    self.commit_mode({'name': new_name, 'normal': data, 'settings': settings, 'statuses': statuses, 'new': True})
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
                raw = path.read_bytes()
                # A hard link preserves the exact YAML and fails if the name is taken.
                try:
                    os.link(path, target)
                except FileExistsError:
                    raise Problem('Профіль із такою назвою вже є', 409)
                if path.read_bytes() != raw:
                    target.unlink()
                    raise Problem('Профіль змінився під час перейменування', 409)
                path.unlink()
                if name in self.mode_state['profiles']:
                    self.mode_state['profiles'][new_name] = self.mode_state['profiles'].pop(name)
                    atomic(self.mode_file, json.dumps(self.mode_state, ensure_ascii=False).encode())
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
                    if self.mode_conflicts():
                        raise Problem('Є зовнішні зміни. Відновлення зупинене.', 409)
                    return self.commit_mode({'name': name, 'normal': yaml_load(previous['normal']), 'settings': previous['settings'], 'statuses': previous.get('statuses', {}), 'catalog': previous.get('catalog', {})}, restoring=True)
                backup = self.state['backups'].get(str(path))
                if not backup:
                    raise Problem('Ще немає резервної копії')
                self.replace_yaml(path, self.read(Path(backup)), digest(path.read_bytes()))
            elif action == 'delete' and name != 'standard':
                atomic(self.state_dir / 'backups' / f'{time.time_ns()}-deleted-{name}.yml', path.read_bytes())
                path.unlink()
                if name in self.mode_state['profiles']:
                    atomic(self.state_dir/'backups'/(str(time.time_ns())+'-deleted-'+name+'-mode.json'), json.dumps(self.mode_state['profiles'][name], ensure_ascii=False).encode())
                    del self.mode_state['profiles'][name]
                    atomic(self.mode_file, json.dumps(self.mode_state, ensure_ascii=False).encode())
            else:
                raise Problem('Дія не підтримується')
            return {'ok': True}

    def registry(self):
        p = self.agent / 'models.yml'
        return self.read(p) if p.exists() else {'providers': {}}

    def cached(self):
        result, stamps = {}, {}
        db = self.agent / 'models.db'
        if db.exists():
            con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
            try:
                rows = con.execute('SELECT provider_id, updated_at, authoritative, models FROM model_cache ORDER BY updated_at').fetchall()
                for key, stamp, authority, raw in rows:
                    provider = key.split(':', 1)[0]
                    stamps[provider] = {'at': stamp / 1000, 'authoritative': bool(authority)}
                    models = json.loads(raw)
                    if isinstance(models, dict):
                        models = models.get('models', [])
                    for m in models:
                        if isinstance(m, dict) and isinstance(m.get('id'), str):
                            result[provider + '/' + m['id']] = {**{k: m[k] for k in MODEL_FIELDS if k in m}, 'provider': provider, 'source': 'cache'}
            finally:
                con.close()
        for provider, cfg in self.registry().get('providers', {}).items():
            for m in cfg.get('models', []):
                key = provider + '/' + m['id']
                result[key] = {**result.get(key, {}), **{k: m[k] for k in MODEL_FIELDS if k in m}, 'provider': provider, 'source': 'config'}
        return result, stamps

    def snapshot(self):
        with self.lock:
            base, ps = self.profiles()
            cached, stamps = self.cached()
            models = {**cached, **self.state['catalog']}
            refs = self.refs()
            for r in refs:
                provider, mid = r.split('/', 1)
                models.setdefault(r, {'provider': provider, 'id': mid, 'name': mid, 'source': 'reference'})
            available = set(self.state['available'])
            registry = self.registry().get('providers', {})
            provider_ids = sorted({m['provider'] for m in models.values()} | set(registry) | set(self.managed))
            providers = []
            for provider in provider_ids:
                config = registry.get(provider, {})
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
            for r, m in models.items():
                m['local'] = m['provider'] in self.ui.get('localProviders', []) or registry.get(m['provider'], {}).get('discovery', {}).get('type') in ('ollama', 'llama.cpp', 'lm-studio')
                m['available'] = r in available
                m['name'] = m.get('name') or m['id']
                m['usedBy'] = sorted(refs.get(r, set()))
            def relevant(p):
                return plain({k: p[k] for k in ('modelRoles', 'retry', 'task', 'disabledProviders') if k in p})
            return {'source': str(self.project), 'projectId': self.project_id, 'projects': self.projects,
                'ui': self.ui, 'legacyDrafts': self.legacy_drafts, 'demo': self.demo, 'base': relevant(base),
                'presets': {k: relevant(v) for k, v in ps.items() if k != 'standard'},
                'revisions': {k: self.revision(k) for k in ps},
                'freePools': self.pools(), 'poolsRevision': self.pools_revision(),
                'restorable': [k for k in ps if self.mode_state['profiles'].get(k, {}).get('previous') or k not in self.mode_state['profiles'] and str(self.path(k)) in self.state['backups']],
                'profileModes': {k: {'settings': self.mode_settings(k, merge(base, v), models), 'views': self.mode_state['profiles'].get(k, {}).get('views'), 'at': self.mode_state['profiles'].get(k, {}).get('at')} for k, v in ps.items()},
                'modeConflicts': self.mode_conflicts(), 'tariff': tariff_status(),
                'models': list(models.values()), 'providers': providers,
                'providerRevision': digest((self.agent / 'models.yml').read_bytes()) if (self.agent / 'models.yml').exists() else digest(b''),
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
            for route, profiles in peer.refs().items():
                refs.setdefault(route, set()).update(peer.project_id+"/"+name for name in profiles)
        return refs

    def provider_save(self, body):
        with self.lock:
            pid = body.get('id', '')
            if not isinstance(pid, str) or not ID.fullmatch(pid):
                raise Problem('ID: малі латинські літери, цифри, дефіс')
            path = self.agent / 'models.yml'
            current_hash = digest(path.read_bytes()) if path.exists() else digest(b'')
            if body.get('revision') != current_hash:
                raise Problem('Провайдери вже змінились. Онови дані.', 409)
            data = self.registry()
            providers = data.setdefault('providers', {})
            exists = pid in providers
            renewing = self.managed.get(pid, {}).get('expired', False)
            if not exists and not renewing and (pid in self.managed or any(m['provider'] == pid for m in self.cached()[0].values())):
                raise Problem('Цей ID уже належить провайдеру OMP; використай інший')
            if body.get('action') == 'delete':
                if not exists:
                    raise Problem('Вбудований провайдер можна лише вимкнути у профілі')
                uses = sorted({p for r, profiles in self.registry_refs().items() if r.startswith(pid + '/') for p in profiles})
                if uses:
                    raise Problem('Спочатку заміни моделі у профілях: ' + ', '.join(uses), 409)
                providers.pop(pid)
                self.replace_yaml(path, data, current_hash)
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
            config.update({'baseUrl': url, 'api': api, 'auth': auth})
            if key and auth != 'none':
                keyfile = self.agent / 'forge-keys' / (pid + '-' + secrets.token_hex(6))
                keyfile.parent.mkdir(mode=0o700, exist_ok=True)
                keyfile.parent.chmod(0o700)
                atomic(keyfile, key.encode(), 0o600)
                # The path is generated by the server; the browser cannot submit commands.
                import shlex
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
            days = body.get('days', 0)
            if not isinstance(days, int) or days not in (-1, 0, 1, 7, 30):
                raise Problem('Некоректний термін')
            previous_meta = self.managed.get(pid)
            deadline = (previous_meta or {}).get('expires', 0) if days == -1 else time.time() + days * 86400 if days else 0
            if deadline and deadline <= time.time():
                raise Problem('Термін минув; обери новий термін дії')
            self.managed[pid] = {'name': str(body.get('name') or pid)[:80],
                'expires': deadline, 'expired': False,
                'fingerprint': fingerprint(config)}
            # Persist expiry before publishing the provider, so a crash cannot lose its deadline.
            self.persist()
            try:
                self.replace_yaml(path, data, current_hash)
            except Exception:
                if previous_meta is None:
                    self.managed.pop(pid, None)
                else:
                    self.managed[pid] = previous_meta
                self.persist()
                raise
            return {'ok': True}

    def expire(self):
        with self.lock:
            previous_meta = copy.deepcopy(self.managed)
            previous_available = self.state['available'][:]
            path = self.agent / 'models.yml'
            raw = path.read_bytes() if path.exists() else b''
            data = yaml_load(raw) if raw else {'providers': {}}
            refs = self.registry_refs()
            changed = False
            for pid, meta in self.managed.items():
                if meta.get('expires', 0) and time.time() >= meta['expires'] and not meta.get('expired'):
                    config = data.get('providers', {}).get(pid)
                    if config is None:
                        meta['expired'] = True
                    elif any(r.startswith(pid + '/') for r in refs):
                        meta['expiryConflict'] = True
                        meta['expiryReason'] = 'used'
                    elif fingerprint(config) == meta.get('fingerprint'):
                        data['providers'].pop(pid)
                        meta['expired'] = True
                        changed = True
                        self.state['available'] = [r for r in self.state['available'] if not r.startswith(pid + '/')]
                    else:
                        meta['expiryConflict'] = True
                        meta['expiryReason'] = 'edited'
            if changed:
                try:
                    self.replace_yaml(path, data, digest(raw))
                except Exception:
                    self.managed = previous_meta
                    self.state['available'] = previous_available
                    raise
            self.persist()

    def refresh(self):
        if not self.refresh_lock.acquire(blocking=False):
            return
        start = time.time()
        self.busy = True
        try:
            with self.lock:
                self.state['attempted'] = start
                prior = set(self.state['available'])
                cached_before, before_stamps = self.cached()
                known_before = set(self.state.get('known', set(cached_before) | set(self.state['catalog'])))
            # No prompt, no inference, no project extensions or active sessions touched.
            command = [self.omp, 'models', 'refresh', '--json', '--no-extensions']
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
            with self.lock:
                cache, stamps = self.cached()
                old = self.state['catalog']
                seen = set()
                changes = []
                for raw in native:
                    provider, mid = raw['provider'], raw['id']
                    r = provider + '/' + mid
                    seen.add(r)
                    model = {k: raw[k] for k in MODEL_FIELDS if k in raw}
                    model.update({'provider': provider, 'source': 'omp', 'status': 'present'})
                    if self.state['refreshed'] and r not in known_before:
                        model['newAt'] = start
                        changes.append({'kind': 'new', 'route': r, 'at': start})
                    elif old.get(r, {}).get('newAt'):
                        model['newAt'] = old[r]['newAt']
                    old[r] = model
                for r in prior - seen:
                    pid = r.split('/', 1)[0]
                    stamp = stamps.get(pid, {})
                    # Absence only counts after fresh authoritative discovery; failures retain cache.
                    if (stamp.get('authoritative') and stamp.get('at', 0) >= start - 2
                            and stamp.get('at', 0) > before_stamps.get(pid, {}).get('at', 0)
                            and any(r.startswith(pid + '/') for r in seen)):
                        if old.get(r, {}).get('status') != 'missing':
                            changes.append({'kind': 'missing', 'route': r, 'at': start})
                        if r in old:
                            old[r]['status'] = 'missing'
                self.state['available'] = sorted(seen)
                self.state['known'] = sorted(known_before | set(cache) | seen)
                self.state['changes'] = (self.state['changes'] + changes)[-500:]
                self.state['refreshed'], self.state['error'] = time.time(), ''
                self.persist()
        except Exception:
            with self.lock:
                self.state['error'] = 'Оновлення не завершилось. Показано останній каталог; моделі не видалено.'
                self.persist()
        finally:
            self.busy = False
            self.refresh_lock.release()

    def refresh_async(self):
        threading.Thread(target=self.refresh, daemon=True).start()

    def maintain(self):
        while True:
            try:
                self.expire()
                if time.time() - self.state['attempted'] >= 900:
                    self.refresh_async()
            except Exception:
                self.state['error'] = 'Не вдалося виконати фонову перевірку; конфігурації збережено.'
            time.sleep(30)


class Handler(BaseHTTPRequestHandler):
    server_version = 'Forge'

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *_):
        pass  # Do not log paths, form contents, credentials or model output.

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

    def respond(self, status, data, kind='application/json; charset=utf-8'):
        raw = json.dumps(data, ensure_ascii=False).encode() if not isinstance(data, bytes) else data
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store' if self.path.startswith('/api/') else 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        try:
            self.check_access()
            path = urlsplit(self.path).path
            if path == '/api/state':
                return self.respond(200, self.selected_app().snapshot())
            static = Path(__file__).parent / 'static'
            filename = 'index.html' if path == '/' else path.lstrip('/')
            p = (static / filename).resolve()
            if not p.is_relative_to(static.resolve()) or not p.is_file():
                raise Problem('Не знайдено', 404)
            self.respond(200, p.read_bytes(), mimetypes.guess_type(p)[0] or 'application/octet-stream')
        except Problem as e:
            self.respond(e.status, {'error': str(e)})
        except Exception:
            self.respond(500, {'error': 'Не вдалося прочитати дані. Конфігурації не змінено.'})

    def do_POST(self):
        try:
            self.check_access()
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > 200000:
                raise Problem('Неприпустимий розмір запиту', 413)
            body = json.loads(self.rfile.read(size))
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
                    app.state['favs'] = list(dict.fromkeys(values))
                    app.persist()
                result = {'ok': True}
            else:
                raise Problem('Не знайдено', 404)
            self.respond(200, result)
        except Problem as e:
            self.respond(e.status, {'error': str(e)})
        except (ValueError, TypeError, KeyError):
            self.respond(400, {'error': 'Некоректні дані запиту'})
        except Exception:
            self.respond(500, {'error': 'Не вдалося виконати дію. Онови сторінку й перевір збережений стан.'})


def load_installation(config_path):
    """Load trusted local installation config. Never accepts paths from HTTP clients."""
    config_path = Path(config_path).expanduser().resolve()
    cfg = yaml_load(config_path.read_text())
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
            managed = json.loads(shared_path.read_text())
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
