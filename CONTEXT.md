# Docs signed by Sharkbait — project context

Last updated: 2026-09-13. Start here when resuming from a Git checkout. The repository is [atwin140/secure-delivery](https://github.com/atwin140/secure-delivery), branch `main`. The working checkout on the original workstation is `~/GIT/secure-delivery`. It is independent of the earlier ChatGPT project mirror and its barbecue reference files; use the Git checkout for ongoing work.

## Purpose and current state

A sender signs in, encrypts documents in the browser, and shares a recipient link, portable key bundle and password through separate channels. A recipient needs no account, verifies the entire encrypted package locally, then saves individual files or a ZIP. There is no server decryption or key/password recovery.

The application is implemented and deployed on ACM OpenShift. Its current UI follows the requested dark blue reference with two workspace panels, blue actions, document/lock artwork, password visibility and responsive sender/recipient screens. The visible brand is **Docs signed by Sharkbait**. “Signed by” is branding, not a digital-signature feature.

The latest recorded live verification is dated 2026-09-13 in [deployment evidence](evidence/docs/deployment-verification.json) and [browser evidence](evidence/docs/browser-workflow.json). Treat these as historical observations; inspect the cluster before reporting current health. Production acceptance is not claimed. [Status](docs/status.md) and the [operator checklist](docs/operator-checklist.md) identify validation still outstanding.

## Start or resume

1. Read the current user request, this file and [README.md](README.md). Run `git status --short` before changing files; preserve existing work.
2. Use [RESTART-PROMPT.md](RESTART-PROMPT.md) for a new assistant session and [docs/rebuild.md](docs/rebuild.md) for Git setup, local startup, a fresh ACM deployment, release updates or recovery.
3. Read the specific implementation and authoritative document for the task; do not reconstruct the application from this summary.
4. Validate the changed behavior, then update the relevant documentation and record what actually ran. Keep dated historical evidence distinct from new results.

## Current deployment reference

| Setting                                | Recorded value                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| Cluster / namespace                    | ACM OpenShift 4.22.9 / `docs`                                                         |
| Kubeconfig on the original workstation | `~/acm-kubeconfig` (external credential, not in Git)                                  |
| Application                            | <https://docs.apps.acm.sharkbait.tech>                                                |
| Identity server                        | <https://identity-docs.apps.acm.sharkbait.tech>                                       |
| Issuer                                 | `https://identity-docs.apps.acm.sharkbait.tech/realms/docs`                           |
| Keycloak realm / client / role client  | `docs` / `docs` / `docs`                                                              |
| Required client role                   | `repository-sender`                                                                   |
| Sender accounts                        | `sender-a`, `sender-b`; original passwords retained in the live deployment            |
| Authorization fixture                  | `denied-user`, intentionally missing the sender role                                  |
| Nonsecret runtime configuration        | ConfigMap `docs-config`                                                               |
| Password / realm bootstrap storage     | Secrets `docs-sender-accounts`, `docs-identity-realm`                                 |
| Private image registry                 | `registry-docs.apps.acm.sharkbait.tech`                                               |
| Workloads                              | `docs` (2 replicas), `docs-postgres`, `docs-identity`, `docs-registry` (1 each)       |
| Object storage                         | Private ODF bucket provisioned by OBC `docs-documents`                                |
| TLS                                    | cert-manager; public `ClusterIssuer/letsencrypt-prod`, private `Issuer/docs-internal` |
| Recurring operations                   | Certificate reload every 5 minutes; metadata backup at 02:00 UTC, retained 30 days    |
| Feature switches                       | Retrieval enabled; link email disabled                                                |

Exact recorded image digests are in [evidence/docs/images.json](evidence/docs/images.json). Rebuilding may produce new digests. SQL database/application role names remain `delivery`; the identity database is `keycloak`. These internal names are intentional.

The earlier `secure-delivery-test` namespace remains separate. Its deliveries and links were not migrated or redirected. Current work targets `docs` unless the user says otherwise. Personal Keycloak accounts are not automatically federated into the Docs realm. After first import, Keycloak's database is authoritative; editing the realm Secret alone does not update accounts or clients. See [sign-in and deployment details](docs/docs-deployment.md).

## Implementation map

| Area                                  | Code / source of truth                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Original specification and decisions  | [requirements](docs/requirements.md), [decisions](docs/decisions.md)                                            |
| Frozen v1 crypto format               | [protocol](docs/protocol.md), `src/crypto/`, `tests/fixtures/golden.json`                                       |
| UI and worker                         | `src/web/main.tsx`, `style.css`, `icons.tsx`, `crypto.worker.ts`                                                |
| API, OIDC, sessions and lifecycle     | `src/server/`; [architecture](docs/architecture.md)                                                             |
| Database schema and administration    | `src/server/schema.sql`, `scripts/admin.ts`                                                                     |
| Generic manifests and render workflow | `deploy/`, `scripts/render.mjs`, `scripts/deploy.sh`                                                            |
| Current ACM provisioning              | `scripts/docs-deploy.mjs`, `docs-realm.mjs`, `docs-admin.mjs`, `docs-activate.mjs`                              |
| Certificate resources and reload      | `scripts/cert-manager-resources.mjs`, `deploy/certificate-reload.mjs`                                           |
| Automated validation                  | `tests/`, `scripts/test.mjs`, `scripts/docs-verify.mjs`, `scripts/docs-browser.ts`                              |
| Operations and recovery               | [admin guide](docs/admin-guide.md), [rebuild guide](docs/rebuild.md), [certificate guide](docs/cert-manager.md) |
| Requirement coverage                  | [evidence matrix](docs/evidence-matrix.md), [operator checklist](docs/operator-checklist.md)                    |

The implementation uses TypeScript, React/Vite, a dedicated libsodium worker, Fastify BFF, PostgreSQL and private S3-compatible ODF storage. OIDC uses authorization code + PKCE S256 and server-side sessions; OAuth tokens stay out of browser JavaScript. Microsoft Graph link mail exists but is disabled in the current deployment.

The root [security and compliance brief](SECURITY-COMPLIANCE-BRIEF.md) explains the PII/email comparison and selected SOC 2, NIST and DoD mappings. Preserve its distinction between implemented safeguards and assessed compliance; no SOC 2 attestation, FIPS validation or DoD authorization is established.

## Invariants to preserve

- All document encryption/decryption and key wrapping occur in the browser. Documents, internal filenames/metadata, document keys, bundle passwords and portable key bundles must not reach server APIs or logs.
- Preserve the versioned protocol, fixed KDF and limits. One secretstream with 1 MiB records; at most 100 files, 250 MiB per file and 1 GiB plaintext total. The server ciphertext ceiling is 1,073,834,107 bytes. Protocol changes require deliberate compatibility work and updated fixtures.
- Authenticate and validate the complete package before any plaintext output. Product OPFS staging contains ciphertext only; native filesystem handles receive plaintext. Test output adapters are explicitly synthetic.
- Recipient capabilities travel in a URL fragment, are cleared from the address bar and are submitted through an authorization header. Store only their verifier server-side; keep them out of query strings and logs.
- Finalization fixes a seven-day retrieval lifetime. Enforce sender ownership, revocation, expiry, stream interruption and cleanup. Revocation cannot erase downloaded copies.
- Keep S3 capability checks fail-closed and the document bucket excluded from backups, retained versions, retention locks and replication that preserves deleted data.
- Verify TLS and hostname trust on every network hop. Preserve restricted non-root workloads, minimal RBAC, default-deny network policy and separate public/internal/external trust.
- A metadata restore starts with retrieval disabled and all app replicas stopped. Run `restore-invalidate`, reconcile/delete ciphertext and verify absence before enabling service. Recovered deliveries stay revoked; senders recreate them.

## Rebuild facts and traps

- Commit this entire application directory, including hidden configuration, lockfile, scripts, templates and the public resource blueprint at `evidence/cluster-test/cert-manager-live-resources-public.json`. The ACM helper reads that file as build input. Other snapshots are evidence, not directly replayable manifests.
- The handoff update removed the live dependency on the old namespace's realm Secret. `scripts/docs-realm.mjs` now defines the realm from source. Initial configuration preserves an existing `docs-sender-accounts` Secret, optionally imports accounts with `--accounts-from=NAMESPACE/SECRET`, or generates fresh passwords. It does not modify a running deployment or an already imported Keycloak realm.
- ACM helpers are intentionally cluster-specific: hosts, storage classes, build node, ingress/API CIDRs and network selectors must be checked before another-cluster deployment. See the rebuild guide for exact locations.
- `bootstrap`/`configure` provision a new environment. `configure` refuses to overwrite an existing `docs` Deployment. Do not use bootstrap or initial provisioning as a release or restore procedure.
- Builds were performed with OpenShift Buildah because the workstation Podman engine was unreliable. `scripts/build-context.py` creates portable USTAR input; macOS extended tar attributes previously broke build extraction. Inspect the Build's `Complete` phase; `oc --follow` alone previously returned success after a failed build.
- Git contains no live credentials, metadata, Keycloak database or document ciphertext. The daily dump covers only the application `delivery` database, not `keycloak`. Account configuration changes require a separate protected identity backup. A fresh Git rebuild alone cannot preserve existing passwords, identities, audit history or links.

## Verification boundary for this handoff

Previously recorded: 48 unit/integration tests, 4 Chrome tests, a real Docs login/encrypt/verify/revoke workflow, responsive checks, TLS checks and a metadata backup. Source changes made for this Git handoff add offline realm-provisioning tests; see [handoff verification](evidence/rebuild-handoff.json) for the checks run against this revision. The revised initial provisioning path has not been exercised against a newly created cluster namespace.

Outstanding environment checks remain centralized in the operator checklist: native Save dialogs/full-size native output, Edge and other browsers, manual accessibility, multi-pod fault injection, provider physical deletion/24-hour observation, comprehensive infrastructure log audit, image-layer scanning and operational acceptance. Do not turn an adapter test or historical result into a broader claim.
