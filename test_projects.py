"""Isolation tests use only disposable OMP fixtures."""
import gzip
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from server import Handler, asset_version, load_installation, yaml_dump, Problem


class Projects(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        entries = []
        for name in ('one', 'two'):
            path = self.root / name
            (path / '.omp/presets').mkdir(parents=True)
            (path / '.omp/config.yml').write_text(yaml_dump({'modelRoles': {'researcher': 'custom/model-a'}, 'task': {'agentModelOverrides': {'research-team': ['@researcher', 'custom/model-b']}}}))
            entries.append({'id': name, 'name': name, 'path': name})
        self.config = self.root / 'installation.yml'
        self.cfg = {'state': 'state', 'agent': 'agent', 'omp': '/does-not-exist', 'projects': entries}
        self.config.write_text(yaml_dump(self.cfg))
        _, self.apps = load_installation(self.config)

    def test_request_scoped_selection_and_write_isolation(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.app, server.apps = self.apps['one'], self.apps
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        def request(method, path, body=None, csrf=None):
            c = http.client.HTTPConnection('127.0.0.1', server.server_port)
            headers = {'Content-Type': 'application/json', 'X-Forge-CSRF': csrf or server.app.csrf}
            c.request(method, path, json.dumps(body) if body else None, headers)
            r = c.getresponse(); result = (r.status, json.loads(r.read())); c.close(); return result
        status, state = request('GET', '/api/state?project=two')
        self.assertEqual(status, 200); self.assertEqual(state['projectId'], 'two')
        one_before = self.apps['one'].path('standard').read_bytes()
        status, _ = request('POST', '/api/profile?project=two', {'profile': 'standard', 'revision': state['revisions']['standard'], 'changes': [{'path': ['modelRoles', 'researcher'], 'value': 'custom/model-b'}]})
        self.assertEqual(status, 200)
        self.assertEqual(self.apps['one'].path('standard').read_bytes(), one_before)
        self.assertIn('custom/model-b', self.apps['two'].path('standard').read_text())
        self.assertEqual(request('GET', '/api/state?project=missing')[0], 404)
        self.assertEqual(request('POST', '/api/favorites?project=two', {'values': []}, 'wrong')[0], 403)
        self.assertEqual(request('GET', '/api/state?project=one&project=two')[0], 404)

    def test_project_page_preloads_its_own_state(self):
        # QA1 B12: `?project=` pages preload the state URL the panel fetches first, escaped.
        from server import pinned_shell
        raw = b'<link rel="preload" href="/api/state" as="fetch" crossorigin><script src="/app.js"></script>'
        self.assertIn(b'href="/api/state"', pinned_shell(raw))
        self.assertIn(b'href="/api/state?project=two"', pinned_shell(raw, 'two'))
        self.assertIn(b'href="/api/state?project=a%22%3E%3Cx"', pinned_shell(raw, 'a"><x'))
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.app, server.apps = self.apps['one'], self.apps
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        c = http.client.HTTPConnection('127.0.0.1', server.server_port); self.addCleanup(c.close)
        c.request('GET', '/?project=two'); page = c.getresponse().read()
        self.assertIn(b'href="/api/state?project=two"', page)

    def test_proxy_flushes_stale_pool_and_retries_a_get_on_a_fresh_connection(self):
        # QA4 P1-7: after a tunnel blip every pooled connection is stale; one failure flushes them all.
        from types import SimpleNamespace
        proxy = self.load_proxy()
        class Conn:
            def __init__(self, fail=None): self.fail, self.closed = fail, False
            def request(self, *args):
                if self.fail: raise self.fail
            def getresponse(self): return 'response'
            def close(self): self.closed = True
        upstream = proxy.Upstream(1)
        stale = [Conn(ConnectionResetError()), Conn(ConnectionResetError())]
        for connection in stale:
            upstream.put(connection)
        fresh = Conn()
        upstream.fresh = lambda: fresh
        handler = SimpleNamespace(server=SimpleNamespace(upstream=upstream), command='GET', path='/api/state')
        self.assertEqual(proxy.Proxy.forward(handler, None, {}), (fresh, 'response'))
        self.assertTrue(all(c.closed for c in stale), 'the whole stale pool is closed')
        self.assertEqual(upstream.free, [])
        # A POST is never repeated; a refused fresh connection (tunnel down) is not retried either.
        upstream.put(Conn(ConnectionResetError()))
        with self.assertRaises(ConnectionResetError):
            proxy.Proxy.forward(SimpleNamespace(server=handler.server, command='POST', path='/api/profile'), b'{}', {})
        upstream.fresh = lambda: Conn(ConnectionRefusedError())
        with self.assertRaises(ConnectionRefusedError):
            proxy.Proxy.forward(handler, None, {})

    def test_shared_agent_lock_and_explicit_native_environment(self):
        one, two = self.apps['one'], self.apps['two']
        self.assertIs(one.lock, two.lock)
        self.assertEqual(one.native_env['PI_CODING_AGENT_DIR'], str((self.root / 'agent').resolve()))
        with patch('insights.subprocess.run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b'{}'
            one.insights.native(['stats', '--json'], 5)
            self.assertEqual(run.call_args.kwargs['env']['PI_CODING_AGENT_DIR'], str((self.root / 'agent').resolve()))

    def test_custom_worker_and_role_alias(self):
        app = self.apps['one']
        app.save_profile({'profile': 'standard', 'revision': app.revision('standard'), 'changes': [{'path': ['task', 'agentModelOverrides', 'research-team'], 'value': ['@researcher', 'custom/model-c']}]})
        self.assertIn('custom/model-c', app.path('standard').read_text())
        with self.assertRaises(Problem):
            app.save_profile({'profile': 'standard', 'revision': app.revision('standard'), 'changes': [{'path': ['task', 'agentModelOverrides', 'unconfigured'], 'value': ['custom/model-c']}]})

    def test_duplicate_target_rejected(self):
        self.cfg['projects'][1]['path'] = 'one'
        self.config.write_text(yaml_dump(self.cfg))
        with self.assertRaises(ValueError):
            load_installation(self.config)

    def test_missing_project_rejected(self):
        self.cfg['projects'][1]['path'] = 'missing'
        self.config.write_text(yaml_dump(self.cfg))
        with self.assertRaises(ValueError):
            load_installation(self.config)

    def test_user_scope_edits_the_agent_config(self):
        agent = self.root / 'agent'
        (agent / 'presets').mkdir(parents=True, exist_ok=True)
        (agent / 'config.yml').write_text('# user config\n' + yaml_dump({'modelRoles': {'default': 'custom/model-a'}, 'theme': {'dark': 'titanium'}}))
        (agent / 'presets/night.yml').write_text(yaml_dump({'modelRoles': {'default': 'custom/model-b'}}))
        self.cfg['projects'] = [{'id': 'mac', 'name': 'Mac', 'scope': 'user'}]
        self.config.write_text(yaml_dump(self.cfg))
        _, apps = load_installation(self.config)
        app = apps['mac']
        self.assertEqual(app.path('standard'), (agent / 'config.yml').resolve())
        self.assertEqual(app.path('night'), (agent / 'presets/night.yml').resolve())
        app.save_profile({'profile': 'standard', 'revision': app.revision('standard'), 'changes': [{'path': ['modelRoles', 'default'], 'value': 'custom/model-c'}]})
        text = (agent / 'config.yml').read_text()
        self.assertIn('custom/model-c', text)
        self.assertIn('# user config', text)
        self.assertIn('titanium', text)
        self.cfg['projects'][0]['scope'] = 'global'
        self.config.write_text(yaml_dump(self.cfg))
        with self.assertRaises(ValueError):
            load_installation(self.config)

    def test_expiry_respects_other_projects_using_shared_registry(self):
        import time
        from server import fingerprint
        one, two = self.apps['one'], self.apps['two']
        config = {'api': 'openai-completions', 'baseUrl': 'https://example.invalid/v1', 'models': [{'id': 'model-a'}]}
        one.agent.mkdir(exist_ok=True)
        (one.agent/'models.yml').write_text(yaml_dump({'providers': {'custom': config}}))
        one.path('standard').write_text(yaml_dump({'modelRoles': {'other': 'else/model'}}))
        one.managed['custom'] = {'expires': time.time()-1, 'fingerprint': fingerprint(config)}
        from server import digest
        with self.assertRaises(Problem) as error:
            one.provider_save({'id': 'custom', 'action': 'delete', 'revision': digest((one.agent/'models.yml').read_bytes())})
        self.assertEqual(error.exception.status, 409)
        self.assertIn('two/standard', str(error.exception))
        one.expire()
        self.assertIn('custom', one.registry()['providers'])
        self.assertEqual(one.managed['custom']['expiryReason'], 'used')

    def test_custom_worker_compiles_pools_and_deepseek(self):
        from profile_modes import compile_profile
        normal = {'modelRoles': {'researcher': 'custom/plain'}, 'task': {'agentModelOverrides': {'research-team': ['custom/deepseek-v4', 'mana-pool/free-good']}}}
        models = {r: {'input': ['text']} for r in ('custom/plain', 'custom/free-model')}
        result = compile_profile(normal, {'mode': 'no-deepseek', 'alternatives': ['custom/plain'], 'overrides': {}}, models, {}, {'free-good': ['custom/free-model']})
        self.assertEqual(result['effective']['task']['agentModelOverrides']['research-team'], ['custom/plain', 'custom/free-model'])
        self.assertIn('research-team', result['views']['vibe'])
        self.assertEqual(result['issues'], [])

    def test_vision_requirement_uses_explicit_role_ids(self):
        from profile_modes import compile_profile
        normal = {'modelRoles': {'photo-editor': 'mana-pool/free-good', 'vision_named_but_text': 'custom/plain'}}
        settings = {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}
        models = {'custom/plain': {'input': ['text']}}
        result = compile_profile(normal, settings, models, {}, {'free-good': ['custom/plain']}, ['photo-editor'])
        self.assertTrue(result['issues'])
        self.assertTrue(all(i['key']=='role:photo-editor' for i in result['issues']))

    def test_config_without_explicit_roles_saves_custom_worker(self):
        app = self.apps['one']
        app.path('standard').write_text(yaml_dump({'task': {'agentModelOverrides': {'custom-worker': ['custom/model-a']}}}))
        body = {'profile':'standard', 'revision': app.revision('standard'), 'changes':[{'path':['task','agentModelOverrides','custom-worker'],'value':['custom/model-b']}], 'modeSettings':{'mode':'deepseek','alternatives':[],'overrides':{}}}
        body['previewToken'] = app.preview_profile(body)['token']
        app.save_profile(body)
        self.assertEqual(app.read(app.path('standard'))['task']['agentModelOverrides']['custom-worker'], ['custom/model-b'])
        app.save_pools({'revision':app.pools_revision(),'pools':{'free-good':[],'free-fast':[]}})

    def test_builtin_role_metadata_does_not_materialize_assignments(self):
        app = self.apps['one']
        app.path('standard').write_text('# Keep this comment\n{}\n')
        before = app.path('standard').read_bytes()
        state = app.snapshot()
        self.assertEqual({r['id'] for r in state['builtinRoles']}, {
            'default', 'smol', 'slow', 'vision', 'plan', 'commit', 'tiny',
            'memory', 'task', 'advisor', 'image', 'web', 'speech', 'dictation', 'judge'})
        self.assertNotIn('modelRoles', state['base'])
        self.assertEqual(app.path('standard').read_bytes(), before)

    def test_builtin_agents_are_metadata_without_native_overrides(self):
        app = self.apps['one']
        app.path('standard').write_text('modelRoles:\n  smol: test/fast\n')
        before = app.path('standard').read_bytes()
        state = app.snapshot()
        self.assertEqual({a['id']:a['model'] for a in state['agents']}, {
            'scout':'@smol', 'reviewer':'@slow', 'security-reviewer':None,
            'task':'@task', 'sonic':'@smol'})
        self.assertNotIn('task', state['base'])
        self.assertEqual(app.path('standard').read_bytes(), before)

    def test_builtin_agents_can_be_assigned_and_reset_without_changing_roles(self):
        from omp_roles import BUILTIN_AGENTS
        app = self.apps['one']
        for worker in BUILTIN_AGENTS:
            with self.subTest(worker=worker):
                app.path('standard').write_text('# Keep agent comment\nmodelRoles:\n  smol: test/fast\n')
                body = {'profile':'standard', 'revision':app.revision('standard'),
                        'changes':[{'path':['task','agentModelOverrides',worker], 'value':['test/own-model']}]}
                if worker != 'scout':
                    body['modeSettings'] = {'mode':'deepseek','alternatives':[],'overrides':{}}
                    body['previewToken'] = app.preview_profile(body)['token']
                app.save_profile(body)
                data = app.read(app.path('standard'))
                self.assertEqual(data['task']['agentModelOverrides'], {worker:['test/own-model']})
                self.assertEqual(data['modelRoles'], {'smol':'test/fast'})
                self.assertIn('# Keep agent comment', app.path('standard').read_text())
                body.update(revision=app.revision('standard'), changes=[{'path':['task','agentModelOverrides',worker], 'remove':True}])
                if 'modeSettings' in body:
                    body['previewToken'] = app.preview_profile(body)['token']
                app.save_profile(body)
                self.assertEqual(app.read(app.path('standard'))['task']['agentModelOverrides'], {})
                # Mode records are isolated too; reset all between subtests.
                app.mode_state['profiles'].clear()
                app.mode_file.unlink(missing_ok=True)

    def test_builtin_agent_rejects_unknown_agents_and_non_chat_models(self):
        app = self.apps['one']
        app.path('standard').write_text('{}\n')
        app.state['catalog'] = {'test/voice': {'id':'voice','kind':'tts'}}
        before = app.path('standard').read_bytes()
        for worker, value in [('unconfigured',['test/model']), ('scout',['test/voice']), ('sonic',[])]:
            with self.subTest(worker=worker), self.assertRaises(Problem):
                app.save_profile({'profile':'standard','revision':app.revision('standard'),
                                  'changes':[{'path':['task','agentModelOverrides',worker],'value':value}]})
            self.assertEqual(app.path('standard').read_bytes(), before)

    def test_builtin_agent_alias_to_unassigned_role_stays_native(self):
        app = self.apps['one']
        app.path('standard').write_text('theme:\n  dark: titanium\n')
        body = {'profile':'standard','revision':app.revision('standard'),
                'changes':[{'path':['task','agentModelOverrides','reviewer'],'value':['@slow']}],
                'modeSettings':{'mode':'deepseek','alternatives':[],'overrides':{}}}
        body['previewToken'] = app.preview_profile(body)['token']
        app.save_profile(body)
        data = app.read(app.path('standard'))
        self.assertEqual(data['task']['agentModelOverrides']['reviewer'], ['@slow'])
        self.assertNotIn('modelRoles', data)
        self.assertNotIn('retry', data)

    def write_agent(self, directory, filename, text):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / filename).write_text(text)

    def test_custom_agents_are_discovered_read_only_with_precedence(self):
        app = self.apps['one']
        project_dir = app.project / '.omp/agents'
        user_dir = app.agent / 'agents'
        self.write_agent(project_dir, 'designer.md', '---\nname: designer\ndescription: UI designer\n---\nPrompt body\n')
        self.write_agent(project_dir, 'reviewer.md', '---\nname: reviewer\ndescription: Project reviewer\nmodel: "@slow"\n---\n')
        self.write_agent(user_dir, 'designer.md', '---\nname: designer\ndescription: User designer\nmodel: p/user\n---\n')
        self.write_agent(user_dir, 'helper.md', '---\nname: helper\ndescription: Helper\nmodel:\n  - "@smol"\n  - p/own:high\n---\n')
        self.write_agent(user_dir, 'bad.md', 'no frontmatter\n')
        self.write_agent(user_dir, 'noname.md', '---\ndescription: nameless\n---\n')
        self.write_agent(user_dir, 'unsafe.md', '---\nname: ../escape\ndescription: unsafe\n---\n')
        self.write_agent(user_dir, 'broken.md', '---\nname: [oops\ndescription: x\n---\n')
        self.write_agent(user_dir, 'notes.txt', '---\nname: ignored\ndescription: x\n---\n')
        before = sorted((p, p.read_bytes()) for p in list(project_dir.iterdir()) + list(user_dir.iterdir()))
        state = app.snapshot()
        agents = {a['id']: a for a in state['agents']}
        self.assertEqual(list(agents)[:5], ['scout', 'reviewer', 'security-reviewer', 'task', 'sonic'])
        self.assertEqual({k: v['source'] for k, v in agents.items()}, {
            'scout': 'builtin', 'reviewer': 'project', 'security-reviewer': 'builtin', 'task': 'builtin',
            'sonic': 'builtin', 'designer': 'project', 'helper': 'user'})
        self.assertEqual(agents['designer']['description'], 'UI designer')
        self.assertIsNone(agents['designer']['model'])
        self.assertEqual(agents['helper']['model'], ['@smol', 'p/own:high'])
        self.assertTrue(agents['reviewer']['overrides'])
        self.assertEqual(agents['reviewer']['model'], '@slow')
        self.assertFalse(agents['designer']['overrides'])
        self.assertEqual(len(state['agentWarnings']), 4)
        self.assertNotIn('ignored', agents)
        self.assertEqual(set(state['base']['task']['agentModelOverrides']), {'research-team'})
        self.assertEqual(sorted((p, p.read_bytes()) for p in list(project_dir.iterdir()) + list(user_dir.iterdir())), before)
        # Other projects do not see this project's agents, only the shared user directory.
        other = {a['id'] for a in self.apps['two'].snapshot()['agents']}
        self.assertEqual(other - {'scout', 'reviewer', 'security-reviewer', 'task', 'sonic'}, {'designer', 'helper'})
        self.assertEqual(next(a for a in self.apps['two'].snapshot()['agents'] if a['id'] == 'designer')['source'], 'user')

    def test_missing_agent_directories_leave_builtin_agents_only(self):
        state = self.apps['one'].snapshot()
        self.assertEqual({a['source'] for a in state['agents']}, {'builtin'})
        self.assertEqual(state['agentWarnings'], [])

    def test_discovered_agents_can_be_assigned_and_removed(self):
        app = self.apps['one']
        self.write_agent(app.project / '.omp/agents', 'designer.md', '---\nname: designer\ndescription: UI designer\n---\n')
        app.path('standard').write_text('# Keep agent comment\nmodelRoles:\n  smol: test/fast\n')
        body = {'profile': 'standard', 'revision': app.revision('standard'),
                'changes': [{'path': ['task', 'agentModelOverrides', 'designer'], 'value': ['test/a', 'test/b']}]}
        app.save_profile(body)
        data = app.read(app.path('standard'))
        self.assertEqual(data['task']['agentModelOverrides'], {'designer': ['test/a', 'test/b']})
        self.assertIn('# Keep agent comment', app.path('standard').read_text())
        # A preset can hold its own override and a saved profile survives the file disappearing.
        (app.project / '.omp/agents/designer.md').unlink()
        state = app.snapshot()
        self.assertNotIn('designer', {a['id'] for a in state['agents']})
        self.assertEqual(state['base']['task']['agentModelOverrides']['designer'], ['test/a', 'test/b'])
        app.save_profile({'profile': 'standard', 'revision': app.revision('standard'),
                          'changes': [{'path': ['task', 'agentModelOverrides', 'designer'], 'remove': True}]})
        self.assertNotIn('designer', app.read(app.path('standard')).get('task', {}).get('agentModelOverrides', {}))

    def test_undiscovered_agent_names_are_still_rejected(self):
        app = self.apps['one']
        self.write_agent(app.agent / 'agents', 'broken.md', '---\nname: ghost\n---\n')
        before = app.path('standard').read_bytes()
        for worker in ('ghost', 'nobody'):
            with self.subTest(worker=worker), self.assertRaises(Problem):
                app.save_profile({'profile': 'standard', 'revision': app.revision('standard'),
                                  'changes': [{'path': ['task', 'agentModelOverrides', worker], 'value': ['test/model']}]})
            self.assertEqual(app.path('standard').read_bytes(), before)

    def test_unassigned_builtin_roles_can_be_saved_and_reset(self):
        from omp_roles import BUILTIN_ROLES
        app = self.apps['one']
        app.path('standard').write_text('# Keep this comment\ntheme:\n  dark: titanium\n')
        for role, info in BUILTIN_ROLES.items():
            with self.subTest(role=role):
                model = {'id': 'candidate', 'provider': 'test', 'kind': info['kinds'][0], 'input': ['text', 'image']}
                app.state['catalog'] = {'test/candidate': model}
                body = {'profile':'standard', 'revision':app.revision('standard'),
                        'changes':[{'path':['modelRoles',role], 'value':'test/candidate'}],
                        'modeSettings':{'mode':'deepseek','alternatives':[],'overrides':{}}}
                body['previewToken'] = app.preview_profile(body)['token']
                app.save_profile(body)
                data = app.read(app.path('standard'))
                self.assertEqual(data['modelRoles'], {role:'test/candidate'})
                self.assertNotIn('retry', data)
                self.assertIn('# Keep this comment', app.path('standard').read_text())
                body.update(revision=app.revision('standard'), changes=[{'path':['modelRoles',role], 'remove':True}])
                body['previewToken'] = app.preview_profile(body)['token']
                app.save_profile(body)
                self.assertEqual(app.read(app.path('standard'))['modelRoles'], {})

    def test_builtin_role_kind_and_custom_role_validation_keep_files_unchanged(self):
        app = self.apps['one']
        app.path('standard').write_text('{}\n')
        app.state['catalog'] = {'test/chat': {'id':'chat','kind':'chat'}}
        before = app.path('standard').read_bytes()
        # QA1 B7: the vision lane takes only CUTS that read images, as a pool on it already did.
        for role, selector in [('speech','test/chat'), ('web','test/chat'), ('unconfigured','test/chat'), ('judge','test/chat:high'), ('vision','test/chat')]:
            with self.subTest(role=role), self.assertRaises(Problem):
                app.save_profile({'profile':'standard','revision':app.revision('standard'),
                                  'changes':[{'path':['modelRoles',role],'value':selector}]})
            self.assertEqual(app.path('standard').read_bytes(), before)

    def test_kind_role_does_not_receive_default_chat_fallbacks(self):
        from profile_modes import compile_profile
        normal = {'modelRoles':{'speech':'test/voice'}, 'retry':{'fallbackChains':{'default':['test/chat']}}}
        result = compile_profile(normal, {'mode':'deepseek','alternatives':[],'overrides':{}}, {}, {})
        self.assertEqual(result['views']['role']['speech']['routes'], ['test/voice'])
        self.assertEqual(result['effective'], normal)

    def test_ssh_commandcode_publisher_uses_configured_host_and_state(self):
        import importlib.util
        from types import SimpleNamespace
        spec = importlib.util.spec_from_file_location('mana_proxy', Path(__file__).parent/'mac-preview.py')
        proxy = importlib.util.module_from_spec(spec); spec.loader.exec_module(proxy)
        stop = unittest.mock.Mock()
        stop.is_set.side_effect = [False, True]
        with patch.object(proxy.Path, 'is_file', return_value=True), patch.object(proxy, 'commandcode_report', return_value={'provider':'commandcode','limits':[]}), patch.object(proxy.subprocess, 'run') as run:
            run.return_value.stdout = '{}'
            proxy.sync_commandcode(stop, SimpleNamespace(host='test-host', state='/private state/project'))
            self.assertEqual(run.call_count, 2)
            args = run.call_args.args[0]
            self.assertEqual(args[-2], 'test-host')
            self.assertIn("'/private state/project/commandcode-usage.json'", args[-1])

    def load_proxy(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('mana_proxy', Path(__file__).parent/'mac-preview.py')
        proxy = importlib.util.module_from_spec(spec); spec.loader.exec_module(proxy)
        return proxy

    def test_ssh_commandcode_sync_survives_unexpected_errors(self):
        from types import SimpleNamespace
        proxy = self.load_proxy()
        stop = unittest.mock.Mock()
        stop.is_set.side_effect = [False, False, True]
        with patch.object(proxy.Path, 'is_file', return_value=True), \
             patch.object(proxy, 'commandcode_report', side_effect=AttributeError('schema changed')), \
             patch.object(proxy.subprocess, 'run') as run, patch('sys.stderr'):
            run.return_value.stdout = '{}'
            proxy.sync_commandcode(stop, SimpleNamespace(host='test-host', state='/state'))
        self.assertEqual(stop.wait.call_count, 2, 'the thread keeps polling after a bad report')

    def test_ssh_proxy_reuses_upstream_and_passes_compression_and_validators(self):
        proxy = self.load_proxy()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.app, server.apps, server.daemon_threads = self.apps['one'], self.apps, True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        front = ThreadingHTTPServer(('127.0.0.1', 0), proxy.Proxy)
        front.daemon_threads = True
        front.token, front.tunnel_port, front.remote_port = proxy.Token(lambda: 'x' * 32), server.server_port, server.server_port
        front.upstream = proxy.Upstream(server.server_port)
        self.addCleanup(front.upstream.close)
        reused, get = [], front.upstream.get
        def counted():
            connection, again = get(); reused.append(again); return connection, again
        front.upstream.get = counted
        threading.Thread(target=front.serve_forever, daemon=True).start()
        self.addCleanup(front.server_close); self.addCleanup(front.shutdown)
        c = http.client.HTTPConnection('127.0.0.1', front.server_port, timeout=30)
        self.addCleanup(c.close)
        def call(method, path, body=None, **headers):
            c.request(method, path, body, headers)
            response = c.getresponse()
            return response, response.read()
        response, raw = call('GET', '/api/state?project=two', **{'Accept-Encoding': 'gzip'})
        self.assertEqual(response.getheader('Content-Encoding'), 'gzip')
        state = json.loads(gzip.decompress(raw))
        self.assertEqual(state['projectId'], 'two')
        response, raw = call('GET', '/api/state?project=two', **{'If-None-Match': response.getheader('ETag')})
        self.assertEqual((response.status, raw), (304, b''))
        icon = (Path(__file__).parent/'static/icon.svg').read_bytes()
        response, raw = call('GET', '/icon.svg?v=' + asset_version(icon))
        self.assertIn('immutable', response.getheader('Cache-Control'))
        self.assertEqual(raw, icon)
        response, raw = call('POST', '/api/favorites?project=two', json.dumps({'values': ['custom/model-a']}),
                             **{'Content-Type': 'application/json', 'X-Forge-CSRF': state['csrf']})
        self.assertEqual((response.status, json.loads(raw)), (200, {'ok': True}))
        self.assertEqual(self.apps['two'].state['favs'], ['custom/model-a'])
        self.assertEqual(reused, [False, True, True, True], 'one tunnel connection for the whole burst')

    def test_ssh_proxy_reads_a_new_token_after_a_server_restart(self):
        proxy = self.load_proxy()
        app = self.apps['one']
        app.origin, app.local_token = 'https://mana.example.ts.net', 'n' * 32  # A restarted server: a new token.
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.app, server.apps, server.daemon_threads = app, self.apps, True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        reads = iter(['o' * 32, 'n' * 32])
        front = ThreadingHTTPServer(('127.0.0.1', 0), proxy.Proxy)
        front.daemon_threads = True
        front.token, front.tunnel_port, front.remote_port = proxy.Token(lambda: next(reads)), server.server_port, server.server_port
        front.upstream = proxy.Upstream(server.server_port)
        self.addCleanup(front.upstream.close)
        threading.Thread(target=front.serve_forever, daemon=True).start()
        self.addCleanup(front.server_close); self.addCleanup(front.shutdown)
        c = http.client.HTTPConnection('127.0.0.1', front.server_port, timeout=30)
        self.addCleanup(c.close)
        c.request('GET', '/api/state')
        response = c.getresponse(); state = json.loads(response.read())
        self.assertEqual(response.status, 200, 'the launcher read the new token and repeated the request once')
        self.assertEqual(front.token.value, 'n' * 32)
        c.request('POST', '/api/favorites', json.dumps({'values': ['custom/model-a']}), {'Content-Type': 'application/json', 'X-Forge-CSRF': state['csrf']})
        response = c.getresponse(); response.read()
        self.assertEqual(response.status, 200)
        # A token that is still wrong after reading it again: the 403 reaches the browser, no loop.
        app.local_token = 'z' * 32
        front.token.at = 0
        front.token.read = lambda: 'n' * 32
        c.request('GET', '/api/state')
        response = c.getresponse(); response.read()
        self.assertEqual(response.status, 403)

    def test_shared_provider_renewal_survives_old_expiry_and_restart(self):
        from server import digest
        one, two = self.apps['one'], self.apps['two']
        def save(app, days):
            registry = app.agent/'models.yml'
            app.provider_save({'id':'temporary', 'name':'Temporary', 'revision':digest(registry.read_bytes()) if registry.exists() else digest(b''), 'url':'https://example.invalid/v1', 'api':'openai-completions', 'auth':'none', 'models':['model'], 'days':days})
        save(one, 1)
        one.managed['temporary']['expires'] = 1
        one.persist()
        save(two, 0)
        one.expire()
        self.assertIn('temporary', one.registry()['providers'])
        self.assertEqual(one.managed['temporary']['expires'], 0)
        self.cfg['projects'].reverse()
        self.config.write_text(yaml_dump(self.cfg))
        _, apps = load_installation(self.config)
        self.assertEqual(apps['one'].managed['temporary']['expires'], 0)
        apps['one'].expire()
        self.assertIn('temporary', apps['one'].registry()['providers'])
