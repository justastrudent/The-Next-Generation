"""Package the local V-World revision, including prepared data and asset licenses.

The archive opens to one folder containing index.html, data/, assets/ and
vendor/. Run a local HTTP server from that folder; no dist/ build is needed.
"""
from pathlib import Path
import argparse
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=root / 'metrorookies-vworld-revision.zip')
args = parser.parse_args()
output = args.output.resolve()
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for item in sorted(root.rglob('*')):
        if not item.is_file():
            continue
        relative = item.relative_to(root)
        if any(part.startswith('.') or part in {'__pycache__', 'node_modules', 'build'} for part in relative.parts):
            continue
        if item.resolve() == output:
            continue
        if item.suffix in {'.pyc', '.zip'}:
            continue
        archive.write(item, 'metrorookies-vworld-revision/' + relative.as_posix())
print(f'{output.name}: {output.stat().st_size:,} bytes')
