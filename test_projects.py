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
