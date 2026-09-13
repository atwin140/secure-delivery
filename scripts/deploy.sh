#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 2 ]; then echo 'Usage: scripts/deploy.sh operator.json rendered.yaml' >&2; exit 2; fi
node scripts/render.mjs "$1" "$2"
oc apply --dry-run=server -f "$2" >/dev/null
# Invoking this script is an operator-authorized cluster change.
oc apply -f "$2"
echo 'Resources applied with retrieval disabled by default. Complete the operator checklist before enabling access.'
