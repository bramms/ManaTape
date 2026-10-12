"""Global + project layers, discovery, machine-wide pools and native presets. Disposable fixtures only."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import server
from server import Forge, Handler, Problem, ThreadingHTTPServer, digest, load_installation, yaml_dump, yaml_load
from scopes import active_preset, discover, effective, omp_merge, project_layer, short_diff, sources, visible_presets

DS = {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}
MODELS = {'providers': {
    'paid': {'api': 'openai-completions', 'baseUrl': 'https://example.invalid/v1', 'auth': 'none', 'models': [
        {'id': 'big', 'name': 'Big', 'input': ['text', 'image'], 'cost': {'input': 1, 'output': 2}},
        {'id': 'small', 'name': 'Small', 'input': ['text'], 'cost': {'input': 1, 'output': 2}},
        {'id': 'deepseek-v4', 'name': 'DeepSeek V4', 'input': ['text'], 'cost': {'input': 1, 'output': 2}},
        {'id': 'q3', 'name': 'Q3', 'input': ['text'], 'cost': {'input': 1, 'output': 2}},
        {'id': 'q2', 'name': 'Q2', 'input': ['text'], 'cost': {'input': 1, 'output': 2}}]},
    'gratis': {'api': 'openai-completions', 'baseUrl': 'https://example.invalid/v1', 'auth': 'none', 'models': [
        {'id': 'a-free', 'name': 'A Free', 'input': ['text'], 'cost': {'input': 0, 'output': 0}},
        {'id': 'b-free', 'name': 'B Free', 'input': ['text'], 'cost': {'input': 0, 'output': 0}}]}}}


def session(folder, name, cwd):
    """An OMP session file: a padded title record first, then the header with the cwd."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(json.dumps({'type': 'title', 'v': 1, 'title': 'x', 'pad': ' ' * 120}) + '\n'
        + json.dumps({'type': 'session', 'version': 3, 'id': name, 'cwd': str(cwd)}) + '\n'
        + json.dumps({'type': 'model_change', 'model': 'paid/big'}) + '\n')


