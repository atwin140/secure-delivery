#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 2 ]; then echo 'Usage: scripts/build-images.sh application-image-tag postgres-image-tag' >&2; exit 2; fi
podman build -f Containerfile -t "$1" .
podman build -f deploy/Containerfile.postgres -t "$2" .
echo 'Images built locally. Push and obtain registry digests only in an authorized environment.'
