#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p /tmp/postgres-tls
cp /tls/tls.crt /tmp/postgres-tls/tls.crt
cp /tls/tls.key /tmp/postgres-tls/tls.key
chmod 600 /tmp/postgres-tls/tls.key
if [ -s "$PGDATA/PG_VERSION" ]; then cp /config/pg_hba.conf "$PGDATA/pg_hba.conf"; fi
exec docker-entrypoint.sh postgres -c ssl=on -c ssl_min_protocol_version=TLSv1.2 -c ssl_cert_file=/tmp/postgres-tls/tls.crt -c ssl_key_file=/tmp/postgres-tls/tls.key -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 -c log_connections=off -c log_disconnections=off -c password_encryption=scram-sha-256 -c max_connections=80 -c shared_buffers=256MB
