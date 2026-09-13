# Completion status — 2026-09-13

The application, versioned protocol, server integrations, OpenShift/container definitions, deployment/admin scripts, CI example, guides, threat model, SOC 2 evidence preparation and requirement matrix are implemented. The synthetic local application runs at `http://127.0.0.1:3000`. An isolated OpenShift deployment on ACM was subsequently tested successfully; see [cluster-test.md](cluster-test.md). Production rollout and operational acceptance are **not** claimed.

The requested redesign and clean namespace deployment are at [Docs signed by Sharkbait](https://docs.apps.acm.sharkbait.tech), namespace `docs`, realm `docs`. See [the current deployment guide](docs-deployment.md). The earlier cluster evidence below remains historical.

The Git handoff adds [project context](../CONTEXT.md), a [restart prompt](../RESTART-PROMPT.md) and [rebuild/recovery instructions](rebuild.md). The realm bootstrap now comes from source without requiring the old namespace. The handoff passed the production build and 50 unit/integration tests, including two new realm checks; see [handoff verification](../evidence/rebuild-handoff.json). No live deployment was changed, and the revised fresh provisioning path has not been exercised in a new namespace.

## Executed successfully

- Node 24.19.0 TypeScript check and production Vite build.
- **48 unit/integration tests** across eight files: fixed crypto fixtures and native libsodium cross-check; malformed/tampered packages and password bounds; API ownership/CSRF/capabilities; finalization/retry/revocation/expiry/cleanup/restore behavior; local TLS OIDC and S3 gateways; negative storage capability checks; production configuration rejection and startup-error redaction; email-link entry/API isolation; deployment and Secret-template validation/rendering.
- **4 Chrome 153.0.8010.36 browser tests**: encryption/request canaries; whole-package verification and individual/ZIP test output; late corruption prevents output; unsupported-browser/keyboard checks; cancellation while repository creation is in flight. Automated axe WCAG 2/2.1/2.2 A/AA checks in sender and verified-recipient states found no violations. This is not a complete WCAG conformance finding.
- `oc kustomize deploy`, nonsecret synthetic render including CA/image/CIDR validation, and `bash -n` on shell scripts. This is structural validation, not live admission or connectivity evidence.
- npm lockfile resolution, CycloneDX dependency SBOM and registry audit. The retained audit reports zero known vulnerabilities at collection time. Both Containerfiles were later built with OpenShift Buildah. An image-layer vulnerability scan/SBOM has not been run.

- Cert-manager TLS migration on ACM: six ready certificates, verified public and backend TLS, successful controlled renewal pickup, and a repeated real browser workflow/metadata backup. See [TLS evidence](cert-manager.md).

## Measured limits

Both full-size runs used **1 GiB plaintext, 100 files and 250 MiB maximum individual file output** on an Apple M4/macOS arm64 host. Node used maximum-length metadata and reached the exact 1,073,834,107-byte ciphertext ceiling.

| Measurement                 |   Node / actual local filesystem | Chrome / synthetic browser output adapter |
| --------------------------- | -------------------------------: | ----------------------------------------: |
| Unlock                      |                            85 ms |                                    103 ms |
| Encrypt                     |                           5.26 s |      9.73 s including upload/finalization |
| Verify                      |                           6.17 s |                8.38 s including retrieval |
| Individual output (250 MiB) |                           6.11 s |                                    7.46 s |
| ZIP output (1 GiB payload)  |                          13.04 s |                                   14.13 s |
| Peak observed RSS           | 509,001,728 bytes (Node process) | 1,341,980,672 bytes (Chrome process tree) |

These observations are not universal hardware promises. The 1–2 second unlock target was not the measured result on this host; the fixed requested KDF was preserved. Chrome's RSS includes browser/renderer/GPU and test-adapter storage behavior, not solely the crypto worker. Bounded application buffers do not imply a small fixed total browser RSS or perfect memory erasure.

The browser output adapter supplied genuine FileSystem handles pointing to **synthetic test-only OPFS outputs**. Product output uses native user-selected filesystem handles and never stages plaintext in OPFS. Adapter results establish worker/write/ZIP behavior, not native Save-dialog behavior or full-size native-destination throughput.

A 1 GiB private-context Chrome run rejected encryption with a quota error and did not finalize the delivery. A normal persistent-profile full run succeeded. A reused test-profile run subsequently closed during bundle download; repeating with a fresh normal profile succeeded. The benchmark script now uses a fresh normal profile and removes its test profile afterward. The earlier successful run with an extra test-harness wait is preserved separately and clearly labeled.

## Remaining validation boundaries

The exact production work is centralized in [operator-checklist.md](operator-checklist.md). The subsequent ACM test built and ran both images, admitted the app/database under restricted-v2 with an arbitrary namespace UID, verified real TLS Keycloak and ODF operations, completed the deployed browser workflow, and exercised native metadata backup/restore with invalidation and reconciliation. The app is running with two healthy replicas in `secure-delivery-test`. Live mail is explicitly disabled. Detailed outcomes and timings are in [cluster-test.md](cluster-test.md).

Live multi-pod stream-cutoff fault injection, a 24-hour deletion/cleanup-outage observation, backing-store physical-deletion proof, complete operator-log audit and production acceptance remain unrun.
Native Save dialogs were attempted in an isolated browser, but the available computer-use bridge could not target that process's dialog. The supplied manual script remains available for this check. Edge was not installed/tested; Firefox/Safari compatibility and comprehensive manual assistive-technology checks remain undeclared.

There are no intentionally stubbed production core features. Local service doubles are confined to the local/test paths; the ACM test instead uses real PostgreSQL, ODF and an isolated TLS Keycloak. No credentials were invented for production, no TLS/security control was disabled to make tests pass, no live email was sent and changes were confined to isolated test resources. No independent security audit or certification is claimed, and an independent review is not made a mandatory release gate.

## Evidence locations

`evidence/cluster-test/`, `evidence/unit-integration-tests.json`, `browser-tests.json`, `benchmark-node.json`, `benchmark-browser.json`, `benchmark-browser-success.json`, `browser-limitations.json`, `npm-audit.json`, `sbom.cdx.json`, `manifests-template.yaml`, and 4K sender/recipient screenshots. Source and operational guidance are linked from the root README and `evidence-matrix.md`.
