"""Showcase data stays synthetic, coherent and separate from native OMP state."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from profile_modes import is_free_model
from server import Forge, load_installation, merge
from tools import dev_fixture


class DemoFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        repo = patch.object(dev_fixture, 'REPO', self.root)
        repo.start(); self.addCleanup(repo.stop)
        native = patch('server.subprocess.run', side_effect=AssertionError('Demo must not call OMP'))
        native.start(); self.addCleanup(native.stop)

    def test_showcase_native_projection_pools_and_synthetic_telemetry(self):
        project, agent, state = dev_fixture.seed_showcase()
        _, apps = load_installation(state.parent/'installation.yml')
        app = apps['showcase']
        snapshot = app.snapshot()
        self.assertTrue(snapshot['demo'])
        self.assertEqual(len(snapshot['base']['modelRoles']), 6)
        self.assertEqual(set(snapshot['presets']), {'without-deepseek', 'long-tape'})
        self.assertEqual([len(app.pools()[key]) for key in ('free-good', 'free-fast')], [10, 16])
        self.assertTrue(all(is_free_model(app.mode_catalog()[r]) for pool in app.pools().values() for r in pool))
        self.assertTrue(all(row['baseUrl']=='https://example.invalid/v1' and row['auth']=='none'
                            for row in app.registry()['providers'].values()))
        self.assertEqual(len(snapshot['profileModes']['standard']['settings']['alternatives']), 5)
        self.assertEqual(snapshot['profileModes']['without-deepseek']['settings']['mode'], 'no-deepseek')
        full = merge(app.read(app.path('standard')), app.read(app.path('long-tape')))
        self.assertEqual(len(full['retry']['fallbackChains']['investigator']), 30)
        for name in ('standard', 'without-deepseek', 'long-tape'):
            self.assertNotIn('mana-pool/', app.path(name).read_text())
        self.assertEqual(len(snapshot['insights']['stats']['timeSeries']), 48)
        self.assertIn('DEMO', snapshot['insights']['stats']['scope'])
        self.assertEqual(snapshot['insights']['benchmarks']['records'], [])

    def test_reopening_keeps_saved_showcase_changes(self):
        paths = dev_fixture.seed_showcase()
        config = paths[0]/'.omp/config.yml'
        config.write_text(config.read_text()+'\n# saved demo edit\n')
        before = {p: p.read_bytes() for p in paths[2].parent.rglob('*') if p.is_file()}
        self.assertEqual(dev_fixture.seed_showcase(), paths)
        self.assertEqual({p: p.read_bytes() for p in before}, before)

    def test_unmarked_directory_is_never_overwritten(self):
        root = self.root/'.dev'
        root.mkdir()
        native = root/'important.yml'
        native.write_text('keep: unchanged\n')
        with self.assertRaises(SystemExit):
            dev_fixture.seed_showcase()
        self.assertEqual(native.read_text(), 'keep: unchanged\n')

    def test_basic_demo_free_model_has_explicit_free_identity(self):
        project, agent, state = dev_fixture.seed()
        app = Forge(project, agent, state, '/does-not-exist', demo=True)
        self.assertTrue(is_free_model(app.mode_catalog()['demo-free/cut-c']))
