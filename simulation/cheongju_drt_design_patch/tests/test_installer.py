"""Integration checks for the real local installer, using isolated project fixtures."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "apply_design.py"
spec = importlib.util.spec_from_file_location("metro_design_installer", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

SOURCE = b"""// Existing user renderer; UTF-8, exact bytes matter.
export class MetroScene {
 _newVehicle(id) { return {id}; }
 update(states,time) { this.states=states; }
 _updateCamera(force=false) { return force; }
}
export default MetroScene;
"""


def glb_fixture():
    body = json.dumps({"asset": {"version": "2.0"}, "scenes": [{"nodes": []}], "scene": 0}).encode()
    body += b" " * (-len(body) % 4)
    return struct.pack("<4sII", b"glTF", 2, 20 + len(body)) + struct.pack("<II", len(body), 0x4E4F534A) + body


def snapshot(folder):
    return {str(p.relative_to(folder)): p.read_bytes() for p in folder.rglob("*") if p.is_file()}


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.patch = self.base / "patch"
        self.root = self.base / "project"
        self.patch.mkdir()
        self.root.mkdir()
        (self.root / "scene3d.js").write_bytes(SOURCE)
        (self.root / "data").mkdir()
        (self.root / "data" / "gangnae_boundary.geojson").write_text('{"user":"boundary"}')
        (self.root / "data" / "run.json").write_text('{"simulation":"untouched"}')
        (self.root / "app.js").write_text("// user app")
        (self.root / "vworld-scene.js").write_text("// VWorld settings")
        for name in installer.PAYLOADS:
            path = self.patch / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(glb_fixture() if name.endswith(".glb") else b"export function installCheongjuDesign(Scene) {}\n")

    def tearDown(self):
        self.tmp.cleanup()

    def install(self, **kwargs):
        return installer.install(self.root, self.patch, **kwargs)

    def test_install_preserves_source_and_research_files(self):
        before = snapshot(self.root)
        self.assertIn("INSTALLED", self.install())
        text = (self.root / "scene3d.js").read_text()
        clean, present = installer.split_hook(text)
        self.assertTrue(present)
        self.assertEqual(clean.encode(), SOURCE)
        self.assertEqual((self.root / "design-backup" / "scene3d.js").read_bytes(), SOURCE)
        for path in ["app.js", "vworld-scene.js", "data/run.json", "data/gangnae_boundary.geojson"]:
            self.assertEqual((self.root / path).read_bytes(), before[path])
        for name in installer.PAYLOADS:
            self.assertEqual((self.root / name).read_bytes(), (self.patch / name).read_bytes())
        manifest = json.loads((self.root / "design-backup" / installer.MANIFEST_NAME).read_text())
        self.assertEqual(manifest["source_original_sha256"], hashlib.sha256(SOURCE).hexdigest())

    def test_repeat_install_is_exactly_idempotent(self):
        self.install()
        before = snapshot(self.root)
        mtimes = {p: p.stat().st_mtime_ns for p in self.root.rglob("*") if p.is_file()}
        self.assertIn("ALREADY INSTALLED", self.install())
        self.assertEqual(before, snapshot(self.root))
        self.assertEqual(mtimes, {p: p.stat().st_mtime_ns for p in mtimes})

    def test_dry_run_does_not_write(self):
        before = snapshot(self.root)
        self.assertIn("CHECK OK", self.install(dry_run=True))
        self.assertEqual(before, snapshot(self.root))
        self.assertFalse((self.root / "design-backup").exists())

    def test_crlf_and_utf8_bom_survive(self):
        original = b"\xef\xbb\xbf" + SOURCE.replace(b"\n", b"\r\n") + "// 사용자 메모\r\n".encode()
        (self.root / "scene3d.js").write_bytes(original)
        self.install()
        installer.restore(self.root)
        self.assertEqual((self.root / "scene3d.js").read_bytes(), original)

    def test_restore_preserves_later_user_source_edits(self):
        self.install()
        path = self.root / "scene3d.js"
        original = path.read_bytes()
        path.write_bytes(original.replace(b"return force;", b"return force || false;"))
        installer.restore(self.root)
        self.assertEqual(path.read_bytes(), SOURCE.replace(b"return force;", b"return force || false;"))
        self.assertFalse((self.root / "assets/drt-cheongju-01.glb").exists())
        self.assertTrue((self.root / "data/run.json").exists())
        self.assertIn("ALREADY RESTORED", installer.restore(self.root))

    def test_restore_keeps_newer_payload_changes(self):
        self.install()
        path = self.root / "cheongju-design.js"
        path.write_text("// user's newer design module")
        message = installer.restore(self.root)
        self.assertIn("changed after installation", message)
        self.assertEqual(path.read_text(), "// user's newer design module")
        self.assertNotIn(installer.BEGIN, (self.root / "scene3d.js").read_text())

    def test_reinstall_after_restore_preserves_user_source_edits(self):
        self.install()
        installer.restore(self.root)
        source = self.root / "scene3d.js"
        changed = SOURCE + b"// retained later user note\n"
        source.write_bytes(changed)
        self.assertIn("INSTALLED", self.install())
        self.assertEqual(installer.split_hook(source.read_text())[0].encode(), changed)
        installer.restore(self.root)
        self.assertEqual(source.read_bytes(), changed)

    def test_reinstall_after_restore_does_not_replace_newer_payload(self):
        self.install()
        module = self.root / "cheongju-design.js"
        module.write_text("// later user module")
        installer.restore(self.root)
        before = snapshot(self.root)
        with self.assertRaisesRegex(installer.InstallError, "changed or removed"):
            self.install()
        self.assertEqual(before, snapshot(self.root))

    def test_preexisting_payloads_are_backed_up_and_restored(self):
        path = self.root / "cheongju-design.js"
        path.write_bytes(b"// earlier user design module")
        self.install()
        self.assertEqual((self.root / "design-backup/original/cheongju-design.js").read_bytes(), b"// earlier user design module")
        installer.restore(self.root)
        self.assertEqual(path.read_bytes(), b"// earlier user design module")

    def test_in_place_payload_files_are_not_deleted_on_restore(self):
        for name in installer.PAYLOADS:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((self.patch / name).read_bytes())
        installer.install(self.root, self.root)
        installer.restore(self.root)
        for name in installer.PAYLOADS:
            self.assertTrue((self.root / name).is_file())

    def test_edited_installed_file_refuses_repeat_without_changes(self):
        self.install()
        (self.root / "cheongju-design.js").write_text("// newer user's module")
        before = snapshot(self.root)
        with self.assertRaisesRegex(installer.InstallError, "changed or removed"):
            self.install()
        self.assertEqual(before, snapshot(self.root))

    def test_missing_or_corrupt_payload_refuses_before_writes(self):
        (self.patch / "assets/drt-cheongju-03.glb").write_bytes(b"broken")
        before = snapshot(self.root)
        with self.assertRaisesRegex(installer.InstallError, "Invalid GLB"):
            self.install()
        self.assertEqual(before, snapshot(self.root))
        self.assertFalse((self.root / "design-backup").exists())

    def test_wrong_renderer_refuses(self):
        (self.root / "scene3d.js").write_bytes(b"export default DifferentScene;\n")
        before = snapshot(self.root)
        with self.assertRaises(installer.InstallError):
            self.install()
        self.assertEqual(before, snapshot(self.root))

    def test_modified_hook_refuses_restore(self):
        self.install()
        path = self.root / "scene3d.js"
        path.write_bytes(path.read_bytes().replace(b"installCheongjuDesign(MetroScene);", b"installCheongjuDesign(MetroScene, {});"))
        before = snapshot(self.root)
        with self.assertRaisesRegex(installer.InstallError, "hook was edited"):
            installer.restore(self.root)
        self.assertEqual(before, snapshot(self.root))

    def test_unknown_backup_directory_refuses(self):
        (self.root / "design-backup").mkdir()
        (self.root / "design-backup" / "readme.txt").write_text("not yours")
        before = snapshot(self.root)
        with self.assertRaisesRegex(installer.InstallError, "will not be overwritten"):
            self.install()
        self.assertEqual(before, snapshot(self.root))

    def test_invalid_utf8_refuses(self):
        (self.root / "scene3d.js").write_bytes(SOURCE + b"\xff")
        with self.assertRaisesRegex(installer.InstallError, "UTF-8"):
            self.install()

    def test_root_detection_parent_child_and_explicit(self):
        child_patch = self.root / "patch"
        child_patch.mkdir()
        self.assertEqual(installer.locate_root(child_patch), self.root)
        container = self.base / "container"
        container.mkdir()
        project = container / "one-project"
        project.mkdir()
        (project / "scene3d.js").write_bytes(SOURCE)
        self.assertEqual(installer.locate_root(container), project)
        self.assertEqual(installer.locate_root(self.patch, str(self.root / "scene3d.js")), self.root)
        second = container / "two-project"
        second.mkdir()
        (second / "scene3d.js").write_bytes(SOURCE)
        with self.assertRaisesRegex(installer.InstallError, "Several project folders"):
            installer.locate_root(container)

    def test_target_symlink_refuses(self):
        outside = self.base / "unrelated"
        outside.mkdir()
        try:
            (self.root / "assets").symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not supported")
        with self.assertRaisesRegex(installer.InstallError, "symbolic link"):
            self.install()
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
