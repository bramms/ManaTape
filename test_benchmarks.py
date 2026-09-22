"""Adapters use synthetic inputs; live provider/config writes are never needed."""
import json
import unittest
from unittest.mock import patch
from benchmark_sources import arena_data, livecode_data, developer_data, tested_name, livecode_identity
from insights import benchmark_data


class BenchmarkTest(unittest.TestCase):
    def test_arena_preserves_rating_interval_votes_and_separates_units(self):
        entry = dict(modelDisplayName='demo-v2-high', rating=1420.4, ratingLower=1410, ratingUpper=1431,
                     votes=200, releaseType=None)
        board = dict(arenaSlug='text', leaderboardSlug='overall', params={'styleControl': True},
                     voteCutoffISOString='2026-09-13T00:00:00Z', entries=[entry, {**entry,'votes':0}])
        flight = '1:' + json.dumps({'leaderboard':board}) + '\n'
        html = ''.join('<script>self.__next_f.push('+json.dumps([1,part])+')</script>'
                       for part in [flight[:35],flight[35:]])
        rows = arena_data(html)
        self.assertEqual(len(rows),1)
        row=rows[0]
        self.assertEqual((row['baseId'],row['effort']),('demo-v2','high'))
        self.assertEqual(row['kind'],'preference')
        self.assertEqual(row['scores'],{})
        self.assertEqual(row['rating'],1420)
        self.assertEqual(row['interval'],[1410,1431])
        self.assertEqual(row['release'],'2026-09-13')
        with self.assertRaises(ValueError):arena_data(html.replace('styleControl','otherControl'))

    def test_livecode_averages_only_measured_questions_in_source_window(self):
        dates=[1700000000000+i*86400000 for i in range(17)]
        rows=[dict(model='Demo V1',date=dates[15],difficulty='easy',**{'pass@1':100}),
              dict(model='Demo V1',date=dates[16],difficulty='medium',**{'pass@1':0}),
              dict(model='Demo V1',date=dates[14],difficulty='hard',**{'pass@1':0}),
              dict(model='Demo V1',date=dates[16],difficulty='hard',**{'pass@1':None})]
        result=livecode_data(dict(date_marks=dates,performances=rows,models=[
            dict(model_repr='Demo V1',model_name='org/demo-v1',release_date=dates[0]),
            dict(model_repr='Not measured',model_name='demo-v2',release_date=dates[0])]))
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]['scores'],{'Pass@1':50,'Easy':100,'Medium':0})
        self.assertEqual(result[0]['samples'],2)
        self.assertFalse(result[0]['potentialOverlap'])

    def test_failed_source_keeps_its_own_snapshot_without_losing_other_updates(self):
        old=dict(at=100,records=[dict(id='old',source='Artificial Analysis')],
                 sources={'Artificial Analysis':{'at':80}})
        with patch('insights.livebench_data',return_value=[dict(id='new',source='LiveBench')]), \
             patch('insights.artificial_analysis',side_effect=ValueError), \
             patch('insights.download',return_value='{}'), \
             patch('insights.livecode_data',return_value=[dict(id='lcb',source='LiveCodeBench')]), \
             patch('insights.arena_data',return_value=[dict(id='arena',source='Arena')]), \
             patch('insights.developer_data',return_value=[dict(id='dev',source='Розробник')]):
            result=benchmark_data(old)
        self.assertEqual(len(result['records']),5)
        self.assertEqual(result['sources']['Artificial Analysis']['at'],80)
        self.assertTrue(result['sources']['Artificial Analysis']['error'])
        self.assertFalse(result['sources']['Arena']['error'])
        self.assertEqual(old['records'],[dict(id='old',source='Artificial Analysis')])

    def test_only_explicit_effort_is_removed_from_external_names(self):
        self.assertEqual(tested_name('demo-v2 (High)'),('demo-v2','high'))
        for name in ['demo-v2-preview','demo-v2-0731','demo-v2-nvfp4','demo-thinking']:
            self.assertEqual(tested_name(name),(name,''))

    def test_livecode_identity_keeps_historical_releases_and_effort_separate(self):
        for name, label, expected in [
            ('deepseek-chat', 'DeepSeek-V3', ('DeepSeek-V3', '')),
            ('deepseek-reasoner', 'DeepSeek-R1-0528', ('DeepSeek-R1-0528', '')),
            ('o3-mini-2025-01-31__medium', 'O3-Mini (Med)', ('o3-mini-2025-01-31', 'medium')),
            ('claude-sonnet-4-20250514_nothink', 'Claude Sonnet 4', ('claude-sonnet-4-20250514', 'non-thinking')),
            ('XBai o4-medium', 'XBai-o4-medium', ('XBai o4-medium', '')),
        ]:
            self.assertEqual(livecode_identity(dict(model_name=name, model_repr=label)), expected)

    def test_publisher_records_are_explicitly_attributed(self):
        rows=developer_data()
        self.assertGreaterEqual(len(rows),5)
        for r in rows:
            self.assertEqual(r['kind'],'developer')
            self.assertEqual(r['dateKind'],'Перевірено')
            self.assertTrue(r['publisher'])
            self.assertTrue(r['baseId'])
            self.assertIn('README.md',r['dataUrl'])
