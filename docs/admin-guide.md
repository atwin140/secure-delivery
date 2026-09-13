# Administration

The current Docs deployment uses namespace `docs`, ConfigMap `docs-config` and realm/client `docs`; see [current deployment and sign-in](docs-deployment.md). Generic and earlier deployment names below describe the original reference layout.

Complete [operator-checklist.md](operator-checklist.md) for environment prerequisites and release evidence. The subsequent isolated ACM deployment test is documented in [cluster-test.md](cluster-test.md); it is separate from production acceptance.

## Runtime settings and credentials

All nonsecret tenant/branding/URL/provider configuration is in `delivery-config`; public browser output is explicitly limited to `brandName`, `supportText`, `emailEnabled`, and the local-only `development` indicator. Application images contain no tenant configuration or credentials. Crypto parameters are constants in protocol version 1 and cannot be overridden by ConfigMaps.

Production reads Postgres, S3, OIDC and Graph credentials from mounted existing Secrets. Postgres host/database/username are separate ConfigMap values; its password is a Secret. Do not commit populated Secret templates or place credentials in shell arguments, ConfigMaps, images, logs or CI output. Secret-file content is stripped of a conventional trailing newline; infrastructure credentials must not depend on surrounding whitespace. The local development sentinel values are rejected by production configuration validation. The isolated cluster test uses freshly generated credentials for real test infrastructure and synthetic users; these are held in namespace Secrets.

Configuration/CA/credential changes require rollout. Cert-manager leaf renewals are picked up by the scoped reload CronJob; see [TLS administration](cert-manager.md). The app's service account has no RBAC grant and no mounted Kubernetes API token. Namespace-assigned UIDs and supplemental groups must be able to read Secret projections; the app and database run with no elevated capabilities. Postgres TLS keys are copied to a process-owned `0600` memory-volume file because PostgreSQL rejects broadly readable private keys.

`LINK_EMAIL_ENABLED` defaults to `true`, requiring all Graph settings and the credential Secret. An explicit `false` disables the email API and UI, makes no Graph requests, and permits Graph credentials to be absent. The cluster test uses this setting; document delivery still works through copying the recipient link. No placeholder Graph credentials are generated.

## Keycloak

Use a confidential OIDC client, Standard Flow enabled, Direct Access Grants disabled, implicit/device flows disabled. Set root/home URL to the exact application origin. Valid redirect URI must be exactly `https://<host>/auth/callback`; set Web Origins to exactly `https://<host>` with no wildcard. Require PKCE S256. Use an HTTPS issuer of the form `https://<keycloak>/realms/<realm>` whose discovery issuer matches exactly.

Create client role `repository-sender` under the client named by `OIDC_ROLE_CLIENT`; restrict scope mappings and disable Full Scope Allowed. Retain the Keycloak `basic` client scope (or an equivalent subject mapper) so access tokens contain `sub`. Access tokens must contain `resource_access.<OIDC_ROLE_CLIENT>.roles`. Add an audience mapper putting the BFF's `OIDC_CLIENT_ID` in the access-token audience. The server validates the ID token through openid-client and independently validates the access-token signature, issuer, audience, subject and role. Accepted access-token signing algorithms are RS256, PS256 and ES256. Wrong/missing claims are rejected; no browser OAuth tokens are used.

Sessions expire absolutely after 15 minutes and are not refreshed. A role removal takes effect on the next login or session expiration. Logout deletes the BFF session; it does not globally terminate the user's Keycloak SSO session. PKCE transactions expire after five minutes and are consumed before code exchange. Production cookies are Secure, HttpOnly, SameSite=Lax and host-only; mutation requests also require matching Origin and session-bound CSRF token.

## Storage, cleanup and observability

Use a dedicated private ODF bucket with a documented **S3 storage class** for provisioning. That label does not select an AWS object-storage tier. Application metadata is in one in-namespace Postgres instance on block storage; this is not HA.

Run `node --import tsx scripts/admin.ts preflight` inside the configured application image. It exercises S3 multipart put/get/delete with synthetic random bytes, validates roundtrip and HEAD absence, confirms unauthenticated access denial, and rejects versioning (including suspended), retained versions/delete markers, lock, replication, unsafe lifecycle or public policy/ACL evidence. Unsupported permission/API responses fail closed. Do not weaken the checks for a gateway that cannot establish the required properties. ODF CRs/backing-store behavior and backup exclusions need separate operator evidence; S3 alone cannot prove those.

Cleanup runs every minute. Failed/revoked/expired/abandoned rows are removed idempotently; HEAD-confirmed absence is audited and timestamped. Old orphan objects and incomplete multipart uploads are reconciled too. GET always checks database state, capability and expiry. Each running replica subscribes to a Postgres notification channel, checks each emitted chunk and polls at 250ms; database uncertainty or expiry aborts active streams. An in-flight network write cannot be recalled atomically with a database update. The notification channel carries only `changed`, not capabilities or identifiers. A lost listener stops current streams; polling continues to guard subsequent streams.

