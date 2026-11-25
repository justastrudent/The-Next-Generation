#!/usr/bin/env python3
"""Install the Cheongju vehicle design into an existing MetroRookies renderer.

Standard library only. No downloads; no research-data or VWorld configuration edits.
The renderer is changed by inserting one bounded module hook, never by replacing it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
import tempfile

BEGIN = "// BEGIN METROROOKIES_CHEONGJU_DESIGN_V1"
END = "// END METROROOKIES_CHEONGJU_DESIGN_V1"
PAYLOADS = (
    "cheongju-design.js",
    "assets/drt-cheongju-01.glb",
    "assets/drt-cheongju-02.glb",
    "assets/drt-cheongju-03.glb",
)
BACKUP_NAME = "design-backup"
MANIFEST_NAME = "cheongju-design-manifest.json"
SOURCE_NAME = "scene3d.js"


class InstallError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_bytes(path):
    if path.is_symlink():
        raise InstallError("Refusing symbolic link: " + str(path))
    if not path.is_file():
        raise InstallError("Required file not found: " + str(path))
    return path.read_bytes()


def safe_target(root, relative):
    path = root / relative
    # Fixed relative names only; an existing symlink must not redirect a write.
    if relative not in PAYLOADS and relative != SOURCE_NAME:
        raise InstallError("Unexpected target in installer metadata: " + relative)
    for item in (path, *path.parents):
        if item == root.parent:
            break
        if item.is_symlink():
            raise InstallError("Refusing symbolic link: " + str(item))
    return path


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, temporary = tempfile.mkstemp(prefix=".metro-design-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def locate_root(patch_dir, explicit=None):
    if explicit:
        candidate = Path(explicit).expanduser().resolve()
        if candidate.is_file() and candidate.name == SOURCE_NAME:
            candidate = candidate.parent
        if not (candidate / SOURCE_NAME).is_file():
            raise InstallError("No scene3d.js in the specified project folder: " + str(candidate))
        return candidate
    if (patch_dir / SOURCE_NAME).is_file():
        return patch_dir
    candidates = []
    parent = patch_dir.parent
    if (parent / SOURCE_NAME).is_file():
        candidates.append(parent)
    for child in patch_dir.iterdir():
        if child.is_dir() and not child.is_symlink() and (child / SOURCE_NAME).is_file():
            candidates.append(child.resolve())
    candidates = sorted(set(candidates))
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        raise InstallError("Several project folders were found. Run: python apply_design.py \"EXACT_PROJECT_FOLDER\"")
    raise InstallError(
        "scene3d.js was not found. Extract this patch beside your existing scene3d.js, "
        "or run: python apply_design.py \"YOUR_PROJECT_FOLDER\""
    )


def source_text(data):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise InstallError("scene3d.js must be UTF-8; no file was changed.") from error
    if "\x00" in text:
        raise InstallError("scene3d.js is not a plain UTF-8 JavaScript file.")
    required = (
        (r"\b(?:export\s+)?class\s+MetroScene\b", "class MetroScene"),
        (r"\b_newVehicle\s*\(", "_newVehicle()"),
        (r"\bupdate\s*\(", "update()"),
        (r"\b_updateCamera\s*\(", "_updateCamera()"),
    )
    for pattern, label in required:
        if not re.search(pattern, text):
            raise InstallError("This scene3d.js is not the supported renderer (missing " + label + ").")
    exports = list(re.finditer(r"(?m)^[ \t]*export[ \t]+default[ \t]+MetroScene[ \t]*;[ \t]*(?=\r?$)", text))
    if len(exports) != 1:
        raise InstallError("Expected one standalone 'export default MetroScene;' in scene3d.js.")
    return text, exports[0]


def hook(newline):
    return newline.join((
        BEGIN,
        "import { installCheongjuDesign } from './cheongju-design.js';",
        "installCheongjuDesign(MetroScene);",
        END,
        "",
    ))


def split_hook(text):
    """Remove exactly our known hook, preserving every other byte of UTF-8 text."""
    starts, ends = text.count(BEGIN), text.count(END)
    if starts == ends == 0:
        return text, False
    if starts != 1 or ends != 1:
        raise InstallError("The design hook is incomplete or duplicated. Restore it manually before retrying.")
    index = text.index(BEGIN)
    for newline in ("\r\n", "\n"):
        block = hook(newline)
        if text[index:index + len(block)] == block:
            if index and text[index - 1] != "\n":
                break
            return text[:index] + text[index + len(block):], True
    raise InstallError("The installed design hook was edited. It will not be overwritten.")


def patched_source(data):
    text, _ = source_text(data)
    clean, present = split_hook(text)
    if present:
        return data, clean.encode("utf-8"), True
    clean, export = source_text(clean.encode("utf-8"))
    newline = "\r\n" if "\r\n" in clean else "\n"
    result = clean[:export.start()] + hook(newline) + clean[export.start():]
    return result.encode("utf-8"), clean.encode("utf-8"), False


def read_manifest(backup):
    path = backup / MANIFEST_NAME
    if not path.exists():
        return None
    if backup.is_symlink() or path.is_symlink():
        raise InstallError("The backup folder or manifest is a symbolic link.")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise InstallError("The design backup manifest cannot be read.") from error
    if value.get("schema") != 1 or value.get("source") != SOURCE_NAME:
        raise InstallError("Unrecognized design backup manifest.")
    entries = value.get("entries")
    if not isinstance(entries, list) or len(entries) != len(PAYLOADS):
        raise InstallError("Incomplete design backup manifest.")
    if {entry.get("path") for entry in entries} != set(PAYLOADS):
        raise InstallError("Unexpected file paths in design backup manifest.")
    return value


def verify_payload(path, relative):
    data = read_bytes(path)
    if relative.endswith(".glb"):
        if len(data) < 20 or data[:4] != b"glTF":
            raise InstallError("Invalid GLB asset: " + str(path))
        _, version, size = struct.unpack("<4sII", data[:12])
        if version != 2 or size != len(data):
            raise InstallError("Incomplete GLB asset: " + str(path))
    else:
        try:
            module = data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise InstallError("The design module is not UTF-8.") from error
        if "installCheongjuDesign" not in module:
            raise InstallError("The design module is missing its installer function.")
    return data


def validate_backup(backup, manifest):
    original = read_bytes(backup / SOURCE_NAME)
    if digest(original) != manifest.get("source_original_sha256"):
        raise InstallError("The original scene3d.js backup was changed; refusing to continue.")
    for entry in manifest["entries"]:
        if entry.get("backup"):
            expected = "original/" + entry["path"]
            if entry["backup"] != expected:
                raise InstallError("Unexpected backup path in manifest.")
            saved_path = backup / expected
            for parent in saved_path.parents:
                if parent == backup:
                    break
                if parent.is_symlink():
                    raise InstallError("A backup directory is a symbolic link.")
            saved = read_bytes(saved_path)
            if digest(saved) != entry.get("original_sha256"):
                raise InstallError("An original payload backup was changed: " + entry["path"])


def commit(writes, deletions=()):
    """Rollback owned target writes if an individual filesystem operation fails."""
    previous = {}
    done = []
    try:
        for path, data in writes:
            previous[path] = path.read_bytes() if path.exists() else None
            atomic_write(path, data)
            done.append(path)
        for path in deletions:
            previous[path] = path.read_bytes() if path.exists() else None
            path.unlink(missing_ok=True)
            done.append(path)
    except (OSError, InstallError):
        for path in reversed(done):
            value = previous[path]
            if value is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, value)
        raise


def install(root, patch_dir, dry_run=False):
    source = safe_target(root, SOURCE_NAME)
    current = read_bytes(source)
    next_source, clean_source, has_hook = patched_source(current)
    backup = root / BACKUP_NAME
    if backup.is_symlink():
        raise InstallError("The backup directory is a symbolic link.")
    manifest = read_manifest(backup)
    if has_hook and manifest is None:
        raise InstallError("A design hook exists without its backup manifest; refusing to take ownership.")
    if manifest is not None:
        if manifest.get("state") not in ("installed", "restored"):
            raise InstallError("Unknown installer state.")
        if manifest["state"] == "installed" and not has_hook:
            raise InstallError("The installed design hook was removed outside this installer; no files changed.")
        if manifest["state"] == "restored" and has_hook:
            raise InstallError("A restored renderer unexpectedly contains a design hook; no files changed.")
        validate_backup(backup, manifest)
    elif backup.exists():
        raise InstallError("design-backup already exists without a recognized manifest; it will not be overwritten.")

    inputs = {name: verify_payload(patch_dir / name, name) for name in PAYLOADS}
    original_entries = {entry["path"]: entry for entry in manifest["entries"]} if manifest else {}
    entries, writes, backup_writes = [], [], []
    for name in PAYLOADS:
        target = safe_target(root, name)
        before = read_bytes(target) if target.exists() else None
        after = inputs[name]
        previous = original_entries.get(name)
        if previous:
            current_hash = digest(before) if before is not None else None
            expected_hash = previous["installed_sha256"] if manifest["state"] == "installed" else previous["original_sha256"]
            if current_hash != expected_hash:
                raise InstallError("An installed file was changed or removed: " + name + ". No files changed.")
            entry = dict(previous)
            entry["installed_sha256"] = digest(after)
        else:
            entry = {
                "path": name,
                "existed_before": before is not None,
                "original_sha256": digest(before) if before is not None else None,
                "installed_sha256": digest(after),
                "backup": None,
                "owned_write": before != after,
            }
            if before is not None and before != after:
                entry["backup"] = "original/" + name
                backup_writes.append((backup / entry["backup"], before))
        if before != after:
            if previous and not entry.get("owned_write"):
                # A file that was already present and unchanged at first install is not ours.
                raise InstallError("Refusing to update a file that this installer did not create: " + name)
            writes.append((target, after))
        entries.append(entry)

    next_manifest = {
        "schema": 1,
        "state": "installed",
        "source": SOURCE_NAME,
        "source_original_sha256": manifest["source_original_sha256"] if manifest else digest(clean_source),
        "source_installed_sha256": digest(next_source),
        "entries": entries,
        "note": "Only the marked module hook and the four named design payloads belong to this installer.",
    }
    manifest_bytes = (json.dumps(next_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if next_source != current:
        writes.append((source, next_source))
    if not manifest:
        backup_writes.insert(0, (backup / SOURCE_NAME, clean_source))
    existing_manifest = (backup / MANIFEST_NAME).read_bytes() if manifest else None
    if existing_manifest != manifest_bytes:
        writes.append((backup / MANIFEST_NAME, manifest_bytes))
    if dry_run:
        return "CHECK OK: compatible renderer; {} target write(s). No files changed.".format(len(writes))
    if not writes and not backup_writes:
        return "ALREADY INSTALLED: nothing changed. Refresh your browser with Ctrl+Shift+R."
    commit(backup_writes + writes)
    return "INSTALLED: Cheongju design added. Existing research data and map settings were preserved.\nBackup: {}\nRefresh your browser with Ctrl+Shift+R.".format(backup)


def restore(root, dry_run=False):
    source = safe_target(root, SOURCE_NAME)
    backup = root / BACKUP_NAME
    manifest = read_manifest(backup)
    if manifest is None:
        raise InstallError("No installer backup was found; nothing can be restored automatically.")
    if manifest.get("state") == "restored":
        return "ALREADY RESTORED: nothing changed."
    if manifest.get("state") != "installed":
        raise InstallError("Unknown installer state.")
    validate_backup(backup, manifest)
    text, _ = source_text(read_bytes(source))
    clean, present = split_hook(text)
    if not present:
        raise InstallError("The installed design hook is missing; refusing an ambiguous restore.")
    writes = [(source, clean.encode("utf-8"))]
    deletions, kept = [], []
    for entry in manifest["entries"]:
        if not entry.get("owned_write"):
            continue
        target = safe_target(root, entry["path"])
        if not target.exists():
            kept.append(entry["path"] + " (already absent)")
            continue
        current = read_bytes(target)
        if digest(current) != entry["installed_sha256"]:
            kept.append(entry["path"] + " (changed after installation)")
            continue
        if entry["existed_before"]:
            writes.append((target, read_bytes(backup / entry["backup"])))
        else:
            deletions.append(target)
    next_manifest = dict(manifest, state="restored", kept_modified_files=kept)
    writes.append((backup / MANIFEST_NAME, (json.dumps(next_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")))
    if dry_run:
        return "RESTORE CHECK OK: the marked hook will be removed; other source edits will be preserved. No files changed."
    commit(writes, deletions)
    message = "RESTORED: only the design hook was removed from scene3d.js. Your other source edits were preserved."
    if kept:
        message += "\nKept newer or user-managed files: " + ", ".join(kept)
    return message + "\nThe design-backup folder was retained. Refresh with Ctrl+Shift+R."


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", nargs="?", help="Existing project folder containing scene3d.js")
    parser.add_argument("--check", action="store_true", help="Validate only; do not write files")
    parser.add_argument("--restore", action="store_true", help="Remove this design hook and restore owned payloads")
    args = parser.parse_args(argv)
    try:
        patch_dir = Path(__file__).resolve().parent
        root = locate_root(patch_dir, args.project)
        print("Project:", root)
        message = restore(root, args.check) if args.restore else install(root, patch_dir, args.check)
        print(message)
        return 0
    except (InstallError, OSError) as error:
        print("ERROR:", error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