class Layers(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.agent = self.root / 'agent'
        self.agent.mkdir()
        (self.agent / 'models.yml').write_text(yaml_dump(MODELS))
        (self.agent / 'config.yml').write_text('# global comment\n' + yaml_dump({
            'modelRoles': {'default': 'paid/big', 'smol': 'paid/deepseek-v4'},
            'retry': {'fallbackChains': {'default': ['paid/small']}}, 'theme': {'dark': 'titanium'}}))
        self.one = self.project('one', {'modelRoleStorage': 'project', 'modelRoles': {'task': 'paid/small'}})
        self.two = self.project('two', {'modelRoles': {'plan': 'paid/big'}})
        self.cfg = {'state': 'state', 'agent': 'agent', 'omp': '/does-not-exist', 'ui': {'roleLabels': {'default': 'Boss'}},
                    'projects': [{'id': 'one', 'name': 'One', 'path': 'one', 'ui': {'roleLabels': {'task': 'Worker'}}}]}
        self.config = self.root / 'installation.yml'
        self.config.write_text(yaml_dump(self.cfg))
        # OMP has run in `two` (configured) and `cand` (no .omp yet).
        self.cand = self.root / 'cand'
        self.cand.mkdir()
        session(self.agent / 'sessions' / '--misleading-name--', 'a.jsonl', self.two)
        session(self.agent / 'sessions' / '--misleading-name--', 'b.jsonl', self.cand)
        _, self.apps = load_installation(self.config)
        self.registry = self.apps['one'].installation

    def project(self, name, data):
        path = self.root / name
        (path / '.omp').mkdir(parents=True)
        (path / '.omp/config.yml').write_text(yaml_dump(data))
        return path

    def app(self, path):
        return next(a for a in self.apps.values() if a.project == path.resolve())

    def save(self, app, profile='standard', changes=(), settings=None, confirm=False):
        body = {'profile': profile, 'revision': app.revision(profile), 'changes': list(changes),
                'modeSettings': settings or (app.preset_settings(profile[7:]) if profile.startswith('preset:') else app.mode_settings(profile))}
        body['previewToken'] = app.preview_profile(body)['token']
        return self.act(app.save_profile, body) if confirm else app.save_profile(body)

    @staticmethod
    def act(call, body):
        """An owner action that accepts what its preview shows (409 `derived` → the same body with that token)."""
        try:
            return call(body)
        except Problem as error:
            if error.code != 'derived':
                raise
            return call({**body, 'confirm': error.details['token']})

    def read(self, path):
        return yaml_load(Path(path).read_text())

    # ---- OMP merge rules --------------------------------------------------------------------------------------

    def test_omp_merge_rules(self):
        merged = omp_merge({'a': {'x': 1, 'y': [1, 2]}, 'l': [1]}, {'a': {'y': [3]}, 'l': [2], 'n': None})
        self.assertEqual(merged, {'a': {'x': 1, 'y': [3]}, 'l': [2], 'n': None}, 'mappings merge, lists and null replace')
        layer = project_layer({'modelRoles': {'smol': None, 'task': 'p/m', 'multi': ['p/a', 'p/b']}, 'retry': 'oops'})
        self.assertEqual(layer, {'modelRoles': {'task': 'p/m', 'multi': ['p/a', 'p/b']}},
                         'a null project role is no tombstone; a scalar in place of a settings group is ignored')
        global_data = {'modelRoles': {'smol': 'g/s', 'default': 'g/d'}, 'retry': {'fallbackChains': {'default': ['g/x']}}}
        full = effective(global_data, {'modelRoles': {'smol': None, 'task': 'p/t'}, 'retry': {'fallbackChains': {'task': []}}})
        self.assertEqual(full['modelRoles'], {'smol': 'g/s', 'default': 'g/d', 'task': 'p/t'})
        self.assertEqual(full['retry']['fallbackChains'], {'default': ['g/x'], 'task': []})
        self.assertEqual(sources(global_data, {'modelRoles': {'task': 'p/t', 'smol': None}, 'disabledProviders': []}),
            {'modelRoles.task': 'project', 'disabledProviders': 'project', 'modelRoles.smol': 'global',
             'modelRoles.default': 'global', 'retry.fallbackChains.default': 'global'})

    def test_snapshot_shows_scope_inheritance_and_sources(self):
        one = self.apps['one']
        state = one.snapshot()
        self.assertEqual(state['scope']['kind'], 'project')
        self.assertEqual(state['scope']['parent'], 'global')
        self.assertEqual(state['scope']['storage'], 'project')
        self.assertEqual(state['inherited']['modelRoles'], {'default': 'paid/big', 'smol': 'paid/deepseek-v4'})
        self.assertEqual(state['sources']['modelRoles.task'], 'project')
        self.assertEqual(state['sources']['modelRoles.default'], 'global')
        self.assertEqual(one.ui['roleLabels'], {'default': 'Boss', 'task': 'Worker'}, 'ui resolves Global → project')
        menu = [(r['id'], r['kind'], r['origin']) for r in state['projects']]
        self.assertEqual(menu[0], ('one', 'project', 'explicit'), 'explicit entries keep the default position')
        self.assertIn(('global', 'global', 'global'), menu)
        self.assertTrue(any(kind == 'project' and origin == 'sessions' for _, kind, origin in menu))
        glob = self.apps['global'].snapshot()
        self.assertIsNone(glob['inherited'])
        self.assertEqual(glob['scope']['kind'], 'global')

    def test_project_save_compiles_against_global_and_writes_only_overrides(self):
        one, before_global = self.apps['one'], (self.agent / 'config.yml').read_bytes()
        before = (self.one / '.omp/config.yml').read_bytes()
        self.save(one)  # Nothing changed: nothing written, the Global file never touched.
        self.assertEqual((self.one / '.omp/config.yml').read_bytes(), before)
        # DeepSeek OFF reaches the role the project inherits from Global: the project gets the override.
        self.save(one, settings={'mode': 'no-deepseek', 'alternatives': ['paid/small'], 'overrides': {}})
        written = self.read(self.one / '.omp/config.yml')
        self.assertEqual(written['modelRoles']['smol'], 'paid/small')
        self.assertNotIn('default', written['modelRoles'], 'an inherited value that does not change is not copied')
        self.assertEqual((self.agent / 'config.yml').read_bytes(), before_global)

    def test_reset_and_promote(self):
        one, glob = self.apps['one'], self.apps['global']
        result = one.scope_action({'action': 'promote', 'revision': one.revision('standard'), 'paths': [['modelRoles', 'task']]})
        self.assertTrue(result['ok'])
        self.assertEqual(self.read(self.agent / 'config.yml')['modelRoles']['task'], 'paid/small')
        self.assertIn('# global comment', (self.agent / 'config.yml').read_text())
        self.assertNotIn('task', self.read(self.one / '.omp/config.yml').get('modelRoles', {}))
        self.assertFalse(one.machine.journal.exists())
        with self.assertRaises(Problem) as error:
            one.scope_action({'action': 'promote', 'revision': one.revision('standard'), 'paths': [['modelRoles', 'task']]})
        self.assertEqual(error.exception.status, 422, 'only an own project value can move')
        self.save(one, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/small'}])
        one.scope_action({'action': 'reset', 'revision': one.revision('standard'), 'paths': [['modelRoles', 'plan']]})
        self.assertNotIn('plan', self.read(self.one / '.omp/config.yml').get('modelRoles', {}))
        # OMP rewriting a Global key Mana Tape does not manage (theme) is no conflict: promote goes on and keeps it.
        self.save(one, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/small'}])
        self.save(glob, changes=[{'path': ['modelRoles', 'vision'], 'value': 'paid/big'}])
        text = (self.agent / 'config.yml').read_text()
        revision = one.revision('standard')
        (self.agent / 'config.yml').write_text(text.replace('dark: titanium', 'dark: night'))
        self.assertEqual(one.revision('standard'), revision, 'a Global theme edit does not invalidate project drafts')
        self.assertEqual(glob.mode_conflicts(), [])
        one.scope_action({'action': 'promote', 'revision': one.revision('standard'), 'paths': [['modelRoles', 'plan']]})
        self.assertEqual(self.read(self.agent / 'config.yml')['theme']['dark'], 'night')
        self.assertEqual(self.read(self.agent / 'config.yml')['modelRoles']['plan'], 'paid/small')
        # An outside edit of a value Mana Tape manages blocks the move, names the scope and file, and what changed.
        self.save(one, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/big'}])
        text = (self.agent / 'config.yml').read_text()
        (self.agent / 'config.yml').write_text(text.replace('vision: paid/big', 'vision: paid/q3'))
        with self.assertRaises(Problem) as error:
            one.scope_action({'action': 'promote', 'revision': one.revision('standard'), 'paths': [['modelRoles', 'plan']]})
        self.assertEqual(error.exception.code, 'mode-conflict')
        self.assertEqual(error.exception.details['scope'], 'global')
        self.assertIn('Глобальна область', str(error.exception))
        self.assertIn('agent/config.yml', str(error.exception))
        self.assertEqual(error.exception.details['diffs']['standard']['lines'], ['~ modelRoles.vision: paid/big → paid/q3'])
        self.assertIn('plan', self.read(self.one / '.omp/config.yml')['modelRoles'])
        with self.assertRaises(Problem):
            glob.scope_action({'action': 'reset', 'revision': glob.revision('standard'), 'paths': [['modelRoles', 'default']]})

    def test_discovery_reads_session_headers_not_folder_names(self):
        rows = discover(self.agent, home=self.root / 'home-not-here')
        self.assertEqual(rows[self.two.resolve()]['status'], 'configured')
        self.assertEqual(rows[self.cand.resolve()]['status'], 'missing')
        self.assertEqual(rows[self.two.resolve()]['sessions'], 1)
        session(self.agent / 'sessions' / 'x', 'home.jsonl', self.root)
        session(self.agent / 'sessions' / 'x', 'gone.jsonl', self.root / 'gone')
        (self.agent / 'sessions' / 'x' / 'broken.jsonl').write_text('not json\n')
        rows = discover(self.agent, home=self.root)
        self.assertNotIn(self.root, rows, 'OMP has no project layer in the home directory')
        self.assertNotIn(self.root / 'gone', rows)
        roots = self.root / 'roots'
        child = roots / 'child'
        (child / '.omp').mkdir(parents=True)
        (child / '.omp/config.yml').write_text('{}\n')
        (roots / 'plain').mkdir()
        rows = discover(self.agent, [roots], home=self.root / 'h')
        self.assertEqual(rows[child.resolve()]['origin'], 'roots')
        self.assertNotIn((roots / 'plain').resolve(), rows, 'projectRoots add configured projects only')
        two = self.app(self.two)
        self.assertEqual(two.origin_kind, 'sessions')
        self.assertIs(two.parent, self.apps['global'])

    def test_configure_candidate_only_on_explicit_request(self):
        self.assertFalse((self.cand / '.omp').exists(), 'discovery never creates files')
        [candidate] = self.registry.candidate_list()
        self.assertEqual(candidate['status'], 'missing')
        with self.assertRaises(Problem) as error:
            self.apps['one'].scope_action({'action': 'configure', 'candidate': str(self.cand)})
        self.assertEqual(error.exception.status, 404, 'a path is never a candidate id')
        result = self.apps['one'].scope_action({'action': 'configure', 'candidate': candidate['id']})
        self.assertEqual(result['id'], candidate['id'])
        self.assertTrue((self.cand / '.omp/config.yml').is_file())
        self.assertEqual(self.read(self.cand / '.omp/config.yml'), {})
        app = self.apps[result['id']]
        self.assertEqual(app.parent, self.apps['global'])
        self.assertEqual(self.registry.candidate_list(), [])
        with self.assertRaises(Problem):
            self.apps['one'].scope_action({'action': 'configure', 'candidate': candidate['id']})
        self.save(app, changes=[{'path': ['modelRoles', 'task'], 'value': 'paid/big'}])
        self.assertEqual(self.read(self.cand / '.omp/config.yml')['modelRoles'], {'task': 'paid/big'})

    def test_machine_pools_update_every_scope_in_one_journal(self):
        one, two = self.apps['one'], self.app(self.two)
        self.assertIs(one.machine, two.machine)
        pools = {'free-good': ['gratis/a-free', 'gratis/b-free'], 'free-fast': []}
        one.save_pools({'revision': one.pools_revision(), 'pools': pools})
        self.assertEqual(two.pools(), pools, 'one pools editor for every scope')
        self.save(one, changes=[{'path': ['modelRoles', 'task'], 'value': 'mana-pool/free-good'}])
        self.save(two, changes=[{'path': ['modelRoles', 'plan'], 'value': 'mana-pool/free-good'}])
        self.assertEqual(sorted(one.snapshot()['poolScopes']), sorted([one.project_id, two.project_id]))
        swapped = {'free-good': ['gratis/b-free', 'gratis/a-free'], 'free-fast': []}
        result = two.save_pools({'revision': two.pools_revision(), 'pools': swapped})
        self.assertEqual(sorted(result['scopes']), sorted([one.project_id, two.project_id]))
        self.assertEqual(self.read(self.one / '.omp/config.yml')['modelRoles']['task'], 'gratis/b-free')
        self.assertEqual(self.read(self.two / '.omp/config.yml')['modelRoles']['plan'], 'gratis/b-free')
        self.assertEqual(json.loads(one.machine.pools_file.read_text())['pools'], swapped)
        # A failure after the first file rolls every scope back.
        files = {p: p.read_bytes() for p in (self.one / '.omp/config.yml', self.two / '.omp/config.yml', one.machine.pools_file)}
        real, calls = server.atomic, []
        def failing(path, data, mode=0o600):
            calls.append(path)
            if Path(path).name == 'config.yml' and sum(Path(c).name == 'config.yml' for c in calls) == 2:
                raise OSError(28, 'No space left on device')
            return real(path, data, mode)
        with patch('server.atomic', failing), self.assertRaises(OSError):
            one.save_pools({'revision': one.pools_revision(), 'pools': pools})
        self.assertEqual({p: p.read_bytes() for p in files}, files)
        self.assertFalse(one.machine.journal.exists())
        self.assertEqual(one.pools(), swapped)

    def test_pool_save_respects_outside_edits(self):
        one, two = self.apps['one'], self.app(self.two)
        pools = {'free-good': ['gratis/a-free', 'gratis/b-free'], 'free-fast': []}
        one.save_pools({'revision': one.pools_revision(), 'pools': pools})
        self.save(one, changes=[{'path': ['modelRoles', 'task'], 'value': 'mana-pool/free-good'}])
        self.save(two, changes=[{'path': ['modelRoles', 'plan'], 'value': 'mana-pool/free-good'}])
        path = self.two / '.omp/config.yml'
        path.write_text(path.read_text().replace('plan: gratis/a-free', 'plan: paid/q3'))
        before = {p: p.read_bytes() for p in (self.one / '.omp/config.yml', path)}
        with self.assertRaises(Problem) as error:
            one.save_pools({'revision': one.pools_revision(), 'pools': {'free-good': ['gratis/b-free'], 'free-fast': []}})
        self.assertEqual(error.exception.code, 'mode-conflict')
        self.assertEqual(error.exception.details['scopes'], {two.project_id: ['standard']})
        self.assertEqual(error.exception.details['diffs'][two.project_id]['standard']['lines'], ['~ modelRoles.plan: gratis/a-free → paid/q3'])
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assertEqual(one.pools(), pools)

    def test_native_preset_read_write(self):
        one = self.apps['one']
        result = one.profile_action({'action': 'clone', 'profile': 'standard', 'name': 'Night'})
        self.assertEqual(result['name'], 'preset:night')
        entry = self.read(self.one / '.omp/config.yml')['modelPresets']['night']
        self.assertEqual(entry['modelRoles'], {'default': 'paid/big', 'smol': 'paid/deepseek-v4', 'task': 'paid/small'},
                         'a preset keeps every role in effect, as OMP /modelpreset save does')
        state = one.snapshot()
        self.assertEqual(state['activePreset'], 'night')
        self.assertEqual(state['nativePresets']['night']['profile'], 'preset:night')
        self.assertIn('preset:night', state['presets'])
        self.assertIn('preset:night', state['revisions'])
        one.save_pools({'revision': one.pools_revision(), 'pools': {'free-good': ['gratis/a-free', 'gratis/b-free'], 'free-fast': []}})
        self.save(one, 'preset:night', [{'path': ['modelRoles', 'task'], 'value': 'mana-pool/free-good'},
                                        {'path': ['defaultThinkingLevel'], 'value': 'low'}],
                  {'mode': 'no-deepseek', 'alternatives': ['paid/q3'], 'overrides': {}})
        written = self.read(self.one / '.omp/config.yml')
        self.assertEqual(written['modelPresets']['night'], {'modelRoles': {'default': 'paid/big', 'smol': 'paid/q3', 'task': 'gratis/a-free'},
                         'defaultThinkingLevel': 'low'}, 'pool → first CUT, paid DeepSeek → replacement, per preset mode')
        self.assertNotIn('smol', written['modelRoles'], 'the scope file keeps its own DeepSeek mode')
        self.assertEqual(one.snapshot()['presets']['preset:night']['modelRoles']['task'], 'mana-pool/free-good')
        with self.assertRaises(Problem) as error:
            self.save(one, 'preset:night', [{'path': ['retry', 'fallbackChains', 'task'], 'value': ['paid/big']}])
        self.assertEqual(error.exception.code, 'preset-field')
        renamed = one.profile_action({'action': 'rename', 'profile': 'preset:night', 'name': 'late', 'revision': one.revision('preset:night')})
        self.assertEqual(renamed['name'], 'preset:late')
        self.assertEqual(one.preset_settings('late')['mode'], 'no-deepseek')
        one.profile_action({'action': 'restore', 'profile': 'preset:late', 'revision': one.revision('preset:late')})
        self.assertEqual(self.read(self.one / '.omp/config.yml')['modelPresets']['late']['modelRoles']['task'], 'paid/small')
        one.profile_action({'action': 'delete', 'profile': 'preset:late', 'revision': one.revision('preset:late')})
        self.assertNotIn('modelPresets', self.read(self.one / '.omp/config.yml'))
        self.assertTrue(any('-deleted-preset-late.json' in p.name for p in (one.state_dir / 'backups').iterdir()))
        with self.assertRaises(Problem):
            one.profile_action({'action': 'clone', 'profile': 'standard', 'name': '9lives'})

    def test_preset_visibility_and_active_detection(self):
        glob = {'modelPresets': {'fast': {'modelRoles': {'default': 'g/a'}}, 'both': {'modelRoles': {'default': 'g/b'}}}}
        proj = {'modelPresets': {'both': {'modelRoles': {'default': 'p/b'}}, 'gone': None, 'bad': {'modelRoles': {'x': ''}}}}
        presets = visible_presets(glob, proj)
        self.assertEqual(presets['both']['source'], 'project')
        self.assertTrue(presets['both']['shadows'])
        self.assertNotIn('gone', presets, 'null in the project layer is not a tombstone')
        self.assertIn('invalid', presets['bad'])
        self.assertEqual(active_preset({'modelRoles': {'default': 'p/b'}}, presets), 'both')
        self.assertIsNone(active_preset({'modelRoles': {'default': 'p/b', 'smol': 'x/y'}}, presets), 'role maps must match exactly')
        thinking = {'t': {'modelRoles': {'default': 'g/a'}, 'defaultThinkingLevel': 'low'}}
        self.assertIsNone(active_preset({'modelRoles': {'default': 'g/a'}}, thinking), 'default thinking level is high')

    def test_apply_preset_follows_model_role_storage(self):
        one, glob = self.apps['one'], self.apps['global']
        one.profile_action({'action': 'clone', 'profile': 'standard', 'name': 'night'})
        self.save(one, 'preset:night', [{'path': ['modelRoles', 'smol'], 'value': 'paid/q2'}, {'path': ['defaultThinkingLevel'], 'value': 'medium'}])
        self.save(one, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/big'}])
        result = one.profile_action({'action': 'apply-preset', 'preset': 'night', 'revision': one.revision('standard')})
        self.assertEqual(result['target'], 'one', 'modelRoleStorage: project stores roles in the project file')
        self.assertEqual(result['shadowed'], [])
        roles = self.read(self.one / '.omp/config.yml')['modelRoles']
        self.assertEqual(roles, {'task': 'paid/small', 'default': 'paid/big', 'smol': 'paid/q2'}, 'project roles not in the preset are cleared')
        self.assertEqual(self.read(self.agent / 'config.yml')['defaultThinkingLevel'], 'medium', 'OMP keeps the thinking level globally')
        self.assertEqual(one.snapshot()['activePreset'], 'night')
        # Global storage: the Global file takes the role map, project roles keep shadowing it.
        two = self.app(self.two)
        glob_presets = glob.profile_action({'action': 'clone', 'profile': 'standard', 'name': 'calm'})
        self.assertEqual(glob_presets['name'], 'preset:calm')
        self.save(glob, 'preset:calm', [{'path': ['modelRoles', 'plan'], 'value': 'paid/small'}])
        result = two.profile_action({'action': 'apply-preset', 'preset': 'calm', 'revision': two.revision('standard')})
        self.assertEqual(result['target'], 'global')
        self.assertEqual(result['shadowed'], ['plan'])
        self.assertEqual(self.read(self.agent / 'config.yml')['modelRoles']['plan'], 'paid/small')

    def test_legacy_preset_migration(self):
        three = self.project('three', {'modelRoles': {'default': 'paid/big', 'smol': 'gratis/a-free'},
            'retry': {'fallbackChains': {'smol': ['gratis/b-free', 'paid/q3', 'paid/small']}}})
        (three / '.omp/presets').mkdir()
        gpu = {'modelRoles': {'default': 'paid/big', 'smol': 'gratis/a-free'}, 'retry': {'fallbackChains': {'smol': ['gratis/b-free', 'paid/q2', 'paid/small']}}}
        (three / '.omp/presets/gpu.yml').write_text(yaml_dump(gpu))
        (three / '.omp/presets/fast.yml').write_text(yaml_dump({'modelRoles': {'default': 'paid/q2'},
            'retry': {'fallbackChains': {'default': ['paid/q3']}}, 'defaultThinkingLevel': 'low'}))
        self.cfg['projects'].append({'id': 'three', 'name': 'Three', 'path': 'three'})
        self.config.write_text(yaml_dump(self.cfg))
        _, apps = load_installation(self.config)
        app = apps['three']
        self.assertEqual(app.snapshot()['legacyPresets'], ['fast', 'gpu'])
        plan = app.profile_action({'action': 'migrate-plan', 'profile': 'gpu'})
        self.assertTrue(plan['sameAsStandard'])
        self.assertEqual(plan['lost'], ['~ retry.fallbackChains.smol: [2] paid/q3 → paid/q2'])
        self.assertFalse(plan['modelChains'][0]['exact'])
        with self.assertRaises(Problem) as error:
            app.profile_action({'action': 'migrate', 'profile': 'gpu', 'mode': 'roles', 'token': plan['token']})
        self.assertEqual(error.exception.code, 'migration-loss', 'nothing is dropped silently')
        before = (three / '.omp/config.yml').read_bytes()
        result = app.profile_action({'action': 'migrate', 'profile': 'gpu', 'mode': 'archive', 'token': plan['token']})
        self.assertEqual(result['mode'], 'archive')
        self.assertFalse((three / '.omp/presets/gpu.yml').exists())
        self.assertEqual((three / '.omp/config.yml').read_bytes(), before, 'archiving touches only the legacy file')
        backups = [p for p in (app.state_dir / 'backups').iterdir() if p.name.endswith('-migrated-gpu.yml')]
        self.assertEqual(yaml_load(backups[0].read_text()), gpu)
        plan = app.profile_action({'action': 'migrate-plan', 'profile': 'fast'})
        self.assertEqual(plan['thinking'], 'low')
        self.assertTrue(plan['modelChains'][0]['exact'], 'a primary only this preset uses can key a model chain')
        self.assertEqual(plan['modelChains'][0]['selector'], 'paid/q2')
        with self.assertRaises(Problem):
            app.profile_action({'action': 'migrate', 'profile': 'fast', 'mode': 'roles', 'token': 'stale', 'acceptLoss': True})
        app.profile_action({'action': 'migrate', 'profile': 'fast', 'mode': 'model-chains', 'token': plan['token'], 'acceptLoss': True})
        written = self.read(three / '.omp/config.yml')
        self.assertEqual(written['modelPresets']['fast'], {'modelRoles': {'default': 'paid/q2', 'smol': 'gratis/a-free'}, 'defaultThinkingLevel': 'low'})
        self.assertEqual(written['retry']['fallbackChains']['paid/q2'], ['paid/q3'])
        self.assertEqual(app.snapshot()['legacyPresets'], [])
        self.assertEqual(app.snapshot()['modelChains'], ['paid/q2'])

    def test_conflict_diff_payload(self):
        one = self.apps['one']
        self.save(one, changes=[{'path': ['modelRoles', 'task'], 'value': 'paid/big'}])
        path = self.one / '.omp/config.yml'
        data = self.read(path)
        data['modelRoles']['task'] = 'paid/q3'
        data['modelRoles'].update({f'r{i}': 'paid/q2' for i in range(8)})
        data['newKey'] = {'a': 1}
        path.write_text(yaml_dump(data))
        diff = one.snapshot()['modeConflictDiffs']['standard']
        self.assertEqual(diff['file'], '.omp/config.yml')
        self.assertFalse(diff['approximate'])
        self.assertEqual(len(diff['lines']), 6)
        self.assertIn('~ modelRoles.task: paid/big → paid/q3', diff['lines'])
        self.assertTrue(diff['lines'][-1].startswith('… ще '))
        self.assertEqual(short_diff({'a': [1, 2]}, {'a': [2, 1]}), ['~ a: порядок змінено (2)'])
        self.assertEqual(short_diff({'k': 'x'}, {}), ['− k'])
        record = one.mode_state['profiles']['standard']
        record.pop('written')
        self.assertTrue(one.conflict_diffs()['standard']['approximate'], 'older records compare with the logical version')

    # ---- installation compatibility and state migration ---------------------------------------------------------

    def test_old_installation_with_user_scope(self):
        (self.root / 'state/mac').mkdir(parents=True)
        (self.root / 'state/mac/state.json').write_text(json.dumps({'managed': {}, 'catalog': {}, 'available': [], 'changes': [],
            'favs': ['paid/big'], 'refreshed': 0, 'error': '', 'backups': {}, 'attempted': 0}))
        cfg = {'state': 'state', 'agent': 'agent', 'omp': '/x', 'projects': [{'id': 'mac', 'name': 'Mac · OMP', 'scope': 'user',
               'ui': {'providerLabels': {'paid': 'PAID'}}}]}
        self.config.write_text(yaml_dump(cfg))
        _, apps = load_installation(self.config)
        glob = apps['mac']
        self.assertEqual(glob.kind, 'global')
        self.assertEqual(glob.state_dir, self.root / 'state/mac')
        self.assertEqual(glob.state['favs'], ['paid/big'], 'the existing state directory is kept')
        self.assertIs(glob.installation.resolve('global'), glob, '?project=global still works')
        self.assertEqual(glob.installation.menu()[0]['id'], 'mac')
        project = self.app(self.two) if False else next(a for a in apps.values() if a.kind == 'project' and a.project == self.two)
        self.assertEqual(project.ui, {'providerLabels': {'paid': 'PAID'}})
        # No installation.yml at all: Global plus discovered projects.
        _, apps = load_installation(None, {'agent': str(self.agent), 'state': str(self.root / 'state2'), 'omp': '/x'})
        kinds = sorted(a.kind for a in apps.values())
        self.assertEqual(kinds, ['global', 'project'])
        self.assertTrue((self.root / 'state2/scopes.json').is_file())
        cfg['projects'].append({'id': 'mac2', 'scope': 'user'})
        self.config.write_text(yaml_dump(cfg))
        with self.assertRaises(ValueError):
            load_installation(self.config)

    def test_state_and_pool_migration_from_older_installations(self):
        legacy = self.root / 'state/old-name'
        legacy.mkdir(parents=True)
        (legacy / 'state.json').write_text(json.dumps({'backups': {str(self.cand / '.omp/config.yml'): 'x'}}))
        pools = {'free-good': ['gratis/a-free'], 'free-fast': ['gratis/b-free']}
        (legacy / 'profile-modes.json').write_text(json.dumps({'profiles': {}, 'pools': pools}))
        (self.root / 'state/registries').mkdir(exist_ok=True)
        for p in (self.root / 'state/registries').glob('*/pools.json'):
            p.unlink()
        (self.root / 'state/scopes.json').unlink()
        _, apps = load_installation(self.config)
        registry = apps['one'].installation
        self.assertEqual(registry.candidate_list()[0]['id'], 'old-name', 'a legacy state directory keeps its project')
        self.assertEqual(apps['one'].pools(), pools)
        self.assertEqual(json.loads(apps['one'].machine.pools_file.read_text())['migratedFrom'], ['old-name'])
        index = (self.root / 'state/scopes.json').read_bytes()
        _, again = load_installation(self.config)
        self.assertEqual(again['one'].pools(), pools)
        self.assertEqual((self.root / 'state/scopes.json').read_bytes(), index, 'migration is idempotent')
        result = again['one'].scope_action({'action': 'configure', 'candidate': 'old-name'})
        self.assertEqual(again[result['id']].state_dir, legacy)
        # Two different legacy pool sets: nothing is chosen silently.
        other = self.root / 'state/two-old'
        other.mkdir()
        (other / 'state.json').write_text(json.dumps({'backups': {str(self.root / 'four/.omp/config.yml'): 'x'}}))
        (other / 'profile-modes.json').write_text(json.dumps({'profiles': {}, 'pools': {'free-good': ['gratis/b-free'], 'free-fast': []}}))
        for p in (self.root / 'state/registries').glob('*/pools.json'):
            p.unlink()
        _, apps = load_installation(self.config)
        conflict = apps['one'].snapshot()['poolConflict']
        self.assertEqual(sorted(s for row in conflict for s in row['sources']), ['old-name', 'two-old'])
        with self.assertRaises(Problem) as error:
            apps['one'].save_pools({'revision': apps['one'].pools_revision(), 'pools': pools})
        self.assertEqual(error.exception.code, 'pools-conflict')
        apps['one'].save_pools({'action': 'adopt-legacy', 'source': 'two-old'})
        self.assertEqual(apps['one'].pools(), {'free-good': ['gratis/b-free'], 'free-fast': []})

    def test_interrupted_cross_scope_journal_is_resolved_at_start(self):
        one = self.apps['one']
        machine = one.machine
        config = self.one / '.omp/config.yml'
        before = config.read_text()
        after = before.replace('paid/small', 'paid/q3')
        # Every file reached its new state, the metadata did not: the next start finishes the write.
        config.write_text(after)
        machine.journal.write_text(json.dumps({'files': {str(config): {'before': before, 'after': after, 'label': 'one/standard'}},
            'states': {str(one.mode_file): {'before': None, 'after': json.dumps({'profiles': {'x': {}}})}}}))
        _, apps = load_installation(self.config)
        self.assertEqual(config.read_text(), after)
        self.assertFalse(machine.journal.exists())
        self.assertIn('x', apps['one'].mode_state['profiles'])
        # Only one of two scopes was written: it is rolled back, and so is the metadata.
        other = self.two / '.omp/config.yml'
        two_text = other.read_text()
        state = one.mode_file.read_text()
        config.write_text(before)
        machine.journal.write_text(json.dumps({'files': {
                str(config): {'before': after, 'after': before, 'label': 'one/standard'},
                str(other): {'before': two_text, 'after': two_text + 'x: 1\n', 'label': 'two/standard'}},
            'states': {str(one.mode_file): {'before': state, 'after': json.dumps({'profiles': {}})}}}))
        _, apps = load_installation(self.config)
        self.assertEqual((config.read_text(), other.read_text()), (after, two_text))
        self.assertIn('x', apps['one'].mode_state['profiles'])
        before = after
        # A file changed by someone else meanwhile is never overwritten: start read-only, writes refused.
        machine.journal.write_text(json.dumps({'files': {str(config): {'before': 'a: 1\n', 'after': 'a: 2\n', 'label': 'one/standard'}},
            'states': {}}))
        _, apps = load_installation(self.config)
        self.assertEqual(config.read_text(), before)
        self.assertEqual(apps['one'].snapshot()['modeRecovery']['files'], ['one/standard'])
        with self.assertRaises(Problem) as error:
            self.save(apps['one'], changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/big'}])
        self.assertEqual(error.exception.code, 'mode-recovery')

    def test_http_scope_selection_and_actions(self):
        srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        srv.app, srv.apps, srv.registry = self.registry.default(), self.apps, self.registry
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        def request(method, path, body=None):
            c = http.client.HTTPConnection('127.0.0.1', srv.server_port)
            c.request(method, path, json.dumps(body) if body is not None else None,
                      {'Content-Type': 'application/json', 'X-Forge-CSRF': srv.app.csrf})
            r = c.getresponse(); result = (r.status, json.loads(r.read())); c.close(); return result
        status, state = request('GET', '/api/state?project=global')
        self.assertEqual((status, state['scope']['kind']), (200, 'global'))
        status, state = request('GET', '/api/state')
        self.assertEqual(state['projectId'], 'one')
        [candidate] = state['candidates']
        status, result = request('POST', '/api/scope-action?project=one', {'action': 'configure', 'candidate': candidate['id'], 'path': '/etc'})
        self.assertEqual(status, 200)
        status, state = request('GET', '/api/state?project=' + result['id'])
        self.assertEqual((status, state['scope']['origin']), (200, 'configured'))
        self.assertEqual(request('POST', '/api/scope-action?project=one', {'action': 'configure', 'candidate': '/etc'})[0], 404)


    # ---- review fixes (layers-review.md) -------------------------------------------------------------------------

    OFF = {'mode': 'no-deepseek', 'alternatives': ['paid/small'], 'overrides': {}}

    def test_symlinked_global_is_read_only_and_projects_keep_working(self):
        """H1: a Global config managed through dotfiles is read through the link; only writes to it are refused."""
        dotfiles = self.root / 'dotfiles'
        dotfiles.mkdir()
        target = dotfiles / 'omp-config.yml'
        target.write_bytes((self.agent / 'config.yml').read_bytes())
        (self.agent / 'config.yml').unlink()
        (self.agent / 'config.yml').symlink_to(target)
        _, apps = load_installation(self.config)
        one, glob = apps['one'], apps['global']
        state = one.snapshot()
        self.assertEqual(state['inherited']['modelRoles']['default'], 'paid/big', 'the project still inherits through the link')
        self.assertEqual(state['scope']['globalReadOnly']['code'], 'symlink')
        self.assertIsNone(state['scope']['readOnly'])
        gstate = glob.snapshot()
        self.assertEqual(gstate['scope']['readOnly']['code'], 'symlink')
        self.assertIn('agent/config.yml', gstate['scope']['readOnly']['error'])
        before = target.read_bytes()
        self.save(one, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/big'}])
        self.assertEqual(self.read(self.one / '.omp/config.yml')['modelRoles']['plan'], 'paid/big', 'project writes go on')
        with self.assertRaises(Problem) as error:
            self.save(glob, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/big'}])
        self.assertEqual((error.exception.status, error.exception.code), (409, 'symlink'))
        self.assertIn('Глобальна область', str(error.exception))
        with self.assertRaises(Problem) as error:
            one.scope_action({'action': 'promote', 'revision': one.revision('standard'), 'paths': [['modelRoles', 'plan']]})
        self.assertEqual(error.exception.code, 'symlink')
        self.assertTrue((self.agent / 'config.yml').is_symlink())
        self.assertEqual(target.read_bytes(), before, 'nothing is written through the link')

    def test_native_presets_keep_the_providers_they_use(self):
        """H2: a provider only a котушка uses (project or Global) is never expired or deleted."""
        one, glob = self.apps['one'], self.apps['global']
        models = self.agent / 'models.yml'
        data = yaml_load(models.read_text())
        for pid in ('temp', 'gtemp'):
            data['providers'][pid] = {'api': 'openai-completions', 'baseUrl': 'https://example.invalid/v1', 'auth': 'none',
                                      'models': [{'id': 'x', 'name': 'X', 'input': ['text'], 'cost': {'input': 1, 'output': 1}}]}
        models.write_text(yaml_dump(data))
        one.profile_action({'action': 'clone', 'profile': 'standard', 'name': 'tp'})
        self.save(one, 'preset:tp', [{'path': ['modelRoles', 'smol'], 'value': 'temp/x'}])
        glob.profile_action({'action': 'clone', 'profile': 'standard', 'name': 'gp'})
        self.save(glob, 'preset:gp', [{'path': ['modelRoles', 'plan'], 'value': 'gtemp/x'}])
        refs = one.registry_refs()
        self.assertIn('one/preset:tp', refs['temp/x'])
        self.assertIn('global/preset:gp', refs['gtemp/x'])
        current = yaml_load(models.read_text())['providers']
        for pid in ('temp', 'gtemp'):
            one.managed[pid] = {'expires': 1, 'expired': False, 'fingerprint': server.fingerprint(current[pid])}
        one.expire()
        providers = yaml_load(models.read_text())['providers']
        self.assertIn('temp', providers)
        self.assertIn('gtemp', providers)
        self.assertEqual(one.managed['temp']['expiryReason'], 'used')
        with self.assertRaises(Problem) as error:
            one.provider_save({'id': 'gtemp', 'action': 'delete', 'revision': digest(models.read_bytes())})
        self.assertIn('global/preset:gp', str(error.exception))
        self.assertIn('preset:tp', next(m for m in one.snapshot()['models'] if m['provider'] == 'temp')['usedBy'])

    def test_candidate_ids_and_state_etag_stay_stable_across_rescans(self):
        """H3: the id the panel got still configures the candidate after any number of rescans; no ETag churn."""
        srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        srv.app, srv.apps, srv.registry = self.registry.default(), self.apps, self.registry
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        def state():
            c = http.client.HTTPConnection('127.0.0.1', srv.server_port)
            c.request('GET', '/api/state', headers={'Content-Type': 'application/json'})
            r = c.getresponse(); body = json.loads(r.read()); tag = r.getheader('ETag'); c.close()
            return body, tag
        first, tag = state()
        ids = []
        for _ in range(4):
            self.registry.rescan(force=True)
            body, again = state()
            ids.append([c['id'] for c in body['candidates']])
            self.assertEqual(again, tag, 'nothing changed: the same ETag')
        self.assertEqual(ids, [[c['id'] for c in first['candidates']]] * 4)
        result = self.apps['one'].scope_action({'action': 'configure', 'candidate': first['candidates'][0]['id']})
        self.assertEqual(result['id'], first['candidates'][0]['id'])

    def test_apply_preset_writes_exactly_what_modelpreset_switch_writes(self):
        """H4: role models (and thinking) where modelRoleStorage says; no chains; DeepSeek modes well defined."""
        one, two, glob = self.apps['one'], self.app(self.two), self.apps['global']
        one.save_pools({'revision': one.pools_revision(), 'pools': {'free-good': ['gratis/a-free', 'gratis/b-free'], 'free-fast': []}})
        # (a) A pool role in the котушка: Global (storage global) takes its first CUT, and no chain appears anywhere.
        two.profile_action({'action': 'clone', 'profile': 'standard', 'name': 'calm'})
        self.save(two, 'preset:calm', [{'path': ['modelRoles', 'smol'], 'value': 'mana-pool/free-good'}])
        written = self.read(self.two / '.omp/config.yml')['modelPresets']['calm']['modelRoles']
        chains = self.read(self.agent / 'config.yml')['retry']['fallbackChains']
        preview = two.profile_action({'action': 'apply-preset', 'preset': 'calm', 'revision': two.revision('standard'), 'dry': True})
        self.assertEqual((preview['dry'], preview['target'], preview['derived']), (True, 'global', {}))
        self.assertEqual(preview['files']['global/standard']['file'], 'agent/config.yml')
        result = two.profile_action({'action': 'apply-preset', 'preset': 'calm', 'revision': two.revision('standard')})
        self.assertEqual((result['target'], result['shadowed'], result['unchanged']), ('global', [], False))
        g = self.read(self.agent / 'config.yml')
        self.assertEqual(g['modelRoles'], written, 'Global roles are exactly the котушка as written (the pool as its first CUT)')
        self.assertEqual(g['retry']['fallbackChains'], chains, 'switch never adds or changes chains')
        self.assertEqual(two.snapshot()['activePreset'], 'calm')
        again = two.profile_action({'action': 'apply-preset', 'preset': 'calm', 'revision': two.revision('standard')})
        self.assertTrue(again['unchanged'], 'an active котушка needs no write')
        # (b) Project storage, project in DeepSeek OFF: a котушка running paid DeepSeek is refused, nothing written.
        self.save(one, settings=self.OFF)
        one.profile_action({'action': 'clone', 'profile': 'standard', 'name': 'ds'})
        self.save(one, 'preset:ds', [{'path': ['modelRoles', 'smol'], 'value': 'paid/deepseek-v4'}],
                  {'mode': 'deepseek', 'alternatives': [], 'overrides': {}})
        before = (self.one / '.omp/config.yml').read_bytes()
        with self.assertRaises(Problem) as error:
            one.profile_action({'action': 'apply-preset', 'preset': 'ds', 'revision': one.revision('standard')})
        self.assertEqual((error.exception.code, error.exception.details['roles']), ('deepseek-mode', ['smol']))
        self.assertEqual((self.one / '.omp/config.yml').read_bytes(), before)
        # (c) The same котушка in OFF writes its replacement; OMP then calls it active, and nothing drifts afterwards.
        self.save(one, 'preset:ds', [], self.OFF)
        roles = self.read(self.one / '.omp/config.yml')['modelPresets']['ds']['modelRoles']
        self.assertEqual(roles['smol'], 'paid/small')
        body = {'action': 'apply-preset', 'preset': 'ds', 'revision': one.revision('standard')}
        dry = one.profile_action({**body, 'dry': True})
        # OFF dedups the new smol primary from its inherited reserve: a chain change beyond switch, so it is confirmed.
        self.assertEqual(dry['derived']['one/standard']['lines'], ['+ retry.fallbackChains.smol: []'])
        result = one.profile_action({**body, 'confirm': dry['token']})
        self.assertEqual((result['target'], result['fromGlobal']), ('one', []))
        self.assertEqual(self.read(self.one / '.omp/config.yml')['modelRoles'], roles)
        self.assertEqual(one.snapshot()['activePreset'], 'ds')
        settled = (self.one / '.omp/config.yml').read_bytes()
        self.save(one, changes=[])
        self.assertEqual((self.one / '.omp/config.yml').read_bytes(), settled, 'a save with nothing changed writes nothing')
        # (d) A Global role the котушка does not name, reached by OFF: shown and confirmed, never silent.
        self.save(glob, changes=[{'path': ['modelRoles', 'commit'], 'value': 'paid/deepseek-v4'}])
        self.save(one, changes=[{'path': ['modelRoles', 'smol'], 'value': 'paid/big'}], confirm=True)
        body = {'action': 'apply-preset', 'preset': 'ds', 'revision': one.revision('standard')}
        dry = one.profile_action({**body, 'dry': True})
        self.assertEqual(dry['fromGlobal'], ['commit'])
        self.assertEqual(dry['derived']['one/standard']['lines'], ['+ retry.fallbackChains.smol: []'])
        with self.assertRaises(Problem) as error:
            one.profile_action(body)
        self.assertEqual(error.exception.code, 'derived')
        one.profile_action({**body, 'confirm': dry['token']})
        self.assertEqual(self.read(self.one / '.omp/config.yml')['modelRoles']['smol'], 'paid/small')
        self.assertEqual(self.read(self.one / '.omp/config.yml')['modelRoles']['commit'], 'paid/small', 'OFF still replaces Global commit')
        self.assertIsNone(one.snapshot()['activePreset'], 'Global commit still shows through: OMP would not call it active either')

    def test_first_write_shows_what_it_also_changes(self):
        """M1: a write that would also add overrides nobody asked for (OFF reaching a Global role) needs a confirmation."""
        one, glob = self.apps['one'], self.apps['global']
        self.save(one, settings=self.OFF)
        self.save(glob, changes=[{'path': ['modelRoles', 'commit'], 'value': 'paid/deepseek-v4'}])
        before = (self.one / '.omp/config.yml').read_bytes()
        body = {'profile': 'standard', 'revision': one.revision('standard'), 'changes': [{'path': ['modelRoles', 'plan'], 'value': 'paid/big'}],
                'modeSettings': one.mode_settings('standard')}
        body['previewToken'] = one.preview_profile(body)['token']
        with self.assertRaises(Problem) as error:
            one.save_profile(body)
        self.assertEqual((error.exception.status, error.exception.code), (409, 'derived'))
        derived = error.exception.details['derived']['one/standard']
        self.assertEqual(derived['file'], '.omp/config.yml')
        self.assertIn('+ modelRoles.commit: paid/small', derived['lines'])
        self.assertFalse(any('plan' in line for line in derived['lines']), 'the owner\'s own change is not listed')
        self.assertEqual((self.one / '.omp/config.yml').read_bytes(), before)
        with self.assertRaises(Problem):
            one.save_profile({**body, 'confirm': 'stale'})
        one.save_profile({**body, 'confirm': error.exception.details['token']})
        written = self.read(self.one / '.omp/config.yml')
        self.assertEqual((written['modelRoles']['plan'], written['modelRoles']['commit']), ('paid/big', 'paid/small'))
        # Server actions preview the same way: reset, then promote (dry run lists both files).
        self.save(glob, changes=[{'path': ['modelRoles', 'slow'], 'value': 'paid/deepseek-v4'}])
        with self.assertRaises(Problem) as error:
            one.scope_action({'action': 'reset', 'revision': one.revision('standard'), 'paths': [['modelRoles', 'plan']]})
        self.assertEqual(error.exception.code, 'derived')
        self.assertIn('+ modelRoles.slow: paid/small', error.exception.details['derived']['one/standard']['lines'])
        self.act(one.scope_action, {'action': 'reset', 'revision': one.revision('standard'), 'paths': [['modelRoles', 'plan']]})
        self.save(one, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/q3'}])
        dry = one.scope_action({'action': 'promote', 'revision': one.revision('standard'), 'paths': [['modelRoles', 'plan']], 'dry': True})
        self.assertEqual(sorted(dry['files']), ['global/standard', 'one/standard'])
        self.assertIn('+ modelRoles.plan: paid/q3', dry['files']['global/standard']['lines'])
        self.assertEqual(dry['derived'], {})
        self.assertNotIn('plan', self.read(self.agent / 'config.yml')['modelRoles'], 'a dry run writes nothing')

    def test_migration_plan_names_derived_changes(self):
        """M1 on silent: archiving a legacy котушка previews what the scope file also gains, and needs it confirmed."""
        one, glob = self.apps['one'], self.apps['global']
        self.save(one, settings=self.OFF)
        self.save(glob, changes=[{'path': ['modelRoles', 'commit'], 'value': 'paid/deepseek-v4'}])
        (self.one / '.omp/presets').mkdir()
        (self.one / '.omp/presets/gpu.yml').write_text(yaml_dump({'modelRoles': {'task': 'paid/small'}}))
        before = (self.one / '.omp/config.yml').read_bytes()
        plan = one.profile_action({'action': 'migrate-plan', 'profile': 'gpu'})
        self.assertIn('+ modelRoles.commit: paid/small', plan['derived']['one/standard']['lines'])
        with self.assertRaises(Problem) as error:
            one.profile_action({'action': 'migrate', 'profile': 'gpu', 'mode': 'archive', 'token': plan['token']})
        self.assertEqual(error.exception.code, 'derived')
        self.assertTrue((self.one / '.omp/presets/gpu.yml').exists())
        self.assertEqual((self.one / '.omp/config.yml').read_bytes(), before)
        one.profile_action({'action': 'migrate', 'profile': 'gpu', 'mode': 'archive', 'token': plan['token'], 'confirm': plan['derivedToken']})
        self.assertFalse((self.one / '.omp/presets/gpu.yml').exists())
        # F1: asking again is a clear 404, not a YAML error.
        for action in ({'action': 'migrate-plan', 'profile': 'gpu'}, {'action': 'migrate', 'profile': 'gpu', 'mode': 'archive', 'token': plan['token']}):
            with self.assertRaises(Problem) as error:
                one.profile_action(action)
            self.assertEqual(error.exception.status, 404)

    def test_outside_edits_outside_managed_keys_are_no_conflict(self):
        """M2: OMP rewriting theme, thinking level or comments never blocks; the next write keeps those edits."""
        one, glob = self.apps['one'], self.apps['global']
        self.save(glob, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/big'}])
        path = self.agent / 'config.yml'
        data = self.read(path)
        data['defaultThinkingLevel'] = 'low'
        data['theme'] = {'dark': 'night'}
        path.write_text('# owner note\n' + yaml_dump(data))
        self.assertEqual(glob.mode_conflicts(), [])
        self.assertEqual(glob.snapshot()['modeConflictDiffs'], {})
        one_revision = one.revision('standard')
        self.save(glob, changes=[{'path': ['modelRoles', 'vision'], 'value': 'paid/big'}])
        self.assertEqual(one.revision('standard') != one_revision, True, 'a managed Global change does move project revisions')
        text = path.read_text()
        self.assertIn('# owner note', text)
        written = self.read(path)
        self.assertEqual((written['defaultThinkingLevel'], written['theme'], written['modelRoles']['vision']), ('low', {'dark': 'night'}, 'paid/big'))
        self.assertEqual(glob.mode_conflicts(), [])

    def test_older_records_get_exact_diffs(self):
        """M3: a record without `written` is backfilled at start; one already out of sync compares with its compile."""
        one = self.apps['one']
        one.save_pools({'revision': one.pools_revision(), 'pools': {'free-good': ['gratis/a-free', 'gratis/b-free'], 'free-fast': []}})
        self.save(one, changes=[{'path': ['retry', 'fallbackChains', 'task'], 'value': ['mana-pool/free-good']}])
        records = json.loads(one.mode_file.read_text())
        records['profiles']['standard'].pop('written')
        one.mode_file.write_text(json.dumps(records))
        _, apps = load_installation(self.config)
        self.assertIn('written', apps['one'].mode_state['profiles']['standard'], 'in sync: backfilled at start')
        _, again = load_installation(self.config)
        self.assertEqual(again['one'].mode_file.read_text(), apps['one'].mode_file.read_text(), 'once')
        records = json.loads(one.mode_file.read_text())
        records['profiles']['standard'].pop('written')
        one.mode_file.write_text(json.dumps(records))
        path = self.one / '.omp/config.yml'
        path.write_text(path.read_text().replace('task: paid/small', 'task: paid/q3'))
        _, apps = load_installation(self.config)
        diff = apps['one'].snapshot()['modeConflictDiffs']['standard']
        self.assertTrue(diff['approximate'])
        self.assertEqual(diff['lines'], ['~ modelRoles.task: paid/small → paid/q3'], 'no pool-expansion noise')

    def test_one_catalogue_and_telemetry_loop_per_agent_directory(self):
        """M4: every scope of an agent directory shares the lead's catalogue, refresh and insights."""
        one, glob, two = self.apps['one'], self.apps['global'], self.app(self.two)
        self.assertIs(one.machine.lead, one, 'the first explicit entry leads (it has the older state)')
        self.assertIs(glob.catalog_owner, one)
        self.assertIs(two.insights, one.insights)
        one.cat['catalog']['paid/new'] = {'provider': 'paid', 'id': 'new', 'name': 'New'}
        self.assertIn('paid/new', glob.mode_catalog())
        with patch.object(Forge, 'refresh', autospec=True) as refresh:
            glob.maintain_once()
        self.assertEqual([call.args[0] for call in refresh.call_args_list], [one] * len(refresh.call_args_list))
        result = self.apps['one'].scope_action({'action': 'configure', 'candidate': self.registry.candidate_list()[0]['id']})
        self.assertIs(self.apps[result['id']].catalog_owner, one, 'a scope found later joins the same loop')
        # main() starts the refresh and telemetry loops only for scopes without a catalogue owner.
        self.assertEqual([a for a in self.apps.values() if a.catalog_owner is None], [one])

    def test_adopting_legacy_pools_recompiles_every_scope(self):
        """M9: choosing one of two legacy pool sets rewrites the scopes compiled from the other one, in one journal."""
        one, two = self.apps['one'], self.app(self.two)
        first = {'free-good': ['gratis/a-free', 'gratis/b-free'], 'free-fast': []}
        one.save_pools({'revision': one.pools_revision(), 'pools': first})
        self.save(one, changes=[{'path': ['modelRoles', 'task'], 'value': 'mana-pool/free-good'}])
        self.save(two, changes=[{'path': ['modelRoles', 'plan'], 'value': 'mana-pool/free-good'}])
        # As if `two` had been compiled by an older installation with its own pools.
        second = {'free-good': ['gratis/b-free', 'gratis/a-free'], 'free-fast': []}
        two.mode_state['pools'] = second
        one.mode_state['pools'] = first
        for app in (one, two):
            app.mode_file.write_text(json.dumps(app.mode_state))
        machine = one.machine
        machine.pools_file.unlink()
        _, apps = load_installation(self.config)
        one, two = apps['one'], next(a for a in apps.values() if a.project == self.two.resolve())
        self.assertEqual(len(one.machine.pool_conflict), 2)
        result = one.save_pools({'action': 'adopt-legacy', 'source': two.project_id})
        self.assertEqual(one.pools(), second)
        self.assertEqual(self.read(self.one / '.omp/config.yml')['modelRoles']['task'], 'gratis/b-free', 'recompiled with the chosen set')
        self.assertIn('one', result['scopes'])
        self.assertEqual(json.loads(one.machine.pools_file.read_text())['migratedFrom'], [two.project_id])
        self.assertFalse(one.machine.journal.exists())

    def test_low_findings(self):
        one, glob = self.apps['one'], self.apps['global']
        path = self.agent / 'config.yml'
        # L1: legal but unusual Global shapes compile.
        data = self.read(path)
        data['modelRoles']['odd'] = None
        data['modelRoles']['multi'] = ['paid/small', 'paid/q3']
        data['retry']['fallbackChains']['plan'] = None
        path.write_text(yaml_dump(data))
        self.save(glob, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/big'}])
        self.save(one, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/big'}])
        written = self.read(path)
        self.assertEqual((written['modelRoles']['odd'], written['retry']['fallbackChains']['plan']), (None, None), 'kept as written')
        # L2: an unreadable Global file stops project writes instead of compiling against nothing.
        good = path.read_text()
        path.write_text('modelRoles: [unclosed\n')
        with self.assertRaises(Problem) as error:
            self.save(one, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/q3'}])
        self.assertEqual(error.exception.code, 'parent')
        path.write_text(good)
        # L3: Restore of a котушка toggles between the two last versions.
        one.profile_action({'action': 'clone', 'profile': 'standard', 'name': 'r1'})
        self.save(one, 'preset:r1', [{'path': ['modelRoles', 'smol'], 'value': 'paid/q2'}])
        def smol():
            return self.read(self.one / '.omp/config.yml')['modelPresets']['r1']['modelRoles']['smol']
        one.profile_action({'action': 'restore', 'profile': 'preset:r1', 'revision': one.revision('preset:r1')})
        self.assertEqual(smol(), 'paid/deepseek-v4')
        one.profile_action({'action': 'restore', 'profile': 'preset:r1', 'revision': one.revision('preset:r1')})
        self.assertEqual(smol(), 'paid/q2')
        # L4/L6: a NUL in a recorded cwd and system directories are no candidates; the rest are still found.
        folder = self.agent / 'sessions' / 'odd'
        session(folder, 'nul.jsonl', '/tmp/x\x00y')
        session(folder, 'tmp.jsonl', '/tmp')
        session(folder, 'root.jsonl', '/')
        rows = discover(self.agent, home=self.root / 'h')
        self.assertIn(self.cand.resolve(), rows)
        self.assertFalse({Path('/'), Path('/tmp').resolve()} & set(rows))
        # L5: a session header rewritten in place (a moved session) is read again.
        moved = self.agent / 'sessions' / '--misleading-name--' / 'b.jsonl'
        other = self.root / 'moved'
        other.mkdir()
        session(moved.parent, moved.name, other)
        self.assertIn(other.resolve(), discover(self.agent, home=self.root / 'h'))
        # L8: a configured project's .omp is group-readable like its file, whatever the umask.
        old = __import__('os').umask(0o077)
        try:
            _, apps = load_installation(self.config)
            [candidate] = [c for c in apps['one'].installation.candidate_list() if c['path'] == str(other.resolve())]
            apps['one'].scope_action({'action': 'configure', 'candidate': candidate['id']})
        finally:
            __import__('os').umask(old)
        self.assertEqual((other / '.omp').stat().st_mode & 0o777, 0o755)
        # L9: a project котушка named like a Global one says that it will hide it.
        apps['global'].profile_action({'action': 'clone', 'profile': 'standard', 'name': 'gpu'})
        (self.one / '.omp/presets').mkdir()
        (self.one / '.omp/presets/gpu.yml').write_text(yaml_dump({'modelRoles': {'task': 'paid/big'}}))
        _, apps = load_installation(self.config)
        self.assertTrue(apps['one'].profile_action({'action': 'migrate-plan', 'profile': 'gpu'})['shadowsGlobal'])
        # L11: OMP's order of котушки (localeCompare): case ignored first, lowercase first on a tie.
        names = list(visible_presets({'modelPresets': {n: {'modelRoles': {'default': 'p/m'}} for n in ('b', 'B', 'a_x', 'a-x', 'a1', 'A')}}))
        self.assertEqual(names, ['A', 'a_x', 'a-x', 'a1', 'b', 'B'])

    def test_missing_global_file_is_never_created_empty(self):
        """L7: a write with nothing for the Global file leaves an absent Global file absent."""
        path = self.agent / 'config.yml'
        path.unlink()
        _, apps = load_installation(self.config)
        glob = apps['global']
        self.save(glob)
        self.assertEqual(glob.plan_commit(glob.server_prepared(glob.logical_standard()))['files'], {})
        self.assertFalse(path.exists(), 'nothing to write: nothing created')
        glob.profile_action({'action': 'clone', 'profile': 'standard', 'name': 'x'})
        self.assertIn('x', self.read(path)['modelPresets'], 'a change with content creates it')

    def test_trailing_newline_and_unchanged_files_keep_their_bytes(self):
        """F3: a save changes the edited value only; a file without a final newline keeps that."""
        glob = self.apps['global']
        path = self.agent / 'config.yml'
        path.write_text(path.read_text().rstrip('\n'))
        self.save(glob, changes=[{'path': ['modelRoles', 'plan'], 'value': 'paid/big'}])
        text = path.read_text()
        self.assertFalse(text.endswith('\n'))
        self.assertEqual(self.read(path)['modelRoles']['plan'], 'paid/big')


if __name__ == '__main__':
    unittest.main()
