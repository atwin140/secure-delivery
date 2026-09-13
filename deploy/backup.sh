#!/usr/bin/env bash
set -euo pipefail
umask 077
cp /backup-secret/pgpass /tmp/pgpass
chmod 600 /tmp/pgpass
export PGPASSFILE=/tmp/pgpass
export PGSSLMODE=verify-full PGSSLROOTCERT=/trust/service-ca.crt
target="/backups/metadata-$(date -u +%Y%m%dT%H%M%SZ).dump"
trap 'rm -f /tmp/pgpass "${target}.partial"' EXIT
if ! pg_dump --host="${DATABASE_HOST:?}" --username=delivery_backup --dbname=delivery --format=custom --file="${target}.partial" 2>/dev/null; then echo 'Metadata backup failed.' >&2; exit 1; fi
pg_restore --list "${target}.partial" >/dev/null
mv "${target}.partial" "$target"
find /backups -type f -name 'metadata-*.dump' -mtime +29 -delete
echo 'Metadata backup completed and archive listing verified.'
