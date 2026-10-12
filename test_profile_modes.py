"""Mode round trips and projection safety, using disposable OMP files only."""
import copy
import errno
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch

import test_forge
from server import Forge, Problem, merge, yaml_dump, atomic, fsync_dir, json_value
from profile_modes import compile_profile, route_statuses, is_deepseek, validate_settings, validate_pools


class ProfileModesTest(unittest.TestCase):
    def test_off_disables_thinking_without_being_an_effort_in_free_pools(self):
        from profile_modes import validate_pools
        model = {'id':'model:free', 'reasoning':True, 'thinking':['medium','xhigh'], 'cost':{'input':0,'output':0}}
        pools = {'free-good':['demo/model:off'], 'free-fast':[]}
        self.assertEqual(validate_pools(pools, {'demo/model':model}), pools)
        for effort in ('medium','xhigh'):
            validate_pools({'free-good':['demo/model:'+effort], 'free-fast':[]}, {'demo/model':model})
        with self.assertRaises(ValueError):
            validate_pools({'free-good':['demo/model:high'], 'free-fast':[]}, {'demo/model':model})

    def test_off_remains_an_available_deepseek_replacement(self):
        model = {'id':'model', 'reasoning':True, 'thinking':['medium','xhigh'], 'input':['text']}
        normal = {'modelRoles':{'task':'demo/deepseek-v4'}}
        settings = {'mode':'no-deepseek', 'alternatives':['demo/model:off'], 'overrides':{}}
        plan = compile_profile(normal, settings, {'demo/model':model}, {})
        self.assertEqual(plan['effective']['modelRoles']['task'], 'demo/model:off')
        self.assertEqual(plan['skipped'], [])

    setUp = test_forge.ForgeTest.setUp
    tearDown = test_forge.ForgeTest.tearDown

    def test_manual_yaml_free_price_saves_pool_before_native_refresh(self):
        from profile_modes import is_free_model
        (self.agent/'models.yml').write_text('''providers:
  manual:
    models:
      - id: sample-free
        name: Sample Free
        cost: {input: 0, output: 0.0, cacheRead: 0}
''')
        self.assertEqual(self.app.state['catalog'], {})
        model = self.app.mode_catalog()['manual/sample-free']
        self.assertTrue(is_free_model(model))
        pools = {'free-good': ['manual/sample-free'], 'free-fast': []}
        self.app.save_pools({'revision': self.app.pools_revision(), 'pools': pools})
        self.assertEqual(self.app.pools(), pools)
        for key in ('input', 'output'):
            with self.subTest(boolean_price=key):
                self.assertFalse(is_free_model({**model, 'cost': {**model['cost'], key: False}}))

    def test_bridge_free_label_is_accepted_by_shared_pools(self):
        from profile_modes import validate_pools, is_free_model
        model = {'id': 'big-pickle', 'name': '[FREE] Big Pickle', 'cost': {'input': 0, 'output': 0}}
        pools = {'free-good': ['opencode-free/big-pickle'], 'free-fast': []}
        self.assertEqual(validate_pools(pools, {'opencode-free/big-pickle': model}), pools)
        self.assertFalse(is_free_model({**model, 'cost': {'input': 0, 'output': 1}}))
        self.assertFalse(is_free_model({**model, 'cost': {}}))

    def test_verified_nvidia_free_route_saves_without_renaming_and_keeps_deepseek_on(self):
        from profile_modes import is_free_model
        self.init_modes()
        raw = 'nvidia/deepseek-ai/deepseek-v4.1-flash'
        model = {'provider': 'nvidia', 'id': 'deepseek-ai/deepseek-v4.1-flash',
                 'name': 'DeepSeek V4.1 Flash', 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}}
        self.app.state['catalog'][raw] = model
        self.assertFalse(is_free_model(model), 'zero alone is not FREE evidence')
        verified = self.app.mode_catalog()[raw]
        self.assertTrue(is_free_model(verified))
        snapshot = next(m for m in self.app.snapshot()['models'] if m['provider'] == 'nvidia')
        self.assertEqual(snapshot['freeEvidence'], verified['freeEvidence'])
        pools = {'free-good': [raw], 'free-fast': []}
        self.app.save_pools({'revision': self.app.pools_revision(), 'pools': pools})
        self.save_mode('high', self.settings, [{'path': ['modelRoles', 'task'], 'value': raw}])
        self.assertEqual(self.native('high')['modelRoles']['task'], raw)
        self.assertEqual(self.app.mode_state['profiles']['high']['catalog'][raw]['freeEvidence'], verified['freeEvidence'])
        self.assertEqual(model['name'], 'DeepSeek V4.1 Flash')
        self.assertNotIn('freeEvidence', model, 'the native catalog is not rewritten')
        for cost in ({}, {'input': 0, 'output': 1}, {'input': 1, 'output': 0},
                     {'input': 0, 'output': 0, 'cacheRead': 1}, {'input': 0, 'output': 0, 'cacheWrite': 1}):
            self.assertFalse(is_free_model({**verified, 'cost': cost}))
        # Neither another model nor another endpoint inherits this evidence.
        other = 'nvidia/deepseek-ai/deepseek-v4-flash'
        self.app.state['catalog'][other] = {**model, 'id': 'deepseek-ai/deepseek-v4-flash'}
        self.assertFalse(is_free_model(self.app.mode_catalog()[other]))
        (self.agent / 'models.yml').write_text('providers:\n  nvidia:\n    baseUrl: https://example.invalid/v1\n')
        self.assertFalse(is_free_model(self.app.mode_catalog()[raw]))

    def init_modes(self):
        for name in ('standard', 'high'):
            file = self.app.path(name)
            file.write_text(file.read_text().replace('demo/one', 'demo/deepseek-v4').replace('demo/two:high', 'demo/deepseek-v4:high'))
        self.app.state['catalog'] = {r: {'provider': 'demo', 'id': r.split('/')[1], 'name': r, 'thinking': ['high'], 'input': ['text']} for r in ['demo/deepseek-v4','demo/two','demo/three','demo/four']}
        self.app.state['available'] = list(self.app.state['catalog'])
        self.settings = {'mode':'no-deepseek', 'alternatives':['demo/two:high','demo/three'], 'overrides':{}}

    def save_mode(self, name='high', settings=None, changes=None):
        body={'profile': name, 'revision': self.app.revision(name), 'modeSettings': settings or self.settings, 'changes': changes or []}
        body['previewToken'] = self.app.preview_profile(body)['token']
        return self.app.save_profile(body)

    def native(self, name):
        result = merge(self.app.read(self.app.path('standard')), self.app.read(self.app.path(name)))
        chains=result['retry']['fallbackChains']
        result['retry']['fallbackChains']={r:chains.get(r,chains.get('default',[])) for r in result['modelRoles']}
        return result

    def init_pools(self):
        self.init_modes()
        for name in ('a', 'b', 'c', 'deepseek'):
            raw = 'demo/'+name+':free'
            self.app.state['catalog'][raw] = {'id':name+':free', 'provider':'demo', 'cost':{'input':0,'output':0}, 'input':['text','image'], 'thinking':['high','low']}
        self.pools = {'free-good':['demo/a:free:high','demo/deepseek:free'], 'free-fast':['demo/b:free']}
        self.app.save_pools({'revision':self.app.pools_revision(), 'pools':self.pools})

    def test_shared_pools_expand_every_profile_keep_aliases_and_survive_restart(self):
        self.init_pools()
        settings = {'mode':'deepseek','alternatives':[],'overrides':{}}
        for name in ('standard','high'):
            self.save_mode(name, settings, [{'path':['modelRoles','task'],'value':'mana-pool/free-good'},
                {'path':['retry','fallbackChains','task'],'value':['mana-pool/free-fast']},
                {'path':['task','agentModelOverrides','task'],'value':['@task','mana-pool/free-fast']}])
            self.assertEqual(self.native(name)['modelRoles']['task'],'demo/a:free:high')
            self.assertEqual(self.native(name)['task']['agentModelOverrides']['task'],['@task','demo/deepseek:free','demo/b:free'])
            self.assertEqual(self.app.mode_state['profiles'][name]['views']['role']['task']['routes'],['mana-pool/free-good','mana-pool/free-fast'])
        self.pools['free-good']=['demo/c:free:low','demo/a:free']
        stale = self.app.revision('high')
        self.app.save_pools({'revision':self.app.pools_revision(),'pools':self.pools})
        self.assertNotEqual(stale,self.app.revision('high'))
        for name in ('standard','high'):
            self.assertNotIn('mana-pool/',self.app.path(name).read_text())
            self.assertEqual(self.native(name)['modelRoles']['task'],'demo/c:free:low')
            self.assertEqual(self.native(name)['retry']['fallbackChains']['task'],['demo/a:free','demo/b:free'])
        self.app = Forge(self.project,self.agent,self.root/'state','/does-not-exist')
        self.assertEqual(self.app.pools(),self.pools)
        self.assertEqual(self.app.profiles()[1]['high']['modelRoles']['task'],'mana-pool/free-good')

    def test_singleton_agent_alias_keeps_full_role_retry_chain_in_both_modes(self):
        models = {r: {'id': r.split('/')[1], 'input': ['text']} for r in
                  ('demo/deepseek-v4', 'demo/first', 'demo/second', 'demo/extra')}
        pools = {'free-good': ['demo/first', 'demo/second']}
        for original in ('@researcher', ['@researcher']):
            for primary in ('mana-pool/free-good', 'demo/deepseek-v4'):
                for mode in ('deepseek', 'no-deepseek'):
                    with self.subTest(original=original, primary=primary, mode=mode):
                        normal = {'modelRoles': {'researcher': primary},
                                  'retry': {'fallbackChains': {'researcher': ['demo/extra']}},
                                  'task': {'agentModelOverrides': {'helper': original}}}
                        settings = {'mode': mode, 'alternatives': ['mana-pool/free-good'], 'overrides': {}}
                        plan = compile_profile(normal, settings, models, {}, pools)
                        self.assertFalse(plan['issues'])
                        native = plan['effective']
                        self.assertEqual(native['task']['agentModelOverrides']['helper'], original)
                        expanded = primary.startswith('mana-pool/') or mode == 'no-deepseek'
                        self.assertEqual(native['modelRoles']['researcher'], 'demo/first' if expanded else primary)
                        self.assertEqual(native['retry']['fallbackChains']['researcher'],
                                         ['demo/second', 'demo/extra'] if expanded else ['demo/extra'])
                        view = plan['views']['vibe']['helper']
                        self.assertEqual(view['routes'], [native['modelRoles']['researcher']])
                        self.assertEqual(view['linkedRole'], 'researcher')
                        self.assertFalse(view['substituted'])

    def test_singleton_alias_pool_save_restart_and_legacy_views_stay_read_only(self):
        base = self.app.read(self.app.path('standard'))
        base['task']['agentModelOverrides']['task'] = '@task'
        self.app.path('standard').write_text(yaml_dump(base))
        self.init_pools()
        settings = {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}
        self.save_mode('high', settings, [
            {'path': ['modelRoles', 'task'], 'value': 'mana-pool/free-good'},
            {'path': ['retry', 'fallbackChains', 'task'], 'value': ['demo/four']}])
        self.pools['free-good'] = ['demo/c:free:low', 'demo/a:free']
        self.app.save_pools({'revision': self.app.pools_revision(), 'pools': self.pools})
        self.app = Forge(self.project, self.agent, self.root/'state', '/does-not-exist')
        native = self.native('high')
        self.assertEqual(native['task']['agentModelOverrides']['task'], '@task')
        self.assertEqual(native['modelRoles']['task'], 'demo/c:free:low')
        self.assertEqual(native['retry']['fallbackChains']['task'], ['demo/a:free', 'demo/four'])
        # Older versions did not save views for every configured agent. Reading
        # their state must neither migrate nor recompile the native files.
        self.app.mode_state['profiles']['high']['views']['vibe'].pop('task')
        before = {n: self.app.path(n).read_bytes() for n in ('standard', 'high')}
        metadata = copy.deepcopy(self.app.mode_state)
        self.assertNotIn('task', self.app.snapshot()['profileModes']['high']['views']['vibe'])
        preview = self.app.preview_profile({'profile': 'high', 'revision': self.app.revision('high'),
                                            'modeSettings': settings, 'changes': []})
        self.assertEqual(preview['views']['vibe']['task']['linkedRole'], 'task')
        self.assertEqual(preview['views']['vibe']['task']['routes'], ['demo/c:free:low'])
        self.assertEqual(self.app.mode_state, metadata)
        self.assertEqual({n: self.app.path(n).read_bytes() for n in before}, before)

    def test_singleton_alias_without_explicit_role_is_left_for_omp(self):
        for original in ('@builtin', ['@builtin']):
            normal = {'task': {'agentModelOverrides': {'helper': original}}}
            for mode in ('deepseek', 'no-deepseek'):
                with self.subTest(original=original, mode=mode):
                    plan = compile_profile(normal, {'mode': mode, 'alternatives': [], 'overrides': {}}, {}, {})
                    self.assertFalse(plan['issues'])
                    self.assertEqual(plan['effective'], normal)
                    view = plan['views']['vibe']['helper']
                    self.assertTrue(view['unresolved'])
                    self.assertEqual(view['linkedRole'], 'builtin')
                    self.assertEqual(view['routes'], ['@builtin'])

    def test_pool_save_rejects_paid_nested_empty_used_and_stale_without_writes(self):
        self.init_pools()
        self.save_mode('high', {'mode':'deepseek','alternatives':[],'overrides':{}}, [
            {'path':['retry','fallbackChains','task'],'value':['mana-pool/free-good', *['demo/long-'+str(i) for i in range(28)]]}])
        before={n:self.app.path(n).read_bytes() for n in ('standard','high')}; metadata=copy.deepcopy(self.app.mode_state)
        for routes in ([], ['demo/two'], ['mana-pool/free-fast'], ['demo/a:free:max']):
            with self.assertRaises(Problem):
                self.app.save_pools({'revision':self.app.pools_revision(),'pools':{**self.pools,'free-good':routes}})
            self.assertEqual(self.app.mode_state,metadata)
            self.assertEqual({n:self.app.path(n).read_bytes() for n in before},before)
        with self.assertRaises(Problem):self.app.save_pools({'revision':'stale','pools':self.pools})

    def test_large_pool_saves_all_dependents_without_truncation_and_survives_restart(self):
        self.init_pools()
        settings = {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}
        for name in ('standard', 'high'):
            self.save_mode(name, settings, [
                {'path': ['modelRoles', 'task'], 'value': 'mana-pool/free-good'},
                {'path': ['retry', 'fallbackChains', 'task'], 'value': ['mana-pool/free-fast']},
                {'path': ['task', 'agentModelOverrides', 'task'], 'value': ['@task', 'mana-pool/free-fast']}])
        routes = ['demo/large-'+str(i)+':free' for i in range(100)]
        for route in routes:
            self.app.state['catalog'][route] = {'provider': 'demo', 'id': route.split('/', 1)[1],
                'name': route, 'input': ['text', 'image'], 'cost': {'input': 0, 'output': 0}}
        self.pools['free-good'] = routes
        self.app.save_pools({'revision': self.app.pools_revision(), 'pools': self.pools})
        expected = routes + self.pools['free-fast']
        for name in ('standard', 'high'):
            native = self.native(name)
            self.assertEqual([native['modelRoles']['task'], *native['retry']['fallbackChains']['task']], expected)
            self.assertEqual(native['task']['agentModelOverrides']['task'], ['@task', *expected[1:]])
            self.assertNotIn('mana-pool/', self.app.path(name).read_text())
        restarted = Forge(self.project, self.agent, self.app.state_dir, '/does-not-exist')
        self.assertEqual(restarted.pools(), self.pools)
        self.assertEqual(restarted.mode_conflicts(), [])
        # A large pool also works as a DeepSeek replacement.
        normal = {'modelRoles': {'task': 'demo/deepseek-v4'}, 'task': {'agentModelOverrides': {'task': ['@task', 'demo/two']}}}
        plan = compile_profile(normal, {'mode': 'no-deepseek', 'alternatives': ['mana-pool/free-good'], 'overrides': {}}, self.app.mode_catalog(), {}, self.pools)
        self.assertEqual(plan['issues'], [])

    def test_pool_multi_file_failure_recovers_all_profiles_and_pool_metadata(self):
        self.init_pools()
        for name in ('standard','high'):
            self.save_mode(name, {'mode':'deepseek','alternatives':[],'overrides':{}}, [{'path':['modelRoles','task'],'value':'mana-pool/free-good'}])
        before={n:self.app.path(n).read_bytes() for n in ('standard','high')}; metadata=copy.deepcopy(self.app.mode_state)
        failed = False
        def fail_once(path, *args):
            nonlocal failed
            if path == self.app.path('high') and not failed:
                failed=True;raise OSError('simulated pool write failure')
            return atomic(path,*args)
        with patch('server.atomic',side_effect=fail_once):
            with self.assertRaises(OSError):self.app.save_pools({'revision':self.app.pools_revision(),'pools':{**self.pools,'free-good':['demo/c:free']}})
        self.assertTrue(failed)
        self.assertEqual(self.app.mode_state,metadata)
        self.assertEqual({n:self.app.path(n).read_bytes() for n in before},before)

    def test_pools_in_deepseek_replacements_and_default_fallbacks_never_leak_tokens(self):
        self.init_pools()
        self.settings['alternatives']=['demo/two','mana-pool/free-good']
        self.save_mode('high')
        self.assertEqual(self.native('high')['task']['agentModelOverrides']['task'],['@task','demo/a:free:high','demo/deepseek:free'])
        self.assertNotIn('mana-pool/',self.app.path('high').read_text())
        self.save_mode('standard', {'mode':'deepseek','alternatives':[],'overrides':{}}, [{'path':['retry','fallbackChains','default'],'value':['mana-pool/free-fast']}])
        self.assertNotIn('mana-pool/',self.app.path('standard').read_text())
        self.assertEqual(self.native('standard')['retry']['fallbackChains']['default'],['demo/b:free'])

    def test_pool_primary_replacement_alias_follows_exact_filtered_members_once(self):
        self.init_pools()
        self.settings['alternatives']=['mana-pool/free-good','mana-pool/free-fast']
        self.app.state['catalog']['demo/a:free']['status']='missing'
        self.save_mode('high')
        self.assertEqual(self.native('high')['modelRoles']['task'],'demo/deepseek:free')
        self.assertEqual(self.native('high')['task']['agentModelOverrides']['task'],['@task','demo/b:free','demo/two'])
        view=self.app.mode_state['profiles']['high']['views']['vibe']['task']
        self.assertEqual(view['routes'],['mana-pool/free-good','mana-pool/free-fast','demo/two'])
        self.assertNotIn('mana-pool/',self.app.path('high').read_text())

    def test_pool_vision_validation_and_clone_keep_shared_reference(self):
        self.init_pools()
        normal=self.native('high');normal['modelRoles']['vision']='mana-pool/free-good'
        settings={'mode':'deepseek','alternatives':[],'overrides':{}}
        self.app.state['catalog']['demo/a:free']['input']=['text']
        self.assertTrue(compile_profile(normal,settings,self.app.mode_catalog(),{},self.pools)['issues'])
        self.save_mode('high',settings,[{'path':['modelRoles','task'],'value':'mana-pool/free-good'}])
        self.app.profile_action({'profile':'high','action':'clone','name':'pool-copy'})
        self.assertEqual(self.app.profiles()[1]['pool-copy']['modelRoles']['task'],'mana-pool/free-good')
        self.pools['free-good']=['demo/c:free:low']
        self.app.save_pools({'revision':self.app.pools_revision(),'pools':self.pools})
        for name in ('high','pool-copy'):
            self.assertEqual(self.native(name)['modelRoles']['task'],'demo/c:free:low')

    def test_roundtrip_permanent_edit_and_restart(self):
        self.init_modes(); base = self.app.path('standard').read_bytes()
        self.save_mode(changes=[{'path':['modelRoles','scout'],'value':'demo/four'}])
        self.assertEqual(self.native('high')['modelRoles']['task'],'demo/two:high')
        self.assertEqual(self.native('high')['retry']['fallbackChains']['task'],['demo/three'])
        self.assertEqual(self.native('high')['task']['agentModelOverrides']['task'],['@task','demo/three'])
        self.app.persist()
        self.app = Forge(self.project,self.agent,self.root/'state','/does-not-exist')
        self.assertEqual(self.app.profiles()[1]['high']['modelRoles']['task'],'demo/deepseek-v4:high')
        self.settings['mode']='deepseek';self.save_mode()
        self.assertEqual(self.native('high')['modelRoles']['task'],'demo/deepseek-v4:high')
        self.assertEqual(self.native('high')['modelRoles']['scout'],'demo/four')
        self.assertEqual(self.app.path('standard').read_bytes(),base)
        self.assertIn('# overlay',self.app.path('high').read_text())

    def test_failed_clone_leaves_no_file_or_mode_record(self):
        self.init_modes(); self.save_mode()
        before = {n:self.app.path(n).read_bytes() for n in ('standard','high')}
        records = copy.deepcopy(self.app.mode_state)
        missing = {r:{**m,'status':'missing'} for r,m in self.app.mode_catalog().items()}
        with patch.object(self.app, 'mode_catalog', return_value=missing):
            with self.assertRaises(Problem):
                self.app.profile_action({'action':'clone','profile':'high','name':'unavailable'})
        self.assertFalse(self.app.path('unavailable').exists())
        self.assertEqual(self.app.mode_state, records)
        self.assertEqual({n:self.app.path(n).read_bytes() for n in before}, before)
        self.save_mode()  # A failed copy cannot block the next normal save.

    def test_clone_write_failure_recovers_creation_journal(self):
        self.init_modes(); self.save_mode()
        target = self.app.path('failed-copy')
        from server import create_new
        def fail_creation(path, *args):
            if path == target:
                raise OSError('simulated disk error')
            return create_new(path, *args)
        # New profiles are created exclusively, never by replacing a file.
        with patch('server.create_new', side_effect=fail_creation):
            with self.assertRaises(OSError):
                self.app.profile_action({'action':'clone','profile':'high','name':'failed-copy'})
        self.assertFalse(target.exists())
        self.assertNotIn('failed-copy', self.app.mode_state['profiles'])
        self.assertFalse(self.app.mode_journal.exists())
        self.save_mode()

    def test_standard_projection_keeps_other_profiles_independent(self):
        self.init_modes();self.app.path('other').write_text('# only inherits\nunrelated: 42\n')
        before = {n:self.native(n) for n in ['high','other']}
        self.save_mode('standard')
        self.assertEqual(self.native('standard')['modelRoles']['default'],'demo/two:high')
        for n in before:self.assertEqual(self.native(n),before[n],n)
        self.save_mode('high')
        self.settings['mode']='deepseek';self.save_mode('standard')
        self.assertEqual(self.native('high')['modelRoles']['task'],'demo/two:high')
        self.assertEqual(self.native('other'),before['other'])
        self.assertEqual(self.app.path('other').read_text(),'# only inherits\nunrelated: 42\n')
        self.save_mode('high')
        self.assertEqual(self.native('high'),before['high'])

    def test_unavailable_candidates_and_vision(self):
        self.init_modes();models=self.app.state['catalog'];normal=self.native('high')
        statuses=route_statuses(models, {'demo': {'expired': True}})
        plan=compile_profile(normal,self.settings,models,statuses)
        self.assertTrue(plan['issues']);self.assertTrue(plan['skipped'])
        normal['modelRoles']['vision']='demo/deepseek-v4'
        self.assertTrue(compile_profile(normal,self.settings,models,{})['issues'])
        models['demo/three']['input']=['text','image']
        plan=compile_profile(normal,self.settings,models,{})
        self.assertEqual(plan['effective']['modelRoles']['vision'],'demo/three')
        self.assertFalse(plan['issues'])

    def test_free_deepseek_keeps_routes_thinking_and_roundtrips(self):
        self.init_modes()
        free='demo/deepseek-v4:free'
        named='demo/deepseek-named'
        self.app.state['catalog'].update({
            free: {'id':'deepseek-v4:free','cost':{'input':0,'output':0},'thinking':['high'],'input':['text']},
            named: {'id':'deepseek-named','name':'DeepSeek (FREE)','cost':{'input':0,'output':0},'input':['text']}})
        self.settings['alternatives']=['demo/two:high',named]
        changes=[{'path':['modelRoles','task'],'value':free+':high'},
                 {'path':['retry','fallbackChains','task'],'value':['demo/deepseek-v4','demo/four',named]},
                 {'path':['task','agentModelOverrides','task'],'value':['@task','demo/deepseek-v4','demo/four',named]}]
        preview=self.app.preview_profile({'profile':'high','revision':self.app.revision('high'),'modeSettings':self.settings,'changes':changes})
        expected=[free+':high','demo/two:high',named,'demo/four']
        self.assertEqual(preview['views']['role']['task']['routes'],expected)
        self.assertEqual(preview['views']['vibe']['task']['routes'],expected)
        self.save_mode(changes=changes)
        self.assertEqual([self.native('high')['modelRoles']['task'],*self.native('high')['retry']['fallbackChains']['task']],expected)
        before=self.native('high')
        # A saved mode retains FREE identity even when the live catalog changes.
        self.app.state['catalog'][free]['cost']['input']=1
        self.app.state['catalog'][named]['cost']['input']=1
        self.save_mode('standard',settings={**self.settings,'mode':'deepseek','alternatives':[]})
        self.assertEqual(self.native('high'),before)
        self.settings={'mode':'deepseek','alternatives':[],'overrides':{}}
        self.save_mode()
        self.assertEqual(self.native('high')['modelRoles']['task'],free+':high')
        self.assertEqual(self.native('high')['retry']['fallbackChains']['task'],['demo/deepseek-v4','demo/four',named])

    def test_only_confirmed_free_deepseek_is_allowed_as_replacement(self):
        for route,model,paused in [
            ('p/deepseek-v4:free',{'id':'deepseek-v4:free','cost':{'input':0,'output':0}},False),
            ('p/deepseek-v4',{'id':'deepseek-v4','name':'DeepSeek (free)','cost':{'input':0,'output':0}},False),
            ('p/deepseek-v4:free',{'id':'deepseek-v4:free'},True),
            ('p/deepseek-v4:free',{'id':'deepseek-v4:free','cost':{'input':0,'output':1}},True),
            ('p/deepseek-v4:free',{'id':'deepseek-v4:free','cost':{'input':0,'output':0,'cacheRead':1}},True),
            ('p/deepseek-v4',{'id':'deepseek-v4','cost':{'input':0,'output':0}},True)]:
            models={route:model};settings={'mode':'no-deepseek','alternatives':[route+':high'],'overrides':{}}
            self.assertEqual(is_deepseek(route+':high',models),paused)
            if paused:
                with self.assertRaises(ValueError):validate_settings(settings,{'task'},models)
            else:
                self.assertEqual(validate_settings(settings,{'task'},models),settings)

    def test_overrides_and_paused_fallbacks(self):
        self.init_modes();normal=self.native('high')
        normal['retry']['fallbackChains']['scout']=['demo/deepseek-v4','demo/two']
        self.settings['overrides']['role:task']=['demo/four']
        plan=compile_profile(normal,self.settings,self.app.state['catalog'],{})
        self.assertEqual(plan['effective']['modelRoles']['task'],'demo/four')
        self.assertEqual(plan['effective']['modelRoles']['scout'],'demo/three')
        self.assertEqual(plan['effective']['retry']['fallbackChains']['scout'],['demo/two:high'])
        self.assertEqual(plan['views']['role']['scout']['paused'][0]['index'],1)
        self.settings['mode']='deepseek'
        self.assertEqual(compile_profile(normal,self.settings,{}, {})['effective'],normal)
        self.assertEqual(compile_profile(normal,self.settings,{}, {})['views']['role']['smol']['routes'],['demo/two','demo/three'])

    def test_fallback_gap_gets_one_ordered_replacement_chain(self):
        self.init_modes();normal=self.native('high')
        normal['modelRoles']['scout']='demo/four'
        normal['retry']['fallbackChains']['scout']=['demo/three','demo/deepseek-v4','demo/two','demo/deepseek-v4:high']
        original=copy.deepcopy(normal)
        plan=compile_profile(normal,self.settings,self.app.state['catalog'],{})
        view=plan['views']['role']['scout']
        self.assertEqual(view['routes'],['demo/four','demo/three','demo/two:high'])
        self.assertEqual([r['kind'] for r in view['refs']],['base','base','replacement'])
        self.assertEqual([p['index'] for p in view['paused']],[2,4])
        self.assertEqual(normal,original)
        self.settings['mode']='deepseek'
        self.assertEqual(compile_profile(normal,self.settings,{}, {})['effective'],original)

    def test_five_replacements_after_gpu_skip_missing_and_keep_other_tracks(self):
        self.init_modes();normal=self.native('high');models=self.app.state['catalog']
        for name in ['gpu','a','b','c','d','e']:
            models['demo/'+name]={'input':['text'],'thinking':[]}
        normal['modelRoles']['scout']='demo/gpu'
        normal['retry']['fallbackChains']['scout']=['demo/deepseek-v4','demo/deepseek-v4:high']
        normal['task']['agentModelOverrides']['sonic']=['@scout','demo/deepseek-v4']
        self.settings['alternatives']=['demo/'+v for v in 'abcde']
        models['demo/a']['status']='missing'
        statuses=route_statuses(models,{})
        plan=compile_profile(normal,self.settings,models,statuses)
        self.assertEqual(plan['views']['role']['scout']['routes'],['demo/gpu',*[f'demo/{v}' for v in 'bcde']])
        self.assertEqual(plan['effective']['task']['agentModelOverrides']['sonic'],['@scout',*[f'demo/{v}' for v in 'bcde']])
        self.assertEqual(plan['views']['role']['smol']['routes'],['demo/two','demo/three'])
        self.assertEqual(plan['views']['role']['scout']['refs'][1]['original'],'demo/deepseek-v4')

    def test_save_fallback_replacement_then_on_restores_positions(self):
        self.init_modes()
        changes=[{'path':['retry','fallbackChains','scout'],'value':['demo/deepseek-v4','demo/two']}]
        self.save_mode(changes=changes)
        self.assertEqual(self.native('high')['modelRoles']['scout'],'demo/three')
        self.assertEqual(self.native('high')['retry']['fallbackChains']['scout'],['demo/two:high'])
        self.settings['mode']='deepseek';self.save_mode()
        self.assertEqual(self.native('high')['retry']['fallbackChains']['scout'],['demo/deepseek-v4','demo/two'])

    def test_preview_stale_and_external_edits_rejected(self):
        self.init_modes();body={'profile':'high','revision':self.app.revision('high'),'modeSettings':self.settings,'changes':[]}
        body['previewToken']=self.app.preview_profile(body)['token']
        changed=copy.deepcopy(body);changed['modeSettings']['alternatives']=['demo/four']
        with self.assertRaises(Problem):self.app.save_profile(changed)
        self.app.save_profile(body)
        with self.app.path('high').open('a') as f:f.write('# outside\n')
        before=self.app.path('high').read_bytes()
        with self.assertRaises(Problem):self.save_mode()
        self.assertEqual(self.app.path('high').read_bytes(),before)
        self.assertEqual(self.app.mode_conflicts(),['high'])

    def test_metadata_revision_and_actions(self):
        self.init_modes();self.settings['mode']='deepseek';self.save_mode()
        raw=self.app.path('high').read_bytes();revision=self.app.revision('high')
        self.settings['alternatives']=['demo/four'];self.save_mode()
        self.assertEqual(raw,self.app.path('high').read_bytes());self.assertNotEqual(revision,self.app.revision('high'))
        revision=self.app.revision('high')
        self.app.profile_action({'action':'rename','profile':'high','name':'Renamed','revision':revision})
        self.assertEqual(revision,self.app.revision('renamed'))
        self.app.profile_action({'action':'clone','profile':'renamed','name':'  Copied  '})
        self.assertEqual(self.app.mode_state['profiles']['copied']['settings'],self.settings)
        self.app.profile_action({'action':'restore','profile':'renamed','revision':self.app.revision('renamed')})
        self.assertEqual(self.app.mode_state['profiles']['renamed']['settings']['alternatives'],['demo/two:high','demo/three'])
        self.app.profile_action({'action':'delete','profile':'copied','revision':self.app.revision('copied')})
        self.assertNotIn('copied',self.app.mode_state['profiles'])

    def test_interrupted_transaction_recovers_old_files(self):
        self.init_modes();before={n:self.app.path(n).read_bytes() for n in ['standard','high']}
        failed=False
        def fail_once(path,data,*args):
            nonlocal failed
            if path==self.app.path('high') and not failed:
                failed=True;raise OSError('simulated storage failure')
            return atomic(path,data,*args)
        with patch('server.atomic',side_effect=fail_once):
            with self.assertRaises(OSError):self.save_mode('standard')
        for n in before:self.assertEqual(self.app.path(n).read_bytes(),before[n])
        self.assertFalse(self.app.mode_journal.exists())
        self.assertEqual(self.app.mode_state,{'profiles':{}})

    def test_five_replacements_ignore_exhausted_quota_in_preview_and_save(self):
        self.init_modes()
        routes=['demo/'+v+':high' for v in ['a','b','c','d','e']]
        for route in routes:
            self.app.state['catalog'][route.removesuffix(':high')]={'input':['text','image'],'thinking':['high']}
        self.settings['alternatives']=routes
        changes=[{'path':['modelRoles','smol'],'value':'demo/four'},
                 {'path':['retry','fallbackChains','smol'],'value':['demo/deepseek-v4','demo/two']},
                 {'path':['task','agentModelOverrides','sonic'],'value':['@smol','demo/deepseek-v4','demo/two']}]
        body={'profile':'high','revision':self.app.revision('high'),'modeSettings':self.settings,'changes':changes}
        before=self.app.preview_profile(body)
        with patch.object(self.app.insights,'snapshot',return_value={'usage':{'reports':[{'provider':'demo','at':time.time(),'limits':[{'label':'all','remaining':0}]}]}}):
            preview=self.app.preview_profile(body)
            self.assertEqual(preview['token'],before['token'])
            self.assertEqual(preview['skipped'],[])
            self.assertEqual(preview['views']['role']['task']['routes'],[*routes,'demo/two'])
            self.assertEqual(preview['views']['vibe']['task']['routes'],[*routes,'demo/two'])
            self.assertEqual(preview['views']['role']['smol']['routes'],['demo/four',*routes,'demo/two'])
            self.assertEqual(preview['views']['vibe']['sonic']['routes'],['demo/four',*routes,'demo/two'])
            self.app.save_profile({**body,'previewToken':preview['token']})
        self.assertEqual([self.native('high')['modelRoles']['task'],*self.native('high')['retry']['fallbackChains']['task']],[*routes,'demo/two'])

    def test_completed_transaction_recovers_new_metadata(self):
        self.init_modes();self.save_mode()
        after=copy.deepcopy(self.app.mode_state)
        journal={'files':{'high':{'before':'# old','after':self.app.path('high').read_text()}},'beforeState':{'profiles':{}},'afterState':after}
        self.app.mode_journal.write_text(json.dumps(journal))
        self.app.mode_file.write_text(json.dumps({'profiles':{}}))
        app=Forge(self.project,self.agent,self.root/'state','/does-not-exist')
        self.assertEqual(app.mode_state,after)
        self.assertFalse(app.mode_journal.exists())

    def test_inherited_standard_edit_survives_child_mode(self):
        self.init_modes();self.save_mode('high')
        on={**self.settings,'mode':'deepseek'}
        self.save_mode('standard',on,[{'path':['modelRoles','scout'],'value':'demo/four'}])
        self.assertEqual(self.native('high')['modelRoles']['scout'],'demo/four')
        self.assertEqual(self.native('high')['modelRoles']['task'],'demo/two:high')
        self.save_mode('high',on)
        self.assertEqual(self.native('high')['modelRoles']['scout'],'demo/four')
        self.assertEqual(self.native('high')['modelRoles']['task'],'demo/deepseek-v4:high')

    def test_other_profile_save_does_not_reselect_saved_routes(self):
        self.init_modes();self.save_mode('high')
        before=self.native('high')
        del self.app.state['catalog']['demo/two']
        on={**self.settings,'mode':'deepseek'}
        self.save_mode('standard',on)
        self.assertEqual(self.native('high'),before)
        body={'profile':'high','revision':self.app.revision('high'),'modeSettings':self.settings,'changes':[]}
        preview=self.app.preview_profile(body)
        self.assertEqual(preview['views']['role']['task']['routes'][0],'demo/three')

    # Interrupted transactions, outside edits and YAML the compiler did not write.

    def mode_body(self, name, settings=None, changes=()):
        body = {'profile': name, 'revision': self.app.revision(name), 'modeSettings': settings or self.settings, 'changes': list(changes)}
        body['previewToken'] = self.app.preview_profile(body)['token']
        return body

    def test_failed_rollback_refuses_every_write_and_recovers_later(self):
        self.init_modes()
        before = {n: self.app.path(n).read_bytes() for n in ('standard', 'high')}
        body = self.mode_body('standard')
        full = {'on': False}
        def disk(path, data, *args):
            if full['on']:
                raise OSError(errno.ENOSPC, 'No space left on device')
            atomic(path, data, *args)
            full['on'] = path.name == 'config.yml'
        with patch('server.atomic', side_effect=disk):
            with self.assertRaises(OSError):
                self.app.save_profile(body)
            journal = self.app.mode_journal.read_bytes()
            self.assertNotEqual(self.app.path('standard').read_bytes(), before['standard'])
            attempts = {
                'preview': lambda: self.app.preview_profile({'profile': 'high', 'revision': self.app.revision('high'), 'modeSettings': self.settings, 'changes': []}),
                'pools': lambda: self.app.save_pools({'revision': self.app.pools_revision(), 'pools': {'free-good': [], 'free-fast': []}}),
                'legacy': lambda: self.app.save_profile({'profile': 'high', 'revision': 'any', 'changes': []}),
                'rename': lambda: self.app.profile_action({'action': 'rename', 'profile': 'high', 'name': 'night', 'revision': self.app.revision('high')}),
                'provider': lambda: self.app.provider_save({'id': 'temporary'}),
            }
            for name, attempt in attempts.items():
                with self.subTest(refused=name), self.assertRaises(Problem) as refused:
                    attempt()
                self.assertEqual(refused.exception.code, 'mode-recovery')
            # The unfinished journal is never overwritten by a later save.
            self.assertEqual(self.app.mode_journal.read_bytes(), journal)
            self.assertTrue(self.app.snapshot()['modeRecovery']['error'])
        self.app.writable()  # Space is back: the next write first rolls the transaction back.
        self.assertEqual({n: self.app.path(n).read_bytes() for n in before}, before)
        self.assertFalse(self.app.mode_journal.exists())
        self.assertEqual(self.app.mode_state, {'profiles': {}})
        self.assertIsNone(self.app.snapshot()['modeRecovery'])
        self.save_mode('standard')
        self.assertIn('deepseek', self.app.mode_state['profiles']['standard']['normal'])

    def test_transaction_never_overwrites_an_unfinished_journal(self):
        self.app.mode_journal.write_text(json.dumps({'files': {}, 'beforeState': {'profiles': {}}, 'afterState': {'profiles': {}}}))
        raw = self.app.mode_journal.read_bytes()
        with self.assertRaises(Problem) as refused:
            self.app.transact({}, {'profiles': {}})
        self.assertEqual(refused.exception.code, 'mode-recovery')
        self.assertEqual(self.app.mode_journal.read_bytes(), raw)

    def test_outside_edit_during_transaction_waits_for_adopt_even_after_restart(self):
        self.init_modes()
        before = self.app.path('standard').read_bytes()
        body = self.mode_body('standard')
        def racing(path, data, *args):
            atomic(path, data, *args)
            if path.name == 'config.yml':
                with self.app.path('high').open('a') as f:
                    f.write('# owner edit\n')
        with patch('server.atomic', side_effect=racing), self.assertRaises(Problem):
            self.app.save_profile(body)
        self.assertEqual(self.app.path('standard').read_bytes(), before, 'our half of the write is rolled back')
        self.assertIn('# owner edit', self.app.path('high').read_text())
        self.assertTrue(self.app.mode_journal.exists())
        restarted = Forge(self.project, self.agent, self.root/'state', '/does-not-exist')  # no crash loop
        self.assertEqual(restarted.snapshot()['modeRecovery']['files'], ['high'])
        with self.assertRaises(Problem) as refused:
            restarted.save_pools({'revision': restarted.pools_revision(), 'pools': {'free-good': [], 'free-fast': []}})
        self.assertEqual((refused.exception.code, refused.exception.details['files']), ('mode-recovery', ['high']))
        restarted.profile_action({'action': 'adopt', 'profile': 'high', 'revision': restarted.revision('high')})
        self.assertFalse(restarted.mode_journal.exists())
        self.assertIn('# owner edit', restarted.path('high').read_text())
        self.assertTrue(list((restarted.state_dir/'backups').glob('*-profile-mode-transaction.json')))
        self.app = restarted
        self.save_mode('standard')

    def test_crlf_profiles_recover_as_exact_bytes(self):
        self.init_modes()
        crlf = b'# overlay\r\nmodelRoles:\r\n  task: demo/deepseek-v4:high\r\n'
        self.app.path('high').write_bytes(crlf)
        body = self.mode_body('high')
        def failing(path, data, *args):
            if path.name == 'high.yml':
                raise OSError(errno.ENOSPC, 'No space left on device')
            return atomic(path, data, *args)
        with patch('server.atomic', side_effect=failing), self.assertRaises(OSError):
            self.app.save_profile(body)
        self.assertEqual(self.app.path('high').read_bytes(), crlf)
        self.assertFalse(self.app.mode_journal.exists())
        self.assertIsNone(self.app.recovery)
        # A crash after our write: startup restores the CRLF original byte for byte.
        ours, standard = 'modelRoles:\n  task: demo/three\n', self.app.path('standard').read_text(encoding='utf-8')
        self.app.path('high').write_text(ours)
        self.app.mode_journal.write_text(json.dumps({'files': {
            'high': {'before': crlf.decode(), 'after': ours, 'mode': 0o644},
            'standard': {'before': standard, 'after': standard + '# never written\n'}},
            'beforeState': self.app.mode_state, 'afterState': {'profiles': {}}}))
        app = Forge(self.project, self.agent, self.root/'state', '/does-not-exist')
        self.assertIsNone(app.recovery)
        self.assertEqual(app.path('high').read_bytes(), crlf)
        self.assertEqual(app.path('high').stat().st_mode & 0o777, 0o644)
        self.assertFalse(app.mode_journal.exists())

    def test_rename_and_delete_are_journaled_across_crashes(self):
        self.init_modes(); self.save_mode('high')
        logical = self.app.mode_state['profiles']['high']['normal']
        presets = self.project/'.omp/presets'
        class Crash(BaseException):
            pass
        def crash_on_metadata(path, data, *args):
            if path == self.app.mode_file:
                raise Crash()
            return atomic(path, data, *args)
        with patch('server.atomic', side_effect=crash_on_metadata), self.assertRaises(Crash):
            self.app.profile_action({'action': 'rename', 'profile': 'high', 'name': 'night', 'revision': self.app.revision('high')})
        # Both file steps happened: startup completes the rename and keeps the DeepSeek original.
        app = Forge(self.project, self.agent, self.root/'state', '/does-not-exist')
        self.assertEqual(sorted(p.name for p in presets.iterdir()), ['night.yml'])
        self.assertEqual(app.mode_state['profiles']['night']['normal'], logical)
        self.assertEqual(app.mode_settings('night')['mode'], 'no-deepseek')
        # A crash between creating the new name and removing the old one rolls back.
        def crash_in_presets(path):
            if Path(path) == presets:
                raise Crash()
            return fsync_dir(path)
        with patch('server.fsync_dir', side_effect=crash_in_presets), self.assertRaises(Crash):
            app.profile_action({'action': 'rename', 'profile': 'night', 'name': 'day', 'revision': app.revision('night')})
        self.assertTrue((presets/'day.yml').exists())
        app = Forge(self.project, self.agent, self.root/'state', '/does-not-exist')
        self.assertEqual(sorted(p.name for p in presets.iterdir()), ['night.yml'])
        self.assertIn('night', app.mode_state['profiles'])
        self.assertNotIn('day', app.mode_state['profiles'])
        self.app = app
        with patch('server.atomic', side_effect=crash_on_metadata), self.assertRaises(Crash):
            app.profile_action({'action': 'delete', 'profile': 'night', 'revision': app.revision('night')})
        app = Forge(self.project, self.agent, self.root/'state', '/does-not-exist')
        self.assertFalse((presets/'night.yml').exists())
        self.assertNotIn('night', app.mode_state['profiles'])
        self.assertTrue(list((app.state_dir/'backups').glob('*-deleted-night.yml')))

    def test_adopt_accepts_outside_edit_without_rewriting_it(self):
        self.init_modes(); self.save_mode('standard')
        std = self.app.path('standard')
        std.write_text(std.read_text() + '# owner note\n')
        edited = std.read_bytes()
        with self.assertRaises(Problem) as blocked:
            self.save_mode('high')
        self.assertEqual((blocked.exception.code, blocked.exception.details['profiles']), ('mode-conflict', ['standard']))
        with self.assertRaises(Problem):
            self.app.profile_action({'action': 'adopt', 'profile': 'standard', 'revision': 'stale'})
        self.app.profile_action({'action': 'adopt', 'profile': 'standard', 'revision': self.app.revision('standard')})
        self.assertEqual(std.read_bytes(), edited)
        self.assertEqual(self.app.mode_conflicts(), [])
        record = self.app.mode_state['profiles']['standard']
        self.assertEqual(record['normal'], edited.decode())
        self.assertEqual(record['settings'], {**self.settings, 'mode': 'deepseek'})
        self.assertEqual(record['previous']['settings'], self.settings)
        self.save_mode('high')
        # Restore explicitly brings back the former logical profile.
        self.app.profile_action({'action': 'restore', 'profile': 'standard', 'revision': self.app.revision('standard')})
        self.assertEqual(self.app.mode_state['profiles']['standard']['settings'], self.settings)
        self.assertNotIn('# owner note', std.read_text())

    def pooled_standard(self):
        self.init_pools()
        on = {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}
        self.save_mode('standard', on, [{'path': ['modelRoles', 'task'], 'value': 'mana-pool/free-good'},
            {'path': ['retry', 'fallbackChains', 'task'], 'value': ['mana-pool/free-fast']},
            {'path': ['task', 'agentModelOverrides', 'task'], 'value': ['@task', 'mana-pool/free-fast']}])
        return self.app.path('standard')

    def outside_edit(self, path, edit):
        data = self.app.read(path)
        edit(data)
        path.write_text(yaml_dump(data) + '# owner note\n')
        return path.read_bytes()

    def test_adopt_keeps_pool_blocks_the_file_still_expands_exactly(self):
        std = self.pooled_standard()
        self.assertEqual(self.native('standard')['task']['agentModelOverrides']['task'], ['@task', 'demo/deepseek:free', 'demo/b:free'])
        edited = self.outside_edit(std, lambda d: d['modelRoles'].__setitem__('scout', 'demo/two'))
        plan = self.app.profile_action({'action': 'adopt-plan', 'profile': 'standard'})
        self.assertEqual(plan['lost'], [])
        self.assertEqual(sorted((k['key'], k['pool']) for k in plan['kept']), [('role:task', 'free-fast'), ('role:task', 'free-good'), ('vibe:task', 'free-fast')])
        self.assertEqual(std.read_bytes(), edited, 'a plan writes nothing')
        self.app.profile_action({'action': 'adopt', 'profile': 'standard', 'revision': self.app.revision('standard')})
        self.assertEqual(std.read_bytes(), edited, 'the adopted file stays byte for byte')
        self.assertEqual(self.app.mode_conflicts(), [])
        logical = self.app.profiles()[0]
        self.assertEqual(logical['modelRoles']['task'], 'mana-pool/free-good')
        self.assertEqual(list(logical['retry']['fallbackChains']['task']), ['mana-pool/free-fast'])
        self.assertEqual(list(logical['task']['agentModelOverrides']['task']), ['@task', 'mana-pool/free-fast'])
        self.assertEqual(logical['modelRoles']['scout'], 'demo/two', 'the outside edit is taken')
        self.assertIn('# owner note', self.app.mode_state['profiles']['standard']['normal'], 'the logical text keeps the file comments')
        # The blocks stay live: «Зберегти пули» still rewrites Standard.
        self.pools['free-good'] = ['demo/c:free:low', 'demo/a:free']
        self.app.save_pools({'revision': self.app.pools_revision(), 'pools': self.pools})
        self.assertEqual(self.native('standard')['modelRoles']['task'], 'demo/c:free:low')
        self.assertEqual(self.native('standard')['modelRoles']['scout'], 'demo/two')

    def test_adopt_names_a_pool_block_the_file_no_longer_repeats_and_takes_its_routes(self):
        std = self.pooled_standard()
        edited = self.outside_edit(std, lambda d: d['retry']['fallbackChains']['task'].__setitem__(1, 'demo/three'))
        plan = self.app.profile_action({'action': 'adopt-plan', 'profile': 'standard'})
        self.assertEqual(plan['lost'], [{'key': 'role:task', 'pool': 'free-fast'}])
        self.assertEqual(sorted((k['key'], k['pool']) for k in plan['kept']), [('role:task', 'free-good'), ('vibe:task', 'free-fast')])
        self.app.profile_action({'action': 'adopt', 'profile': 'standard', 'revision': self.app.revision('standard')})
        self.assertEqual(std.read_bytes(), edited)
        logical = self.app.profiles()[0]
        self.assertEqual(logical['modelRoles']['task'], 'mana-pool/free-good')
        self.assertEqual(list(logical['retry']['fallbackChains']['task']), ['demo/three'], 'the edited run is the file\'s own CUTS')
        self.assertEqual(list(logical['task']['agentModelOverrides']['task']), ['@task', 'mana-pool/free-fast'])

    def test_adopt_keeps_a_preset_pool_primary_that_inherits_default_fallbacks(self):
        self.init_pools()
        on = {'mode': 'deepseek', 'alternatives': [], 'overrides': {}}
        self.save_mode('high', on, [{'path': ['modelRoles', 'task'], 'value': 'mana-pool/free-good'}])
        high = self.app.path('high')
        self.assertEqual(self.native('high')['retry']['fallbackChains']['task'], ['demo/deepseek:free', 'demo/two'])
        edited = self.outside_edit(high, lambda d: d['modelRoles'].__setitem__('smol', 'demo/three'))
        self.assertEqual(self.app.profile_action({'action': 'adopt-plan', 'profile': 'high'})['kept'], [{'key': 'role:task', 'pool': 'free-good'}])
        self.app.profile_action({'action': 'adopt', 'profile': 'high', 'revision': self.app.revision('high')})
        self.assertEqual(high.read_bytes(), edited)
        overlay = self.app.profiles()[1]['high']
        self.assertEqual(overlay['modelRoles']['task'], 'mana-pool/free-good')
        self.assertNotIn('task', (overlay.get('retry') or {}).get('fallbackChains', {}), 'the role keeps following default')
        self.assertEqual(overlay['modelRoles']['smol'], 'demo/three')

    def test_collapse_is_the_inverse_of_the_on_expansion(self):
        from profile_modes import collapse_pools, collapse_chain
        pools = {'free-good': ['p/a:high', 'p/b'], 'free-fast': ['p/c']}
        self.assertEqual(collapse_chain(['p/x', 'p/a:high', 'p/b', 'p/c'], ['mana-pool/free-good', 'mana-pool/free-fast'], pools),
                         (['p/x', 'mana-pool/free-good', 'mana-pool/free-fast'], ['mana-pool/free-good', 'mana-pool/free-fast']))
        self.assertEqual(collapse_chain(['p/a', 'p/b'], ['mana-pool/free-good'], pools), (['p/a', 'p/b'], []), 'thinking is part of the expansion')
        self.assertEqual(collapse_chain(['p/a:high', 'p/b'], [], pools), (['p/a:high', 'p/b'], []), 'a run the owner wrote by hand stays his')
        self.assertEqual(collapse_chain(['@task', 'p/b', 'p/c'], ['mana-pool/free-fast'], pools, {'@task': 'mana-pool/free-good'})[0], ['@task', 'mana-pool/free-fast'])
        out, kept, lost = collapse_pools({'modelRoles': {'r': 'p/a:high'}, 'retry': {'fallbackChains': {'r': ['p/b', 'p/z']}}},
                                         {'modelRoles': {'r': 'mana-pool/free-good'}, 'retry': {'fallbackChains': {'r': ['mana-pool/free-fast']}}}, pools)
        self.assertEqual((out['modelRoles']['r'], out['retry']['fallbackChains']['r']), ('mana-pool/free-good', ['p/z']))
        self.assertEqual((kept, lost), ([{'key': 'role:r', 'pool': 'free-good'}], [{'key': 'role:r', 'pool': 'free-fast'}]))
        # Hand-written YAML may leave a role or a chain empty: nothing to fold, nothing breaks.
        out, kept, lost = collapse_pools({'modelRoles': {'r': None, 'q': 'p/a:high'}, 'retry': {'fallbackChains': {'q': None, 's': ['p/b']}}},
                                         {'modelRoles': {'q': 'mana-pool/free-good'}}, pools)
        self.assertEqual((out['modelRoles'], kept), ({'r': None, 'q': 'p/a:high'}, []))

    def test_outside_edited_preset_stays_frozen_and_orphans_can_be_forgotten(self):
        self.init_modes()
        self.app.path('other').write_text('modelRoles:\n  smol: demo/two\n')
        self.save_mode('high')
        self.app.path('high').unlink()
        self.assertEqual(self.app.snapshot()['modeOrphans'], ['high'])
        self.app.path('high').write_text('modelRoles:\n  task: demo/three\n')
        ghost = self.app.path('high').read_bytes()
        self.assertEqual(self.app.mode_conflicts(), ['high'])
        self.save_mode('other')
        self.assertEqual(self.app.path('high').read_bytes(), ghost)
        self.app.profile_action({'action': 'adopt', 'profile': 'high', 'revision': self.app.revision('high')})
        self.assertEqual(self.app.profiles()[1]['high']['modelRoles']['task'], 'demo/three')
        self.app.path('other').unlink()
        self.assertEqual(self.app.snapshot()['modeOrphans'], ['other'])
        self.app.profile_action({'action': 'adopt', 'profile': 'other'})
        self.assertNotIn('other', self.app.mode_state['profiles'])
        self.assertTrue(list((self.app.state_dir/'backups').glob('*-forgotten-other-mode.json')))

    def test_yaml_dates_tags_and_sets_do_not_break_previews_or_saves(self):
        self.init_modes()
        std = self.app.path('standard')
        std.write_text(std.read_text() + 'notes:\n  reviewed: 2026-01-01\n  at: 2026-01-01T10:00:00Z\n  token: !env OMP_TOKEN\n  tags: !!set {a, b}\n')
        self.app.preview_profile({'profile': 'high', 'revision': self.app.revision('high'), 'modeSettings': self.settings, 'changes': []})
        self.save_mode('standard')
        self.save_mode('high')
        text = std.read_text()
        self.assertIn('reviewed: 2026-01-01', text)
        self.assertIn('!env OMP_TOKEN', text)
        json.dumps(self.app.snapshot(), default=json_value)
        self.app.save_pools({'revision': self.app.pools_revision(), 'pools': {'free-good': [], 'free-fast': []}})

    def test_compile_edges_and_object_thinking(self):
        models = {r: {'id': r.split('/', 1)[1], 'input': ['text'], 'thinking': ['high']} for r in ['p/deepseek-v4', 'p/a', 'p/b', 'p/c']}
        off = {'mode': 'no-deepseek', 'alternatives': ['p/b', 'p/c'], 'overrides': {}}
        plan = compile_profile({'modelRoles': {'default': 'p/a'}, 'task': {'agentModelOverrides': {'empty': []}}}, off, models, {})
        self.assertEqual(plan['effective']['task']['agentModelOverrides']['empty'], [])
        blocked = {r: {'status': 'blocked', 'reason': 'x'} for r in ('p/b', 'p/c')}
        plan = compile_profile({'modelRoles': {'default': 'p/a'}, 'task': {'agentModelOverrides': {'w': ['p/deepseek-v4']}}}, off, models, blocked)
        self.assertEqual([(s['key'], s['route']) for s in plan['skipped']], [('vibe:w', 'p/b'), ('vibe:w', 'p/c')])
        plan = compile_profile({'modelRoles': {'judge': 'p/deepseek-v4'}}, {**off, 'alternatives': ['p/a:high']}, models, {})
        self.assertEqual(plan['effective']['modelRoles']['judge'], 'p/a', 'judge has no thinking in OMP')
        objects = {'p/deepseek-v4': {'id': 'deepseek-v4'}, 'p/a': {'id': 'a', 'input': ['text'], 'thinking': {'mode': 'effort', 'efforts': ['low', 'high']}}}
        plan = compile_profile({'modelRoles': {'default': 'p/deepseek-v4'}}, {**off, 'alternatives': ['p/a:high']}, objects, {})
        self.assertEqual((plan['skipped'], plan['effective']['modelRoles']['default']), ([], 'p/a:high'))
        free = {'p/x': {'id': 'x:free', 'cost': {'input': 0, 'output': 0}, 'thinking': {'mode': 'effort', 'efforts': ['low']}},
                'p/y': {'id': 'y:free', 'cost': {'input': 0, 'output': 0}}}
        validate_pools({'free-good': ['p/x:low', 'p/y:high'], 'free-fast': []}, free)  # unknown efforts are not checked
        with self.assertRaises(ValueError):
            validate_pools({'free-good': ['p/x:high'], 'free-fast': []}, free)
