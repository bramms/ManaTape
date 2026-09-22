"""Run: python -m unittest -v test_forge.py (temporary configs; never real OMP)."""
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import Forge, Handler, Problem, ThreadingHTTPServer, digest, fingerprint, yaml_load


class ForgeTest(unittest.TestCase):
    def test_refresh_loads_only_installed_free_bridge_and_hides_its_token(self):
        extension = self.agent / 'extensions' / 'opencode-free.js'
        extension.parent.mkdir()
        extension.write_text('// fixture, never executed')
        model = {'provider': 'opencode-free', 'id': 'big-pickle', 'name': '[FREE] Big Pickle',
                 'cost': {'input': 0, 'output': 0}, 'apiKey': 'LOCAL-SECRET'}
        class Result:
            returncode, stderr = 0, b''
            stdout = json.dumps({'models': [model]}).encode()
        with patch('server.subprocess.run', return_value=Result()) as run:
            self.app.refresh()
            self.assertEqual(run.call_args.args[0][-3:], ['--no-extensions', '-e', str(extension)])
            self.assertIn('opencode-free/big-pickle', self.app.state['available'])
            self.assertNotIn('LOCAL-SECRET', json.dumps(self.app.snapshot()))
            self.app.demo = True
            self.app.refresh()
            self.assertNotIn('-e', run.call_args.args[0])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.agent = self.root / 'agent'
        (self.project / '.omp/presets').mkdir(parents=True)
        self.agent.mkdir()
        (self.project / '.omp/config.yml').write_text('''# keep this comment
modelRoles:
  default: demo/one:high
  task: demo/one:high
  smol: demo/two
  scout: demo/three
retry:
  fallbackChains:
    default: [demo/two]
    smol: &shared [demo/three]
    scout: *shared
task:
  agentModelOverrides:
    task: ["@task", demo/two]
    sonic: ["@smol", demo/three]
disabledProviders: [other]
unrelated: {keep: true}
''')
        (self.project / '.omp/presets/high.yml').write_text('# overlay\nmodelRoles:\n  task: demo/two:high\n')
        (self.agent / 'models.yml').write_text('providers: {}\n')
        self.app = Forge(self.project, self.agent, self.root/'state', '/does-not-exist')

    def tearDown(self):
        self.temp.cleanup()

    def save(self, changes, profile='high'):
        return self.app.save_profile({'profile': profile, 'revision': self.app.revision(profile), 'changes': changes})

    def provider(self, pid='temporary', **kwargs):
        return {'id': pid, 'url': 'https://api.example.com/v1', 'api': 'openai-completions',
            'auth': 'apiKey', 'key': 'SENSITIVE-TEST-KEY', 'discovery': 'openai-models-list', 'models': [],
            'days': 1, 'revision': digest((self.agent/'models.yml').read_bytes()), **kwargs}

    def test_overlay_and_comments_preserved(self):
        base = self.app.path('standard').read_bytes()
        self.save([{'path': ['retry','fallbackChains','task'], 'value': ['demo/three']}])
        self.assertEqual(self.app.path('standard').read_bytes(), base)
        data = yaml_load(self.app.path('high').read_text())
        self.assertEqual(set(data), {'modelRoles','retry'})
        self.assertIn('# overlay', self.app.path('high').read_text())
        self.assertTrue(self.app.state['backups'])

    def test_anchor_edit_does_not_modify_other_role(self):
        self.save([{'path':['retry','fallbackChains','smol'],'value':['demo/two']}], 'standard')
        raw = self.app.path('standard').read_text()
        data = yaml_load(raw)
        self.assertEqual(data['retry']['fallbackChains']['scout'], ['demo/three'])
        self.assertEqual(data['unrelated'], {'keep':True})
        self.assertIn('# keep this comment', raw)

    def test_stale_base_and_overlay_both_rejected(self):
        revision = self.app.revision('high')
        with self.app.path('standard').open('a') as f:
            f.write('\n# external editor\n')
        old = self.app.path('high').read_bytes()
        with self.assertRaises(Problem) as e:
            self.app.save_profile({'profile':'high','revision':revision,'changes':[{'path':['modelRoles','task'],'value':'demo/three'}]})
        self.assertEqual(e.exception.status,409)
        self.assertEqual(self.app.path('high').read_bytes(),old)

    def test_invalid_patch_and_traversal(self):
        for name in ('../x', '/tmp/x', 'a/b', '', None):
            with self.assertRaises(Problem): self.app.path(name)
        for change in ({'path':['unrelated','keep'],'value':False}, {'path':['modelRoles','task'],'value':'!shell'}, {'path':['task','agentModelOverrides','task'],'value':[]}):
            with self.assertRaises(Problem):self.save([change])

    def test_profile_rename_preserves_yaml_revision_and_history(self):
        self.save([{'path':['modelRoles','task'],'value':'demo/three'}])
        old = self.app.path('high')
        raw, revision = old.read_bytes(), self.app.revision('high')
        backup = self.app.state['backups'][str(old)]
        self.app.profile_action({'action':'rename','profile':'high','name':'my-profile','revision':revision})
        target = self.app.path('my-profile')
        self.assertFalse(old.exists())
        self.assertEqual(target.read_bytes(), raw)
        self.assertEqual(self.app.revision('my-profile'), revision)
        self.assertEqual(self.app.state['backups'][str(target)], backup)
        self.app.profile_action({'action':'restore','profile':'my-profile','revision':revision})
        self.assertEqual(self.app.read(target)['modelRoles']['task'],'demo/two:high')
        self.app.profile_action({'action':'delete','profile':'my-profile','revision':self.app.revision('my-profile')})
        self.assertFalse(target.exists())
        self.assertTrue(list((self.app.state_dir/'backups').glob('*-deleted-my-profile.yml')))

    def test_profile_rename_rejects_collision_standard_stale_and_invalid_name(self):
        raw = self.app.path('high').read_bytes()
        for profile, name, revision in [('high','standard',self.app.revision('high')),('standard','other',self.app.revision('standard')),('high','other','stale'),('high','../bad',self.app.revision('high'))]:
            with self.assertRaises(Problem):
                self.app.profile_action({'action':'rename','profile':profile,'name':name,'revision':revision})
        self.assertEqual(self.app.path('high').read_bytes(), raw)
        self.app.profile_action({'action':'rename','profile':'high','name':'high','revision':self.app.revision('high')})
        self.assertEqual(self.app.path('high').read_bytes(), raw)

    def test_readable_profile_names_normalize_and_collisions_keep_files(self):
        base = self.app.path('standard').read_bytes()
        result = self.app.profile_action({'action':'clone','profile':'standard','name':'  Standard  FreeTier  '})
        self.assertEqual(result, {'ok':True, 'name':'standard-freetier'})
        target = self.app.path(result['name'])
        raw, revision = target.read_bytes(), self.app.revision(result['name'])
        with self.assertRaises(Problem) as conflict:
            self.app.profile_action({'action':'clone','profile':'high','name':'STANDARD FREETIER'})
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(target.read_bytes(), raw)
        result = self.app.profile_action({'action':'rename','profile':'standard-freetier','name':'My Free Tier','revision':revision})
        self.assertEqual(result['name'], 'my-free-tier')
        self.assertEqual(self.app.path(result['name']).read_bytes(), raw)
        self.assertEqual(self.app.revision(result['name']), revision)
        self.assertFalse(target.exists())
        self.assertEqual(self.app.path('standard').read_bytes(), base)

    def test_profile_names_reject_paths_punctuation_and_non_strings(self):
        before = {p:p.read_bytes() for p in (self.project/'.omp').rglob('*.yml')}
        for value in ('../escape', 'a/b', 'a.b', '-name', '_name', '', '   ', 'a'*65, None, 123, 'Мій профіль'):
            with self.subTest(value=value), self.assertRaises(Problem):
                self.app.profile_action({'action':'clone','profile':'high','name':value})
        self.assertEqual({p:p.read_bytes() for p in (self.project/'.omp').rglob('*.yml')}, before)
        with self.assertRaises(Problem):
            self.app.path('Standard')

    def test_commandcode_telemetry_strips_identity_and_tracks_staleness(self):
        from insights import commandcode_report
        payload = [{'provider':'commandcode','usage':{'updatedAt':'2026-09-19T08:58:05Z',
            'identity':{'accountEmail':'private@example.test'},'loginMethod':'private balance',
            'primary':{'usedPercent':5.6,'resetsAt':'2026-09-19T10:07:20Z'},
            'secondary':{'usedPercent':66.94},'tertiary':{'usedPercent':77.1}}}]
        report = commandcode_report(payload)
        self.assertEqual([l['remaining'] for l in report['limits']],[94.4,33.1,22.9])
        self.assertNotIn('private',json.dumps(report))
        self.assertNotIn('identity',report)
        (self.app.state_dir/'commandcode-usage.json').write_text(json.dumps(report))
        with patch('insights.time.time',return_value=report['at']+60):
            self.assertFalse(self.app.insights.snapshot()['usage']['reports'][-1]['stale'])
        with patch('insights.time.time',return_value=report['at']+901):
            self.assertTrue(self.app.insights.snapshot()['usage']['reports'][-1]['stale'])
        with self.assertRaises(ValueError):
            commandcode_report([{'provider':'commandcode','error':'No session'}])
        self.assertEqual(self.app.insights.data['usage']['reports'],[])

    def test_key_never_in_snapshot_or_registry(self):
        keydir = self.agent/'forge-keys'
        keydir.mkdir(mode=0o755)
        self.app.provider_save(self.provider())
        self.assertEqual(keydir.stat().st_mode & 0o777, 0o700)
        self.assertNotIn('SENSITIVE-TEST-KEY', json.dumps(self.app.snapshot()))
        self.assertNotIn('SENSITIVE-TEST-KEY', (self.agent/'models.yml').read_text())
        files=list((self.agent/'forge-keys').iterdir())
        self.assertEqual(files[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(files[0].read_text(),'SENSITIVE-TEST-KEY')
        with self.assertRaises(Problem):
            self.app.provider_save(self.provider(key='',url='https://different.example/v1'))

    def test_identity_headers_rejected_from_nonlocal_peer(self):
        from email.message import Message
        from types import SimpleNamespace
        handler = object.__new__(Handler)
        self.app.origin, self.app.owner = 'https://panel.test', 'owner@example.test'
        handler.server = SimpleNamespace(app=self.app, server_port=19421)
        handler.client_address = ('100.64.0.12', 42000)
        handler.command = 'GET'
        handler.headers = Message()
        handler.headers['Host'] = 'panel.test'
        handler.headers['Tailscale-User-Login'] = self.app.owner
        with self.assertRaises(Problem) as error:
            handler.check_access()
        self.assertEqual(error.exception.status,403)

    def test_delete_checks_vibe_references(self):
        self.app.provider_save(self.provider())
        self.save([{'path':['task','agentModelOverrides','task'],'value':['temporary/one']}])
        with self.assertRaises(Problem) as e:
            self.app.provider_save(self.provider(action='delete'))
        self.assertEqual(e.exception.status,409)
        self.assertIn('high',str(e.exception))

    def test_expiry_does_not_touch_external_edits(self):
        self.app.provider_save(self.provider())
        self.app.state['managed']['temporary']['expires']=1
        self.app.expire()
        self.assertNotIn('temporary',self.app.registry()['providers'])
        self.assertTrue(self.app.state['managed']['temporary']['expired'])
        self.app.provider_save(self.provider('another'))
        self.app.state['managed']['another']['expires']=1
        with (self.agent/'models.yml').open('a') as f:f.write('\n# unrelated comment\n')
        # A changed provider definition, not a file comment, must prevent expiry deletion.
        text=(self.agent/'models.yml').read_text().replace('timeoutMs: 10000','timeoutMs: 12000')
        (self.agent/'models.yml').write_text(text)
        self.app.expire()
        self.assertIn('another',self.app.registry()['providers'])
        self.assertTrue(self.app.state['managed']['another']['expiryConflict'])

    def test_failed_refresh_cannot_mark_models_missing(self):
        self.app.state['catalog']={'demo/one':{'provider':'demo','id':'one','status':'present'}}
        self.app.state['available']=['demo/one']
        self.app.refresh()
        self.assertEqual(self.app.state['catalog']['demo/one']['status'],'present')
        self.assertEqual(self.app.state['available'],['demo/one'])
        self.assertTrue(self.app.state['error'])

    def test_expiry_preserves_used_provider(self):
        self.app.provider_save(self.provider())
        self.save([{'path':['modelRoles','task'],'value':'temporary/one'}])
        self.app.state['managed']['temporary']['expires']=1
        self.app.expire()
        self.assertIn('temporary',self.app.registry()['providers'])
        self.assertEqual(self.app.state['managed']['temporary']['expiryReason'],'used')

    def test_expiry_conflict_rolls_back_state_and_preserves_external_write(self):
        self.app.provider_save(self.provider())
        self.app.state['managed']['temporary']['expires']=1
        self.app.state['available']=['temporary/one']
        original=self.app.replace_yaml
        def race(path,data,expected):
            with path.open('a') as f:f.write('\n# other writer\n')
            return original(path,data,expected)
        with patch.object(self.app,'replace_yaml',side_effect=race):
            with self.assertRaises(Problem):self.app.expire()
        self.assertFalse(self.app.state['managed']['temporary']['expired'])
        self.assertEqual(self.app.state['available'],['temporary/one'])
        self.assertIn('# other writer',(self.agent/'models.yml').read_text())

    def test_fingerprint_ignores_yaml_formatting(self):
        self.assertEqual(fingerprint(yaml_load('a: 1\nb: 2\n')),fingerprint(yaml_load('# comment\nb: 2\na: 1\n')))

    def test_cloud_profile_accepts_native_dotted_provider_id(self):
        self.save([{'path':['disabledProviders'],'value':['llama.cpp','my-local']}])
        self.assertIn('llama.cpp',self.app.read(self.app.path('high'))['disabledProviders'])

    def test_authoritative_refresh_detects_removal(self):
        c=sqlite3.connect(self.agent/'models.db')
        c.execute('create table model_cache(provider_id TEXT,updated_at INTEGER,authoritative INTEGER,models TEXT)')
        c.execute('insert into model_cache values(?,?,?,?)',('demo',1,1,'[]'));c.commit();c.close()
        self.app.state['catalog']={'demo/one':{'provider':'demo','id':'one','status':'present'}}
        self.app.state['available']=['demo/one']
        class Result:
            returncode=0;stderr=b'';stdout=b'{"models":[{"provider":"demo","id":"two"}]}'
        def refreshed(*args,**kwargs):
            c=sqlite3.connect(self.agent/'models.db');c.execute('update model_cache set updated_at=?',(int(time.time()*1000),));c.commit();c.close();return Result()
        with patch('server.subprocess.run',side_effect=refreshed):self.app.refresh()
        self.assertEqual(self.app.state['catalog']['demo/one']['status'],'missing')
        self.assertEqual(self.app.state['changes'][0]['kind'],'missing')

    def test_http_guards_and_round_trip(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.app=self.app
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        url=f'http://127.0.0.1:{server.server_port}'
        try:
            state=json.load(urlopen(url+'/api/state'))
            data=json.dumps({'profile':'high','revision':state['revisions']['high'],'changes':[{'path':['modelRoles','task'],'value':'demo/three'}]}).encode()
            for headers in ({'Content-Type':'application/json'},{'Host':'evil.example'},{'Origin':'https://evil.example'},{'X-Forwarded-For':'100.1.2.3'}):
                with self.assertRaises(HTTPError) as e:urlopen(Request(url+'/api/profile',data=data,headers=headers))
                self.assertEqual(e.exception.code,403)
                e.exception.close()
            out=json.load(urlopen(Request(url+'/api/profile',data=data,headers={'Content-Type':'application/json','X-Forge-CSRF':state['csrf']})))
            self.assertTrue(out['ok'])
            self.assertEqual(self.app.read(self.app.path('high'))['modelRoles']['task'],'demo/three')
            with self.assertRaises(HTTPError) as e:urlopen(url+'/../server.py')
            e.exception.close()
            self.app.origin = 'https://panel.test'
            self.app.owner = 'owner@example.test'
            for headers in ({}, {'Host':'panel.test'}, {'Host':'panel.test','Tailscale-User-Login':'other@example.test'}):
                with self.assertRaises(HTTPError) as e:urlopen(Request(url+'/api/state',headers=headers))
                self.assertEqual(e.exception.code,403)
                e.exception.close()
            for headers in ({'X-Forge-Local':self.app.local_token}, {'Host':'panel.test','Tailscale-User-Login':self.app.owner}):
                with urlopen(Request(url+'/api/state',headers=headers)) as response:
                    self.assertIn('models',json.load(response))
        finally:
            server.shutdown();server.server_close()

    def test_new_model_detected_after_another_omp_refreshes_cache(self):
        self.app.state['refreshed'] = 1
        self.app.state['known'] = ['demo/one']
        class Result:
            returncode=0;stderr=b'';stdout=b'{"models":[{"provider":"demo","id":"two"}]}'
        with patch.object(self.app,'cached',return_value=({'demo/two':{}},{})), patch('server.subprocess.run',return_value=Result()):
            self.app.refresh()
        self.assertEqual(self.app.state['changes'],[{'kind':'new','route':'demo/two','at':self.app.state['attempted']}])

    def test_benchmark_data_has_attribution_and_no_fabricated_scores(self):
        data=json.loads((Path(__file__).parent/'benchmarks.json').read_text())
        self.assertGreater(len(data['records']),150)
        for r in data['records']:
            self.assertTrue(r['url'].startswith(('https://livebench.ai','https://artificialanalysis.ai','https://livecodebench.github.io','https://arena.ai','https://huggingface.co')))
            self.assertTrue(all(0<=v<=100 for v in r['scores'].values()))
        self.assertNotIn('domain_reviewer',data['weights'])
        self.assertNotIn('designer',data['weightsAA'])


if __name__=='__main__':unittest.main()
