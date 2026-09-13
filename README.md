# Docs signed by Sharkbait

A browser-encrypted, single-tenant document delivery application for OpenShift. React/Vite UI, dedicated libsodium worker, Fastify BFF, Keycloak OIDC, PostgreSQL metadata, private ODF S3 ciphertext, and synchronous Microsoft Graph link email.

**Implemented and tested locally and in an isolated OpenShift deployment on ACM; production rollout has not been performed.** Read [completion status](docs/status.md) for measured checks and limitations. The application format is unreviewed, not an audited cryptosystem or a SOC 2 certification.

## Run locally

Use Node 24 LTS (24.19 or newer in the 24.x line), npm, OpenSSL and `oc` or `kubectl` with a compatible `kustomize` command. A current desktop Chrome installation is needed for browser tests.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run local
```

Open [the local application](http://127.0.0.1:3000). The synthetic sender requires no real identity credentials. Local mode uses embedded PostgreSQL/PGlite and ciphertext files in `.local/`; it never sends mail. It binds only to loopback. The production entrypoint cannot enable synthetic authentication through an environment switch.

In another terminal:

```sh
npm run test:browser
npm run benchmark
node --import tsx scripts/benchmark-browser.ts
npm run sbom
```

`npm test` generates a one-day, development-only TLS certificate inside ignored `.local/test-tls/`, trusts it only for its child test process, and runs local HTTPS OIDC/S3 doubles. It does not disable certificate verification. Browser tests use synthetic files and explicitly labeled output adapters. Native Save-dialog testing is an interactive operator check using `scripts/native-picker-check.ts`.

## Deployed application

[Open Docs signed by Sharkbait](https://docs.apps.acm.sharkbait.tech). It runs in namespace `docs` on ACM, with cert-manager TLS and a dedicated `docs` Keycloak realm. Existing `sender-a` and `sender-b` passwords are retained. See [deployment and sign-in details](docs/docs-deployment.md).

The earlier deployment and its links remain intact; its original [cluster test evidence](docs/cluster-test.md) is preserved.

## Deploy

Container definitions pin official Node and PostgreSQL base-image manifest digests. Build the application and database images with `scripts/build-images.sh`. Fill the **nonsecret** `deploy/operator.example.json` through your configuration process, provision ready cert-manager issuers and the referenced credential Secrets separately, and follow the single [operator checklist](docs/operator-checklist.md). `scripts/render.mjs` renders manifests without applying them; `scripts/deploy.sh` applies only when deliberately invoked by an authorized operator. The default configuration disables retrieval.

TLS uses cert-manager for public and internal certificates, with automatic leaf renewal pickup. See [certificate configuration and test evidence](docs/cert-manager.md).

## Contents

| Location                                    | Purpose                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/crypto/`                               | Versioned bundle, package framing, strict parsing, verified output and ZIP              |
| `src/web/`                                  | Sender/recipient UI and dedicated crypto/storage worker                                 |
| `src/server/`                               | API, sessions/OIDC, SQL schema, S3 transport, Graph, lifecycle and restore              |
| `deploy/`, `Containerfile`                  | Restricted OpenShift workloads, TLS, network policy, backup and Secret templates        |
| `scripts/`                                  | Local startup, migrations/admin, render/build/deploy, benchmarks and fixture generation |
| `tests/`                                    | Crypto, native interoperability, API/races, TLS OIDC/S3, manifest and browser tests     |
| `docs/protocol.md`                          | Frozen version-1 encoding and cryptographic parameters                                  |
| `docs/architecture.md`                      | API/schema/state machine, data-flow diagram and threat boundaries                       |
| `docs/evidence-matrix.md`                   | Requirement-to-code/test evidence and unrun checks                                      |
| `docs/user-guide.md`, `docs/admin-guide.md` | Use, operations, backup/restore and credential rotation                                 |
| `evidence/`                                 | Actual test reports, benchmarks, dependency SBOM and screenshots                        |

Temporary browser ciphertext is a downloaded copy. Revocation cannot remove previously downloaded ciphertext or plaintext. There is no recovery or administrator decryption. Do not test with real sensitive documents before completing environment validation.
