"""Mode round trips and projection safety, using disposable OMP files only."""
import copy
import json
import time
import unittest
from unittest.mock import patch

import test_forge
from server import Forge, Problem, digest, merge, yaml_load, atomic
from profile_modes import compile_profile, route_statuses, is_deepseek, validate_settings


class ProfileModesTest(unittest.TestCase):
    setUp = test_forge.ForgeTest.setUp
    tearDown = test_forge.ForgeTest.tearDown

    def test_bridge_free_label_is_accepted_by_shared_pools(self):
        from profile_modes import validate_pools, is_free_model
        model = {'id': 'big-pickle', 'name': '[FREE] Big Pickle', 'cost': {'input': 0, 'output': 0}}
        pools = {'free-good': ['opencode-free/big-pickle'], 'free-fast': []}
        self.assertEqual(validate_pools(pools, {'opencode-free/big-pickle': model}), pools)
        self.assertFalse(is_free_model({**model, 'cost': {'input': 0, 'output': 1}}))
        self.assertFalse(is_free_model({**model, 'cost': {}}))

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

    def test_pool_save_rejects_paid_nested_empty_used_overflow_and_stale_without_writes(self):
        self.init_pools()
        self.save_mode('high', {'mode':'deepseek','alternatives':[],'overrides':{}}, [
            {'path':['retry','fallbackChains','task'],'value':['mana-pool/free-good', *['demo/long-'+str(i) for i in range(28)]]}])
        before={n:self.app.path(n).read_bytes() for n in ('standard','high')}; metadata=copy.deepcopy(self.app.mode_state)
        for routes in ([], ['demo/two'], ['mana-pool/free-fast'], ['demo/a:free:max'], ['demo/a:free','demo/b:free','demo/c:free']):
            with self.assertRaises(Problem):
                self.app.save_pools({'revision':self.app.pools_revision(),'pools':{**self.pools,'free-good':routes}})
            self.assertEqual(self.app.mode_state,metadata)
            self.assertEqual({n:self.app.path(n).read_bytes() for n in before},before)
        with self.assertRaises(Problem):self.app.save_pools({'revision':'stale','pools':self.pools})

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
        def fail_creation(path, *args):
            if path == target:
                raise OSError('simulated disk error')
            return atomic(path, *args)
        with patch('server.atomic', side_effect=fail_creation):
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
