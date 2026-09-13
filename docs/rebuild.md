# Commit, rebuild and resume Docs

All commands run from the repository root, the directory containing `package.json` and `CONTEXT.md`. This guide was prepared on 2026-09-13. The current deployment reference is in [docs-deployment.md](docs-deployment.md); the full environment acceptance checklist is in [operator-checklist.md](operator-checklist.md).

## Git repository and working checkout

The repository is [atwin140/secure-delivery](https://github.com/atwin140/secure-delivery), with the working checkout at `~/GIT/secure-delivery` on the original workstation and branch `main`. Use this application directory as the repository root. The surrounding ChatGPT project mirror is an earlier source location, not the active checkout.

On another workstation, clone the existing repository; do not initialize a second repository inside it:

```sh
git clone https://github.com/atwin140/secure-delivery.git
cd secure-delivery
git status --short --branch
```

Before starting work on an existing clean checkout:

```sh
cd ~/GIT/secure-delivery
git status --short --branch
git pull --ff-only origin main
```

Preserve and review any existing local work before pulling. After making and validating a change, stage only the intended files and review them before committing and pushing:

```sh
git add PATHS_YOU_CHANGED
git diff --cached --stat
git diff --cached
git commit -m "Describe the completed change"
git push origin main
```

Replace the paths and commit message with the actual change. The source includes internal hostnames, public certificates and deployment topology in evidence; choose repository visibility accordingly.

Commit source, `package-lock.json`, `.npmrc`, `.github/`, `.containerignore`, `.gitignore`, Containerfiles, scripts, templates, tests, docs and public evidence. **Keep `evidence/cluster-test/cert-manager-live-resources-public.json`: the ACM provisioning helper depends on this checked-in public blueprint.** Do not apply live-resource snapshots directly; they include historical bindings and environment-specific fields.

The ignore file excludes dependencies, compiled output, local runtime state, browser profiles/results, environment files, common credential/key files, dumps and generated archives. Keep populated manifests and all other sensitive material in `.local/` or an external secret store. An ignore rule cannot recognize every credential embedded in an otherwise ordinary file; inspect the staged changes. Public Secret examples contain placeholders only.

## Rebuild and run locally

Install Node **24.x, at least 24.19**, npm, Python 3, OpenSSL and `oc`. Tests use `oc kustomize`; a local `oc` wrapper around `kubectl` is sufficient only for that structural test (see the CI example). Browser tests require a current desktop Chrome installation. Use the supported Node line from `package.json`, not an arbitrary newer major.

```sh
git clone https://github.com/atwin140/secure-delivery.git
cd secure-delivery
npm ci --ignore-scripts
npm run build
npm test
npm run local
```

Open <http://127.0.0.1:3000>. This loopback-only workflow uses synthetic sign-in, embedded PostgreSQL/PGlite and local ciphertext storage in ignored `.local/`. It needs no Keycloak, kubeconfig, Podman or mail credentials. Production startup cannot enable synthetic authentication with an environment switch.

In another terminal at the repository root:

```sh
npm run test:browser
```

This uses synthetic output adapters; native Save-dialog checks remain separate. See [status.md](status.md) for browser/benchmark limits. `npm ci` honors the lockfile; intentional dependency updates require fresh validation. The pinned CI example builds and tests without deploying or receiving cluster credentials.

## Choose the correct cluster procedure

| Intent                                                           | Procedure                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Run the existing source locally                                  | Local workflow above                                               |
| Install an empty `docs` service on compatible ACM infrastructure | Fresh installation below                                           |
| Deploy changed application source over the existing service      | Existing application release below                                 |
| Recover metadata/identity after data loss                        | Recovery section; do not run fresh provisioning over retained data |
| Deploy to another cluster or different hostnames                 | Adapt the environment configuration before applying anything       |

Use an explicit kubeconfig in every cluster shell. It remains outside Git:

```sh
export KUBECONFIG="$HOME/acm-kubeconfig"
oc whoami
oc config current-context
oc get namespace docs --ignore-not-found
```

Run deployment commands only for the intended environment. Historical permission or healthy snapshots do not establish the state of a future cluster.

## Fresh ACM installation

This creates empty storage and a new identity database. It does not restore old deliveries. The revised standalone realm definition is locally tested, but the full fresh installation sequence has not been rerun since this handoff change.

Prerequisites to inspect before provisioning:

- ACM-compatible OpenShift Routes (including `externalCertificate`), BuildConfigs/Buildah and `restricted-v2`; sufficient quota and cluster permissions for namespace, namespaced RBAC, storage and workloads.
- cert-manager installed, with a Ready `ClusterIssuer/letsencrypt-prod` and its working DNS challenge credentials. The current issuer is externally provisioned; these scripts do not recreate its account or DNS credentials. DNS for the app, identity and registry names must reach the ingress router.
- ODF classes `ocs-storagecluster-ceph-rbd` and `ocs-storagecluster-ceph-rgw`; private bucket provisioning and verified S3 access. Three 10 GiB block PVCs are used for PostgreSQL, registry and metadata backups, plus the document bucket.
- Pull access to the pinned Red Hat Keycloak, Docker Hub registry, Node and PostgreSQL images. Preserve or recreate registry entitlements separately.
- A usable build node named `acm-wk-03`, or update that selector. This node was used after an earlier worker experienced disk evictions.
- Correct ingress/API addresses and namespace selectors in the public blueprint and `scripts/docs-deploy.mjs`. Current hardcoded addresses include API `172.30.0.1/32`, `10.0.1.141/32` through `10.0.1.143/32`, and approved external HTTPS `45.20.87.146/32`, `10.0.1.21/32`. Rediscover these after infrastructure changes.
- Local `htpasswd` on PATH, with bcrypt and stdin support (`-Bni`), as well as Node, Python 3 and `oc`.

`scripts/docs-deploy.mjs` owns current ACM namespace/hosts, storage classes, build node, API CIDRs and generated configuration. It transforms resource shapes and network policy from the public blueprint. `scripts/docs-realm.mjs` defines the `docs` realm without reading a previous cluster's identity Secret. `scripts/cert-manager-resources.mjs` supplies public/internal leaf Certificates and the scoped reload job. These helpers are not a general multi-cluster installer. The generic `scripts/render.mjs` + `deploy/operator.example.json` path expects separately provisioned identity, storage and Secrets; it is not a substitute for those dependencies.

If `docs` already exists, inspect it first. **Do not run bootstrap against the live service.** It applies initial resource templates and is not a harmless release command.

### 1. Provision registry, bucket and certificates

```sh
node scripts/docs-deploy.mjs bootstrap
oc -n docs wait certificate --all --for=condition=Ready --timeout=10m
oc -n docs rollout status deployment/docs-registry --timeout=5m
oc -n docs wait objectbucketclaim/docs-documents \
  --for=jsonpath='{.status.phase}'=Bound --timeout=5m
node scripts/docs-deploy.mjs registry-route
```

Check Route admission and verified HTTPS reachability before building. An unauthenticated request to `https://registry-docs.apps.acm.sharkbait.tech/v2/` should return **401** over valid TLS. Do not bypass certificate verification to continue.

### 2. Build both pinned images

```sh
python3 scripts/build-context.py
```

Run the following in Bash; it submits both builds sequentially and requires each to reach `Complete`:

```bash
(
  set -euo pipefail
  for name in docs docs-postgres; do
    build_ref=$(oc -n docs start-build "$name" \
      --from-archive=.local/docs/source-portable.tar.gz -o name)
    oc -n docs wait "$build_ref" \
      --for=jsonpath='{.status.phase}'=Complete --timeout=15m
    test "$(oc -n docs get "$build_ref" -o jsonpath='{.status.phase}')" = Complete
    oc -n docs get "$build_ref" \
      -o custom-columns=BUILD:.metadata.name,PHASE:.status.phase,DIGEST:.status.output.to.imageDigest
  done
)
```

A failed build may wait until timeout; inspect the named Build's conditions and logs. `oc start-build --follow` once returned exit code zero after source extraction failed, so its exit code alone is insufficient. The Python helper avoids macOS tar extended attributes and includes only allowlisted source. Build output is stored in the dedicated Docs registry. Podman can alternatively build the two Containerfiles with `scripts/build-images.sh`, but pushing and wiring those images is a separate operator workflow.

### 3. Choose account continuity, then configure

Initial configuration uses an existing Secret `docs/docs-sender-accounts` if one has been restored or provisioned. Otherwise it generates new random passwords for `sender-a`, `sender-b` and `denied-user`:

```sh
node scripts/docs-deploy.mjs configure
```

To import account passwords from another available Secret **instead of generating them**, use this form in place of the preceding command:

```sh
node scripts/docs-deploy.mjs configure \
  --accounts-from=secure-delivery-test/test-sender-accounts
```

The source Secret must contain all three account keys. Import happens only if `docs-sender-accounts` is absent; a Docs Secret takes precedence. The old namespace is optional and is never needed for the realm definition. For a disaster rebuild, restore the account Secret from the approved credential store before configuring if matching passwords are required. Do not reset passwords merely because the old namespace is unavailable.

The helper creates fresh database/OIDC credentials, the realm import Secret and dedicated storage configuration; pins app/database images by registry digest; leaves app replicas at zero and retrieval disabled; and suspends backup/reload schedules until activation. PostgreSQL initializes the separate application and Keycloak databases. Existing Deployment `docs` makes configuration refuse to run.

### 4. Migrate, check storage and activate

```bash
(
  set -euo pipefail
  oc -n docs rollout status statefulset/docs-postgres --timeout=5m
  oc -n docs rollout status deployment/docs-identity --timeout=5m
  for action in migrate preflight; do
    admin_job=$(node scripts/docs-admin.mjs "$action")
    oc -n docs wait "job/$admin_job" --for=condition=Complete --timeout=3m
  done
  node scripts/docs-activate.mjs
)
```

Preflight performs synthetic S3 operations and fails closed on incompatible storage. Activation requires successful migration/preflight Jobs, enables the retrieval gate and two app replicas, checks certificate reload, and enables the two schedules. These administrative Jobs expire after 24 hours; run activation while the successful Jobs still exist.

### 5. Verify the deployed service

```sh
node scripts/docs-verify.mjs
```

This checks verified public TLS, ready workloads/Certificates, runtime restrictions and required configuration. It reads credential Secrets without recording their values and writes public local evidence. Optional `--compare-accounts=NAMESPACE/SECRET` checks password preservation against another namespace; no old-namespace comparison runs by default. This does not establish successful interactive login.

For the synthetic real Chrome workflow, run `node --import tsx scripts/docs-browser.ts`. **That workflow mutates the test account's deliveries and creates a backup Job.** It is appropriate when synthetic validation is part of the deployment task. Verify `sender-a` and `sender-b` sign-in, denial for `denied-user`, create/encrypt/receive/verify/revoke, and account ownership. The account clipboard command is in [docs-deployment.md](docs-deployment.md).

Record new image digests and results. Complete relevant environment checks from the operator checklist before declaring broader readiness. Email remains disabled.

## Update the existing application release

Preserve the existing namespace, identities, Secrets, PVCs, OBC and realm. Do not run `bootstrap`, `configure` or `docs-activate.mjs` as a routine update. Confirm a current metadata backup and inspect whether the change includes database/schema/configuration work before updating an image.

For an **application-only change with no schema/configuration changes**, run local build/tests, create the portable build context, and submit only BuildConfig `docs` as above. Capture the current app image before changing it. Use the completed Build's immutable digest, never a mutable `latest` tag:

```bash
(
  set -euo pipefail
  previous_image=$(oc -n docs get deployment docs \
    -o jsonpath='{.spec.template.spec.containers[0].image}')
  python3 scripts/build-context.py
  build_ref=$(oc -n docs start-build docs \
    --from-archive=.local/docs/source-portable.tar.gz -o name)
  oc -n docs wait "$build_ref" --for=jsonpath='{.status.phase}'=Complete --timeout=15m
  digest=$(oc -n docs get "$build_ref" -o jsonpath='{.status.output.to.imageDigest}')
  if ! [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo 'Build output has no usable immutable digest.' >&2
    exit 1
  fi
  printf 'Previous application image: %s\n' "$previous_image"
  next_image="registry-docs.apps.acm.sharkbait.tech/docs@$digest"
  oc -n docs set image deployment/docs "app=$next_image"
  oc -n docs rollout status deployment/docs --timeout=5m
  node scripts/docs-verify.mjs
)
```

Record the previous/new image references in release notes, then validate login and the relevant user workflow. If rollout fails, inspect the cause. For this schema-free update, the captured previous digest can be set on `deployment/docs` to roll back the app. Do not assume rolling back an image reverses a database migration.

The certificate reload CronJob also embeds an application image to run its script, and the metadata backup CronJob embeds a PostgreSQL image. Update those deliberately when their runtime or scripts change; an app-only UI release need not roll database or identity services. Schema, database-major, OIDC, CA or network changes need their corresponding admin/rotation procedure and validation.

## Preserve what Git cannot rebuild

| Material                                                     | Required handling                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubeconfig, registry entitlements and issuer/DNS credentials | Keep in an approved credential store outside this repository; recreate infrastructure access first                                                                                                                                  |
| Docs infrastructure Secrets                                  | Protect `docs-postgres-admin`, `docs-database`, `docs-backup`, `docs-identity-database`, `docs-oidc`, `docs-s3`, `docs-registry-auth`, `docs-registry-push`; coordinate restored credentials with actual DB/registry/provider state |
| Sender passwords / initial realm                             | Protect `docs-sender-accounts` and `docs-identity-realm`; the import Secret is not a backup of subsequent account changes                                                                                                           |
| Application metadata/audit                                   | Daily logical `delivery` database dumps on `docs-metadata-backups`, retained 30 days; keep protected off-cluster copies under the metadata backup policy                                                                            |
| Identity database                                            | Back up the separate `keycloak` database through the approved identity procedure; the supplied daily job does **not** dump it. Preserve user IDs, password changes and realm/client administration here                             |
| Private CA and certificates                                  | Protect private CA material through the cluster secret-backup policy; leaf renewal is automated, but changing the root requires an explicit overlapping-trust rollover                                                              |
| Images                                                       | Rebuild from pinned source or retain immutable images in an approved registry; a lost in-namespace registry is not an independent image backup                                                                                      |
| Document ciphertext / recipient material                     | Exclude the document bucket from backups and retained copies. Keys, bundles and passwords belong to users; the service cannot recover them                                                                                          |

The separate metadata PVC is not an off-cluster disaster-recovery guarantee. A Git push transfers source and documentation only. It does not export Secrets or perform a Keycloak or off-cluster metadata backup.

For **metadata recovery**, follow [the admin restore procedure](admin-guide.md#backup-and-restore): disable retrieval, stop all app replicas, freeze the backup schedule, restore with verified TLS and correct grants, run `restore-invalidate`, reconcile/delete every old/orphaned ciphertext object and multipart upload, then verify before enabling service. Recovered deliveries stay revoked. On current Docs, use `scripts/docs-admin.mjs restore-invalidate`/`cleanup` and current `docs-*` resource names; the generic guide uses `delivery-*` examples.

Restore/reconcile Keycloak and its client credential separately if retaining identities. Creating the same usernames in a new realm does not preserve their original OIDC subject IDs. Coordinate issuer/client configuration with the restored database; do not expose a partially restored service.

## Restart work later

Open the Git checkout and paste [RESTART-PROMPT.md](../RESTART-PROMPT.md), with a concrete task. [CONTEXT.md](../CONTEXT.md) is the entry point; this guide supplies operational steps. Check recorded dates and actual live state before making new deployment claims.
