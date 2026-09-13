CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS repositories (
 id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{32}$'), object_key text UNIQUE NOT NULL,
 sender_id text NOT NULL, capability_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','uploading','uploaded','finalized','failed','abandoned','revoked','expired')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finalized_at timestamptz,
 expires_at timestamptz, invalidated_at timestamptz, last_activity timestamptz NOT NULL DEFAULT clock_timestamp(),
 ciphertext_bytes bigint, ciphertext_sha256 text, upload_lease text, multipart_id text,
 upload_attempts integer NOT NULL DEFAULT 0, delete_attempts integer NOT NULL DEFAULT 0,
 deleted_at timestamptz, last_delete_attempt timestamptz,
 CHECK(ciphertext_bytes IS NULL OR ciphertext_bytes BETWEEN 101 AND 1073834107),
 CHECK(status <> 'finalized' OR (finalized_at IS NOT NULL AND expires_at IS NOT NULL AND ciphertext_bytes IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS repositories_owner ON repositories(sender_id,created_at DESC);
CREATE INDEX IF NOT EXISTS repositories_cleanup ON repositories(invalidated_at) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, csrf_hash text NOT NULL, sender_id text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS oidc_transactions(token_hash text PRIMARY KEY,state text NOT NULL,nonce text NOT NULL,verifier text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS audit(repository_id text,event text NOT NULL,at timestamptz NOT NULL DEFAULT clock_timestamp(),outcome text NOT NULL,sender_id text);
ALTER TABLE audit DROP COLUMN IF EXISTS id;
CREATE INDEX IF NOT EXISTS audit_retention ON audit(at);
CREATE TABLE IF NOT EXISTS settings(key text PRIMARY KEY,value boolean NOT NULL);
INSERT INTO settings(key,value) VALUES('retrieval_enabled',false) ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
