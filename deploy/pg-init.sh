#!/usr/bin/env bash
set -euo pipefail
# Environment is private to this process; never echo SQL or credential values.
export DELIVERY_APP_PASSWORD
DELIVERY_APP_PASSWORD=$(cat /app-secret/password)
export DELIVERY_BACKUP_PASSWORD
DELIVERY_BACKUP_PASSWORD=$(cat /backup-secret/password)
if ! psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null 2>&1 <<'SQL'
\getenv app_password DELIVERY_APP_PASSWORD
SELECT format('CREATE ROLE delivery LOGIN PASSWORD %L', :'app_password') \gexec
GRANT CONNECT ON DATABASE delivery TO delivery;
GRANT USAGE, CREATE ON SCHEMA public TO delivery;
\getenv backup_password DELIVERY_BACKUP_PASSWORD
SELECT format('CREATE ROLE delivery_backup LOGIN PASSWORD %L', :'backup_password') \gexec
GRANT pg_read_all_data TO delivery_backup;
GRANT CONNECT ON DATABASE delivery TO delivery_backup;
SQL
then echo 'Database application-role initialization failed.' >&2; exit 1; fi
unset DELIVERY_APP_PASSWORD DELIVERY_BACKUP_PASSWORD
cp /config/pg_hba.conf "$PGDATA/pg_hba.conf"
