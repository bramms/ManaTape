"""Run: python -m unittest -v test_forge.py (temporary configs; never real OMP)."""
import copy
import errno
import gzip
import http.client
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from profile_modes import route_statuses
from server import (Forge, Handler, Problem, ThreadingHTTPServer, PUBLIC_MODEL_LISTS, digest, fingerprint, log_failure,
    peer_uid, withdrawn_free_routes, yaml_dump, yaml_load)


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
        self.app.native_env['OMP_FREE_HOME'] = str(self.root / 'free-bridge')

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

    def test_create_refuses_an_existing_provider_id(self):
        # QA2 B1: «+ Провайдер» with a taken ID never overwrites that provider; editing keeps working.
        self.app.provider_save(self.provider(models=['kept']))
        registry = (self.agent/'models.yml').read_bytes()
        with self.assertRaises(Problem) as refused:
            self.app.provider_save(self.provider(mode='create', url='https://other.test/v1', auth='none', models=['only-this']))
        self.assertEqual((refused.exception.status, refused.exception.code), (409, 'provider-exists'))
        self.assertEqual((self.agent/'models.yml').read_bytes(), registry)
        self.app.provider_save(self.provider(mode='edit', models=['kept', 'more']))
        self.assertEqual([m['id'] for m in self.app.registry()['providers']['temporary']['models']], ['kept', 'more'])

    def test_stale_revision_refusals_carry_a_code(self):
        # The panel tells a stale revision (rebase the draft) from other 409s by its code.
        body = {'profile': 'standard', 'revision': 'stale', 'changes': [], 'modeSettings': {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}}
        with self.assertRaises(Problem) as stale:
            self.app.preview_profile(body)
        self.assertEqual((stale.exception.status, stale.exception.code), (409, 'revision'))
        with self.assertRaises(Problem) as pools:
            self.app.save_pools({'revision': 'stale', 'pools': {'free-good': [], 'free-fast': []}})
        self.assertEqual(pools.exception.code, 'revision')

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

    def test_free_bridge_deleted_routes_require_complete_fresh_evidence(self):
        extension = self.agent / 'extensions/opencode-free.js'
        extension.parent.mkdir()
        extension.write_text('// fixture')
        home = self.root / 'free-bridge'
        home.mkdir()
        missing = 'opencode-free/old-free'
        never_seen = 'opencode-free/configured-free'
        self.app.mode_state['pools'] = {'free-good': [never_seen], 'free-fast': []}
        original_config = self.app.path('standard').read_bytes()
        original_modes = copy.deepcopy(self.app.mode_state)
        now = time.time()
        fresh = {'schema': 1, 'checked_at': now, 'expires_at': now + 900,
                 'models': [{'lane': 'zen', 'id': 'new-free'}], 'excluded': [], 'notes': []}
        class Result:
            returncode, stderr = 0, b''
            stdout = b'{"models":[{"provider":"opencode-free","id":"new-free"}]}'
        cases = [
            ('fresh', fresh, True),
            ('expired', {**fresh, 'checked_at': now-1800, 'expires_at': now-900}, False),
            ('partial', {**fresh, 'notes': ['zen: listing unavailable; lane disabled']}, False),
            ('excluded', {**fresh, 'excluded': [{'lane': 'zen', 'id': 'old-free'},
                                              {'lane': 'zen', 'id': 'configured-free'}]}, False),
            ('mismatched', {**fresh, 'models': []}, False),
            ('malformed', {**fresh, 'models': [None]}, False),
        ]
        for name, snapshot, removed in cases:
            with self.subTest(name=name):
                (home / 'catalog.json').write_text(json.dumps(snapshot))
                self.app.state.update(catalog={missing: {'provider': 'opencode-free', 'id': 'old-free', 'status': 'present'}},
                                      available=[], changes=[])
                with patch('server.subprocess.run', return_value=Result()):
                    self.app.refresh()
                self.assertFalse(self.app.state['error'])
                self.assertEqual(self.app.state['catalog'][missing]['status'], 'missing' if removed else 'present')
                self.assertEqual(self.app.state['catalog'].get(never_seen, {}).get('status'), 'missing' if removed else None)
                self.assertEqual(self.app.path('standard').read_bytes(), original_config)
                self.assertEqual(self.app.mode_state, original_modes)
        # A complete empty catalog is different from a failed discovery.
        (home / 'catalog.json').write_text(json.dumps({**fresh, 'models': []}))
        Result.stdout = b'{"models":[]}'
        with patch('server.subprocess.run', return_value=Result()):
            self.app.refresh()
        self.assertEqual(self.app.state['catalog'][missing]['status'], 'missing')
        changes = len(self.app.state['changes'])
        with patch('server.subprocess.run', return_value=Result()):
            self.app.refresh()
        self.assertEqual(len(self.app.state['changes']), changes)
        # Returning exact IDs clear DELETED on the next successful refresh.
        (home / 'catalog.json').write_text(json.dumps({**fresh, 'models': [{'lane': 'zen', 'id': 'old-free'}]}))
        Result.stdout = b'{"models":[{"provider":"opencode-free","id":"old-free"}]}'
        with patch('server.subprocess.run', return_value=Result()):
            self.app.refresh()
        self.assertEqual(self.app.state['catalog'][missing]['status'], 'present')

    def test_withdrawn_free_routes_need_a_listing_that_still_offers_free_models(self):
        native = [{'provider': 'gw', 'id': i, 'cost': {'input': c, 'output': c}} for i, c in
                  (('live:free', 0), ('gone:free', 0), ('gone-paid', 1), ('a', 1), ('b', 1))]
        listing = {'data': [{'id': i} for i in ('live:free', 'a', 'b', 'only-upstream')]}
        self.assertEqual(withdrawn_free_routes('gw', native, listing), {'gw/gone:free'})
        for proof in (None, {}, {'data': [None]}, {'data': [{'id': 7}]}, {'data': []},
                      {'data': [{'id': i} for i in ('a', 'b', 'gone-paid')]},  # FREE hidden: proves nothing
                      {'data': [{'id': 'live:free'}]}):      # partial list
            with self.subTest(proof=proof):
                self.assertIsNone(withdrawn_free_routes('gw', native, proof))

    def test_public_listing_marks_withdrawn_free_routes_and_survives_network_errors(self):
        dead, live = 'openrouter/gone:free', 'openrouter/live:free'
        self.app.mode_state['pools'] = {'free-good': [dead + ':high'], 'free-fast': []}
        pools = copy.deepcopy(self.app.mode_state)
        native = [{'provider': 'openrouter', 'id': i, 'cost': {'input': 0, 'output': 0}} for i in ('live:free', 'gone:free')]
        class Result:
            returncode, stderr, stdout = 0, b'', json.dumps({'models': native}).encode()
        listing = {'data': [{'id': 'live:free'}]}
        def refresh(answer):
            with patch('server.subprocess.run', return_value=Result()), \
                 patch('server.public_listing', side_effect=answer) as fetched:
                self.app.refresh()
            self.assertEqual(fetched.call_args.args[0], PUBLIC_MODEL_LISTS['openrouter'])
            return {r: self.app.state['catalog'][r]['status'] for r in (dead, live)}
        self.assertEqual(refresh([listing]), {dead: 'missing', live: 'present'})
        self.assertEqual([c['route'] for c in self.app.state['changes'] if c['kind'] == 'missing'], [dead])
        self.assertEqual(route_statuses(self.app.mode_catalog(), {})[dead]['status'], 'blocked')
        self.assertEqual(refresh(OSError('offline')), {dead: 'missing', live: 'present'})
        self.assertEqual(refresh([{'data': []}]), {dead: 'missing', live: 'present'})
        self.assertEqual(len([c for c in self.app.state['changes'] if c['kind'] == 'missing']), 1)
        self.assertEqual(self.app.mode_state, pools)
        self.assertEqual(refresh([{'data': [{'id': 'live:free'}, {'id': 'gone:free'}]}]), {dead: 'present', live: 'present'})

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

    def serve(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.app, server.daemon_threads = self.app, True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_port

    def test_backup_rotation_matches_exact_names_and_keeps_restore_target(self):
        (self.project/'.omp/presets/x-config.yml').write_text('modelRoles:\n  task: demo/two\n')
        self.save([{'path': ['modelRoles', 'task'], 'value': 'demo/three'}], 'x-config')
        backups = self.app.state_dir/'backups'
        restore_target = Path(self.app.state['backups'][str(self.app.path('x-config'))])
        unrelated = [backups/'1-deleted-config.yml', backups/'2-x-config.yml']
        for f in unrelated:
            f.write_text('keep')
        for i in range(25):
            (backups/f'{100 + i}-config.yml').write_text('old')
        referenced = backups/'100-config.yml'
        self.app.state['backups']['elsewhere'] = str(referenced)
        self.save([{'path': ['modelRoles', 'smol'], 'value': 'demo/three'}], 'standard')
        kept = sorted(p.name for p in backups.glob('*-config.yml') if p.name.split('-', 1)[1] == 'config.yml')
        self.assertEqual(len(kept), 21, 'the newest 20 plus the backup Restore points to')
        self.assertTrue(referenced.exists() and restore_target.exists() and all(f.exists() for f in unrelated))
        self.app.profile_action({'action': 'restore', 'profile': 'x-config', 'revision': self.app.revision('x-config')})
        self.assertEqual(self.app.read(self.app.path('x-config'))['modelRoles']['task'], 'demo/two')

    def test_symlinked_registry_is_refused_and_never_replaced(self):
        target = self.root/'dotfiles-models.yml'
        target.write_text('providers: {}\n')
        (self.agent/'models.yml').unlink()
        (self.agent/'models.yml').symlink_to(target)
        with self.assertRaises(Problem) as refused:
            self.app.provider_save(self.provider())
        self.assertEqual((refused.exception.status, refused.exception.code), (409, 'symlink'))
        self.assertTrue((self.agent/'models.yml').is_symlink())
        self.assertEqual(target.read_text(), 'providers: {}\n')
        self.assertFalse((self.agent/'forge-keys').exists())
        # Expiry cannot remove a provider through the link either; it says why.
        target.write_text(yaml_dump({'providers': {'temporary': {'baseUrl': 'https://api.example.com/v1'}}}))
        self.app.managed['temporary'] = {'expires': 1, 'expired': False, 'fingerprint': 'x'}
        self.app.expire()
        self.assertEqual(self.app.managed['temporary']['expiryReason'], 'symlink')
        self.assertIn('temporary', target.read_text())

    def test_bad_preset_never_stops_snapshot_expiry_or_refresh(self):
        presets = self.project/'.omp/presets'
        (presets/'broken.yml').write_text('modelRoles: [unclosed\n')
        os.symlink(self.app.path('high'), presets/'linked.yml')
        snapshot = self.app.snapshot()
        self.assertEqual(set(snapshot['presets']), {'high'})
        self.assertEqual(len(snapshot['profileWarnings']), 2)
        (self.agent/'models.yml').write_text('providers:\n')
        self.app.managed['gone'] = {'expires': 1, 'expired': False}
        self.app.expire()
        self.assertTrue(self.app.managed['gone']['expired'])
        self.app.state['attempted'] = 0
        with patch.object(self.app, 'expire', side_effect=OSError(errno.EIO, 'disk')), \
             patch.object(self.app, 'refresh_async') as refresh, patch('sys.stderr', new=io.StringIO()):
            self.app.maintain_once()
        refresh.assert_called_once()

    def test_key_files_follow_their_provider(self):
        keys = self.agent/'forge-keys'
        def secrets():
            return sorted(f.read_text() for f in keys.iterdir())
        self.app.provider_save(self.provider())
        self.app.provider_save(self.provider(key='ROTATED'))
        self.assertEqual(secrets(), ['ROTATED'])
        self.app.provider_save(self.provider(auth='none', key=''))
        self.assertEqual(secrets(), [])
        with patch.object(self.app, 'replace_yaml', side_effect=Problem('Файл уже змінився', 409)), self.assertRaises(Problem):
            self.app.provider_save(self.provider(key='NOT-SAVED'))
        self.assertEqual(secrets(), [])
        own = self.root/'own-key'
        own.write_text('MINE')
        self.app.remove_key_files(['!cat ' + str(own)], {'providers': {}})
        self.assertTrue(own.exists(), 'a key file the owner manages is never removed')
        self.app.provider_save(self.provider(key='DELETED'))
        self.app.provider_save(self.provider(action='delete'))
        self.assertEqual(secrets(), [])
        self.app.provider_save(self.provider(key='EXPIRED'))
        self.app.managed['temporary']['expires'] = 1
        self.app.expire()
        self.assertEqual(secrets(), [])

    def test_insights_rewritten_only_when_something_changed(self):
        from insights import BENCHMARK_SCHEMA
        insights, now = self.app.insights, time.time()
        insights.data['usage']['at'] = insights.data['stats']['at'] = now
        insights.data['benchmarks'].update(at=now, schema=BENCHMARK_SCHEMA)
        insights.path.write_text('{}')
        with patch.object(insights, 'write') as write, patch.object(insights, 'native', side_effect=AssertionError('not due')):
            insights.update(); insights.update()
        write.assert_not_called()
        insights.data['usage']['at'] = 0
        with patch.object(insights, 'write') as write, patch.object(insights, 'native', side_effect=ValueError('offline')):
            insights.update(); insights.update()
        self.assertEqual(write.call_count, 1, 'the same failure is recorded once')

    def test_snapshot_never_decorates_persisted_catalog(self):
        self.app.state['catalog'] = {'demo/two': {'provider': 'demo', 'id': 'two', 'cost': {'input': 1, 'output': 1}}}
        before = json.dumps(self.app.state['catalog'], sort_keys=True)
        self.app.snapshot()
        self.assertEqual(json.dumps(self.app.state['catalog'], sort_keys=True), before)

    def test_usage_reports_parse_independently_and_reject_non_numbers(self):
        from insights import commandcode_report
        native = {'reports': [
            {'provider': 'good', 'fetchedAt': 1760000000000, 'limits': [
                {'id': 'a', 'label': 'A', 'amount': {'usedFraction': 0.25}},
                {'id': 'n', 'label': 'N', 'amount': {'remainingFraction': float('nan')}},
                {'id': 'b', 'label': 'B', 'amount': {'remainingFraction': True}}]},
            {'provider': 'odd', 'fetchedAt': None, 'limits': []}]}
        from insights import BENCHMARK_SCHEMA
        self.app.insights.data['benchmarks'].update(at=time.time(), schema=BENCHMARK_SCHEMA)  # no network
        with patch.object(self.app.insights, 'native', side_effect=lambda args, timeout: native if args[0] == 'usage' else {}):
            self.app.insights.update()
        usage = self.app.insights.data['usage']
        self.assertEqual([r['provider'] for r in usage['reports']], ['good'])
        self.assertEqual([l['remaining'] for l in usage['reports'][0]['limits']], [75.0, None, None])
        self.assertTrue(usage['error'])
        for payload in (['garbage', {'provider': 'commandcode', 'usage': {}}],
                        [{'provider': 'commandcode', 'usage': {'primary': {'usedPercent': True}}}],
                        [{'provider': 'commandcode', 'usage': {'primary': {'usedPercent': 5}, 'updatedAt': 17}}]):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                commandcode_report(payload)
        report = commandcode_report([{'provider': 'commandcode', 'usage': {'primary': {'usedPercent': 10, 'resetsAt': 1760000000}, 'updatedAt': '2026-10-12T00:00:00Z'}}])
        self.assertIsNone(report['limits'][0]['resets'])

    def test_shared_pool_reported_per_family_is_one_window(self):
        from insights import usage_report
        week = {'label': 'Weekly', 'resetsAt': 1760600000000}
        report = usage_report({'provider': 'google-antigravity', 'fetchedAt': 1760000000000, 'limits': [
            {'id': 'g', 'label': 'Gemini', 'window': week, 'amount': {'remainingFraction': 0.9}},
            {'id': 'a', 'label': 'Claude & GPT (shared)', 'window': week, 'amount': {'remainingFraction': 1}, 'scope': {'modelIds': ['claude']}},
            {'id': 'o', 'label': 'Claude & GPT (shared)', 'window': week, 'amount': {'remainingFraction': 1}, 'scope': {'modelIds': ['gpt']}},
            {'id': 'x', 'label': 'Claude & GPT (shared)', 'window': week, 'amount': {'remainingFraction': 0.5}}]}, 1)
        self.assertEqual([(l['id'], l['remaining']) for l in report['limits']], [('g', 90.0), ('a', 100.0), ('x', 50.0)])
        self.assertEqual(report['limits'][1]['models'], ['claude', 'gpt'])

    @staticmethod
    def commandcode_native(account, used_5h, used_week, balance, at):
        """One CommandCode account as `omp usage --json --redact` reports it (OMP 18.9)."""
        from insights import usage_report
        window = lambda key, label, cap, used, ms: {'id': 'commandcode:' + key, 'label': label + ' limit', 'status': 'ok',
            'window': {'id': key, 'label': label, 'durationMs': ms, 'resetsAt': at * 1000 + ms // 2},
            'amount': {'used': used, 'limit': cap, 'usedFraction': used / cap, 'unit': 'credits'}}
        return usage_report({'provider': 'commandcode', 'fetchedAt': at * 1000, 'limits': [
            window('5h', '5-hour', 14, used_5h, 18000000), window('7d', 'Weekly', 35, used_week, 604800000),
            {'id': 'commandcode:balance', 'label': 'Credit balance', 'amount': {'remaining': balance, 'unit': 'credits'}}]}, account)

    @staticmethod
    def codexbar(at, five=95.1, week=77.5, month=5.3):
        return {'provider': 'commandcode', 'account': 1, 'at': at, 'plan': '', 'source': 'CodexBar · Mac', 'limits': [
            {'id': 'primary', 'label': '5 год', 'window': '5 год', 'windowMinutes': 300, 'remaining': five, 'resets': at * 1000 + 7e6},
            {'id': 'secondary', 'label': 'Тиждень', 'window': 'Тиждень', 'windowMinutes': 10080, 'remaining': week, 'resets': at * 1000 + 4e7},
            {'id': 'tertiary', 'label': 'Місяць', 'window': 'Місяць', 'windowMinutes': 43200, 'remaining': month, 'resets': at * 1000 + 7e8}]}

    def test_usage_report_keeps_balance_in_plan_units_without_inventing_a_percentage(self):
        from insights import usage_report
        report = self.commandcode_native(1, 0.686, 7.875, 3.68, 1791824654)
        five, week, balance = report['limits']
        self.assertEqual((five['remaining'], five['balance']), (95.1, {'remaining': 13.314, 'limit': 14, 'unit': 'credits'}))
        self.assertEqual(week['balance'], {'remaining': 27.125, 'limit': 35, 'unit': 'credits'})
        # The balance has no fraction and no window: its amount stays, its % stays unknown.
        self.assertEqual(balance['balance'], {'remaining': 3.68, 'unit': 'credits'})
        self.assertIsNone(balance['remaining'])
        self.assertIsNone(balance['resets'])
        odd = usage_report({'provider': 'p', 'fetchedAt': 1, 'limits': [
            {'id': 'f', 'label': 'F', 'amount': {'usedFraction': .5}},
            {'id': 'n', 'label': 'N', 'amount': {'remaining': float('nan'), 'unit': 'credits'}},
            {'id': 't', 'label': 'T', 'amount': {'remaining': True}},
            {'id': 'z', 'label': 'Z', 'amount': {'used': 3, 'limit': 0}}]}, 1)
        self.assertEqual([l.get('balance') for l in odd['limits']], [None] * 4, 'no absolute reading, no amount')

    def test_codexbar_month_joins_only_the_account_it_measured(self):
        from insights import commandcode_view
        now = 1791824900
        used = self.commandcode_native(1, 0.686, 7.875, 3.68, now - 240)
        fresh = self.commandcode_native(2, 0, 0, 70, now - 240)
        reports = commandcode_view([used, fresh], self.codexbar(now - 60), now)
        month = reports[0]['limits'][2]
        self.assertEqual((month['label'], month['window'], month['remaining'], month['windowMinutes'], month['source']),
                         ('Місяць', 'Місяць', 5.3, 43200, 'CodexBar · Mac'))
        self.assertEqual(month['resets'], (now - 60) * 1000 + 7e8)
        self.assertEqual(month['balance'], {'remaining': 3.68, 'unit': 'credits', 'limit': 70, 'estimated': True})
        other = reports[1]['limits'][2]
        # Same plan (5 h 14, week 35): the measured account's monthly cap applies, as an estimate, without a reset time.
        self.assertEqual((other['label'], other['window'], other['remaining'], other['resets'], other['planEstimate']),
                         ('Місяць', 'Місяць', 100.0, None, True))
        self.assertEqual(other['balance'], {'remaining': 70, 'unit': 'credits', 'limit': 70, 'estimated': True})
        bigger = json.loads(json.dumps(fresh))
        for limit in bigger['limits']:
            if limit.get('balance') and 'limit' in limit['balance']:
                limit['balance']['limit'] *= 2
        other = commandcode_view([used, bigger], self.codexbar(now - 60), now)[1]['limits'][2]
        self.assertEqual((other['remaining'], other['balance']), (None, {'remaining': 70, 'unit': 'credits'}),
                         'a different plan gets no borrowed cap')
        self.assertNotIn('Credit balance', json.dumps(reports, ensure_ascii=False))
        self.assertEqual([l['remaining'] for l in reports[0]['limits'][:2]], [95.1, 77.5], 'OMP keeps its own 5 h and week')
        # Within ±0.2 pt on both windows still matches; the 5-hour window alone does not.
        self.assertEqual(commandcode_view([used, fresh], self.codexbar(now - 60, 95.3, 77.3), now)[0]['limits'][2]['remaining'], 5.3)
        for why, external, pair in [
                ('5 h differs', self.codexbar(now - 60, 95.4), [used, fresh]),
                ('week differs', self.codexbar(now - 60, week=77.8), [used, fresh]),
                ('stale CodexBar', self.codexbar(now - 901), [used, fresh]),
                ('readings far apart', self.codexbar(now - 60), [self.commandcode_native(1, 0.686, 7.875, 3.68, now - 1000), fresh]),
                ('ambiguous', self.codexbar(now - 60, 100, 100), [self.commandcode_native(1, 0, 0, 70, now - 240), fresh]),
                ('no CodexBar', None, [used, fresh])]:
            with self.subTest(why):
                months = [r['limits'][2] for r in commandcode_view(pair, external, now)]
                self.assertEqual([(m['label'], m['remaining'], m['resets']) for m in months], [('Місяць', None, None)] * 2)
                self.assertNotIn('limit', months[0]['balance'])
                self.assertNotIn('source', months[0])

    def test_plan_cap_is_an_estimate_only_when_the_percentage_can_carry_it(self):
        from insights import plan_cap
        self.assertEqual([plan_cap(3.68, 5.3), plan_cap(70, 100), plan_cap(54.25, 77.5), plan_cap(150, 50)], [70, 70, 70, 300])
        self.assertEqual([plan_cap(0.5, 0.7), plan_cap(0, 50), plan_cap(3, None), plan_cap(3, 101)], [None] * 4)

    def test_snapshot_merges_codexbar_into_native_commandcode_and_keeps_it_alone_otherwise(self):
        now = time.time()
        native = [self.commandcode_native(1, 0.686, 7.875, 3.68, now - 120), self.commandcode_native(2, 0, 0, 70, now - 120)]
        (self.app.state_dir / 'commandcode-usage.json').write_text(json.dumps(self.codexbar(now - 30)))
        self.app.insights.data['usage'] = {'at': now, 'reports': native, 'error': ''}
        reports = self.app.insights.snapshot()['usage']['reports']
        self.assertEqual([r['provider'] for r in reports], ['commandcode', 'commandcode'], 'CodexBar adds no third account')
        self.assertEqual([r['limits'][2]['remaining'] for r in reports], [5.3, 100.0], 'same plan: the second month is an estimate')
        self.assertEqual(self.app.insights.data['usage']['reports'][0]['limits'][2]['label'], 'Credit balance', 'stored data stays native')
        self.app.insights.data['usage']['reports'] = []
        alone = self.app.insights.snapshot()['usage']['reports']
        self.assertEqual([(r['source'], r['stale']) for r in alone], [('CodexBar · Mac', False)])

    def test_failure_log_names_type_and_place_but_no_message(self):
        try:
            raise OSError(errno.ENOSPC, 'SECRET /private/path')
        except OSError as error:
            with patch('sys.stderr', new=io.StringIO()) as stderr:
                log_failure('test', error)
        line = stderr.getvalue()
        self.assertIn('OSError ENOSPC', line)
        self.assertIn('test_forge.py', line)
        self.assertNotIn('SECRET', line)
        self.assertNotIn('/private', line)
        self.assertEqual(Problem('x', 409, 'mode-conflict', profiles=['high']).body(), {'error': 'x', 'code': 'mode-conflict', 'profiles': ['high']})

    def test_tailscale_identity_requires_tailscaled_or_own_user(self):
        port = self.serve()
        self.app.origin, self.app.owner = 'https://panel.test', 'owner@example.test'
        headers = {'Host': 'panel.test', 'Tailscale-User-Login': self.app.owner}
        for uid, allowed in ((4242, False), (-1, False), (0, True), (os.getuid(), True), (None, True)):
            with self.subTest(uid=uid), patch('server.peer_uid', return_value=uid):
                try:
                    with urlopen(Request(f'http://127.0.0.1:{port}/api/state', headers=headers)) as response:
                        status = response.status
                except HTTPError as error:
                    status = error.code
                    error.close()
                self.assertEqual(status, 200 if allowed else 403)
        table = self.root/'tcp'
        table.write_text('  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
            '   0: 0100007F:4B65 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 11 1 0 20 4 30 10 -1\n'
            '   1: 0100007F:D431 0100007F:4B65 01 00000000:00000000 00:00000000 00000000     0        0 12 1 0 20 4 30 10 -1\n')
        self.assertEqual(peer_uid(54321, 19301, table), 0, 'the client socket, not the accepted one')
        self.assertEqual(peer_uid(1, 19301, table), -1)
        self.assertIsNone(peer_uid(1, 19301, self.root/'no-proc'))

    def test_http_keep_alive_gzip_validators_and_cache_headers(self):
        port = self.serve()
        static = Path(__file__).parent/'static'
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
        self.addCleanup(c.close)
        def get(path, **headers):
            c.request('GET', path, headers=headers)
            response = c.getresponse()
            return response, response.read()
        response, raw = get('/api/state', **{'Accept-Encoding': 'gzip'})
        self.assertEqual((response.getheader('Content-Encoding'), response.getheader('Cache-Control')), ('gzip', 'no-store'))
        self.assertIn('csrf', json.loads(gzip.decompress(raw)))
        tag, sock = response.getheader('ETag'), c.sock
        response, raw = get('/api/state', **{'If-None-Match': tag})
        self.assertEqual((response.status, raw, response.getheader('ETag')), (304, b'', tag))
        self.assertIs(c.sock, sock, 'one keep-alive connection')
        self.save([{'path': ['modelRoles', 'task'], 'value': 'demo/three'}])
        self.assertEqual(get('/api/state', **{'If-None-Match': tag})[0].status, 200)
        # The shell pins every local asset to its content; only that exact URL is immutable.
        response, shell = get('/')
        self.assertEqual(response.getheader('Cache-Control'), 'no-cache')
        pinned, icon = re.search(r'href="(/(device\.css)\?v=[0-9a-f]{12})"', shell.decode()).groups()
        self.assertNotIn('?v=42', shell.decode())
        response, raw = get(pinned, **{'Accept-Encoding': 'gzip'})
        self.assertEqual(gzip.decompress(raw), (static/icon).read_bytes())
        self.assertIn('immutable', response.getheader('Cache-Control'))
        self.assertEqual(response.getheader('Vary'), 'Accept-Encoding')
        self.assertEqual(get(pinned, **{'If-None-Match': response.getheader('ETag')})[0].status, 304)
        for path in ('/sw.js', '/icon.svg', '/icon.svg?v=42'):
            self.assertEqual(get(path)[0].getheader('Cache-Control'), 'no-cache', path)
        self.assertIs(c.sock, sock)
        # An unread body is never parsed as the next request on the connection.
        c.request('POST', '/api/favorites', b'{"values": []}', {'Content-Type': 'application/json'})
        response = c.getresponse(); response.read()
        self.assertEqual((response.status, response.will_close), (403, True))

    def test_shared_yaml_cache_follows_content_and_stays_read_only(self):
        p = self.app.path('high')
        self.assertEqual(self.app.snapshot()['presets']['high']['modelRoles']['task'], 'demo/two:high')
        stat = p.stat()
        p.write_text(p.read_text().replace('two', 'six'))
        os.utime(p, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assertEqual(p.stat().st_size, stat.st_size)
        self.assertEqual(self.app.snapshot()['presets']['high']['modelRoles']['task'], 'demo/six:high')
        body = {'profile': 'high', 'revision': self.app.revision('high'), 'changes': [], 'modeSettings': {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}}
        with patch('server.yaml_load', wraps=yaml_load) as parse:
            self.app.snapshot(); self.app.preview_profile(body)
        self.assertEqual(parse.call_count, 0, 'unchanged files are parsed once')
        shared = self.app.read(p, shared=True)
        with self.assertRaises(TypeError):
            shared['modelRoles']['task'] = 'demo/evil'
        with self.assertRaises(TypeError):
            shared.setdefault('retry', {})
        own = copy.deepcopy(shared)
        own['modelRoles']['task'] = 'demo/mine'
        self.assertIs(type(own['modelRoles']), dict)
        self.assertEqual(self.app.read(p, shared=True)['modelRoles']['task'], 'demo/six:high')

    def test_object_thinking_is_a_list_in_the_catalog(self):
        (self.agent/'models.yml').write_text('providers:\n  ext:\n    models:\n      - id: a\n        thinking: {mode: effort, efforts: [low, high]}\n')
        self.assertEqual(self.app.mode_catalog()['ext/a']['thinking'], ['low', 'high'])


if __name__=='__main__':unittest.main()