`/metrics` exposes only aggregate cleanup pending count and oldest pending age. `deploy/monitoring.yaml` gives a TLS-verified ServiceMonitor, 23-hour deadline alert and scrape-failure alert; adapt its namespace/serverName when using a different namespace. Alert on backup CronJob failures and last successful backup older than 25 hours in your platform monitor. Readiness fails when invalidated objects remain unconfirmed after 23 hours. Alert routing and delivery require a live operator check. The 24-hour deletion objective is not established by unit tests or by an HTTP HEAD result alone.

Audit fields are restricted to repository ID, event, timestamp, outcome and sender ID on authenticated sender actions. Default retention is 90 days. The service records ciphertext transfer, never recipient reading. Application request logging is disabled; responses/providers/errors are reduced to fixed messages. Ingress, service mesh, load balancer, WAF, S3 gateway, database audit tools and APM are separate operator-controlled logging surfaces. Do not enable header/body/query or DB-parameter logging. Retained metadata backups may keep deleted audit rows for an additional 30 days.

## Backup and restore

The supplied CronJob authenticates as the separate `delivery_backup` role with `pg_read_all_data`, and runs a custom-format logical `pg_dump` daily at 02:00 UTC, checks its archive listing, atomically publishes it to a separate block-storage PVC and deletes dumps older than 30 days. The PVC is independent of the document bucket and Postgres data PVC. It is not an off-site disaster-recovery guarantee. Protect it with encryption/access controls and an approved off-cluster copy policy for metadata only. The daily schedule implies up to 24 hours of metadata/audit loss (RPO); a failed backup can extend this until corrected.

Safe restore procedure, in an isolated or explicitly authorized namespace:

1. Disable `RETRIEVAL_ENABLED` and scale all app replicas to zero. Freeze the backup job during the restore. Never expose a restored database to running apps before invalidation.
2. Restore the chosen dump to a clean database of the same supported PostgreSQL major version using `pg_restore --exit-on-error --no-owner`; use a mode-0600 PGPASSFILE and `PGSSLMODE=verify-full`. Do not print credentials. Restore ownership/grants so the migration/application role owns its schema objects; an admin-owned restore requires an explicit owner/grant correction before startup.
3. Run `scripts/admin.ts restore-invalidate` using the application image and database credentials. It disables the database retrieval switch, revokes EVERY recovered delivery, clears deletion evidence for reconciliation and removes all restored sessions/PKCE transactions. This deliberately invalidates even apparently unexpired deliveries to avoid resurrecting revocations missing from the dump.
4. Run `scripts/admin.ts cleanup` repeatedly until the document bucket is empty, no old multipart uploads remain and invalidated rows have confirmed absence. Run S3 preflight again and independently inspect versions/backing stores. Any objects absent from the metadata restore are orphans and must also be deleted.
5. Re-enable only after proof of reconciliation. Set ConfigMap `RETRIEVAL_ENABLED=true`, run `scripts/admin.ts enable-retrieval` and roll out the app. Previously recovered deliveries remain revoked; senders must recreate them with fresh keys. Document missing audit history since the backup and the restore-invalidation event.

Measure restore start, archive size, completion, invalidated row count, reconciliation completion, actual RTO and recovered last-audit timestamp in the restore drill. Local tests establish invalidation semantics, not a measured native PostgreSQL backup/restore RTO. The actual restore drill remains on the operator checklist.

## Rotation

- **Postgres:** use an approved role/password rotation procedure; update `delivery-database` and the actual database role together, then roll app replicas. Rotate the separate `delivery_backup` read-only role and its password/PGPASSFILE Secret together. Keep the administrative credential separate. Do not pass new passwords through CLI arguments or SQL logs. Verify TLS connections afterward.
- **S3:** issue replacement narrowly scoped bucket credentials, update the Secret, roll replicas, verify upload/get/delete/preflight, then revoke old credentials. Never change document keys.
- **OIDC/Graph:** create replacement application credentials using the provider's approved process, update Secrets and roll out; verify sign-in/scoped access in an authorized environment before removing old credentials. Do not widen permissions during rotation.
- **TLS/CA:** follow [cert-manager renewal and CA rotation](cert-manager.md). Update trusted CA bundles before certificate issuer changes where needed, rotate service certificates, then roll workloads and verify all hops. Never use insecure verification flags. Do not pin a serving leaf certificate as a long-term CA workaround.

Use `scripts/admin.ts disable-retrieval` for an emergency server-side stop; it does not erase previously obtained copies. There is no document-key rotation, recovery or administrator decrypt operation for a finalized package.
