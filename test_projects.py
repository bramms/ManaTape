"""Isolation tests use only disposable OMP fixtures."""
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from server import Handler, load_installation, yaml_dump, Problem


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

    def test_shared_agent_lock_and_explicit_native_environment(self):
        one, two = self.apps.values()
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

    def test_expiry_respects_other_projects_using_shared_registry(self):
        import time
        from server import fingerprint
        one, two = self.apps.values()
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

    def test_shared_provider_renewal_survives_old_expiry_and_restart(self):
        from server import digest
        one, two = self.apps.values()
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
