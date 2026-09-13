#!/usr/bin/env python3
"""Create a portable, source-only OpenShift binary build archive."""
from pathlib import Path
import sys
import tarfile

output = Path(sys.argv[1] if len(sys.argv) > 1 else '.local/docs/source-portable.tar.gz')
output.parent.mkdir(parents=True, exist_ok=True)
files = [Path(p) for p in [
    'Containerfile', 'package.json', 'package-lock.json', '.npmrc', 'tsconfig.json',
    'vite.config.ts', 'scripts/admin.ts', 'deploy/Containerfile.postgres',
    'deploy/pg-start.sh', 'deploy/pg-init.sh',
]] + sorted(Path('src').rglob('*'))
with tarfile.open(output, 'w:gz', format=tarfile.USTAR_FORMAT) as archive:
    for path in files:
        if not path.is_file():
            continue
        if path.is_symlink():
            raise RuntimeError('Source symlinks are not allowed in the build context')
        info = archive.gettarinfo(str(path), arcname=str(path))
        info.uid = info.gid = 0
        info.uname = info.gname = 'root'
        info.mode = 0o644
        info.pax_headers = {}
        with path.open('rb') as source:
            archive.addfile(info, source)
print(f'Wrote portable source archive: {output}')
