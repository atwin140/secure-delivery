# Docs signed by Sharkbait

The redesigned application runs at [docs.apps.acm.sharkbait.tech](https://docs.apps.acm.sharkbait.tech) on ACM, in namespace **`docs`**. Use `~/acm-kubeconfig` for administration.

The interface follows the supplied dark blue design: a Docs wordmark with “signed by Sharkbait,” blue action buttons and icons, document/lock artwork, two workspace panels, dismissible status notices, password visibility control, and responsive sender/recipient layouts. Help and Privacy controls provide the delivery and recovery guidance. The name is branding; it does not add a document-signing feature or change the encryption protocol.

## Sign-in

- Identity server: `https://identity-docs.apps.acm.sharkbait.tech`
- Realm: **`docs`**
- Client: **`docs`**
- Required client role: **`repository-sender`**
- Sender accounts: **`sender-a`** and **`sender-b`**, with the same passwords used in the previous deployment.

The app's settings live in ConfigMap `docs-config`. `OIDC_ISSUER` is `https://identity-docs.apps.acm.sharkbait.tech/realms/docs`; `OIDC_CLIENT_ID` and `OIDC_ROLE_CLIENT` are `docs`. The matching account passwords are stored in Secret `docs-sender-accounts`. On macOS, copy the password without displaying it:

```sh
oc --kubeconfig="$HOME/acm-kubeconfig" -n docs \
  get secret docs-sender-accounts -o jsonpath='{.data.sender-a}' \
  | base64 --decode | pbcopy
```

`denied-user` remains a negative authorization fixture with no sender role. Personal users are not automatically federated into this dedicated realm. Realm/client bootstrap configuration is held in Secret `docs-identity-realm`; once imported, Keycloak's database is authoritative, so changing that Secret alone does not update existing realm users or client settings. The issuer configuration is separate from account administration.

## Deployment and data

The application has two replicas; PostgreSQL, Keycloak and the private registry each have one. Images are pinned by digest after builds in namespace `docs`. The app and identity use a fresh database and dedicated private ODF bucket. The registry is `registry-docs.apps.acm.sharkbait.tech`. Workload, Route, credential and policy names use Docs names without `test`.

The earlier `secure-delivery-test` deployment was left intact. Its existing encrypted deliveries and links remain at the earlier URL; they were not copied or redirected. Sender passwords were retained as requested, while database, OIDC, registry and storage credentials were created independently for `docs`.

TLS is managed by cert-manager. `docs-public` uses `letsencrypt-prod` for the app, identity and registry URLs. `docs-internal` issues Service certificates from the namespace CA. Routes use re-encryption with verified backend trust and reference `docs-public-tls` directly. The external ODF trust remains separate. The scoped `docs-certificate-reload` CronJob checks every five minutes and rolls workloads when Certificate revisions change. Its service account cannot read credential Secrets.

Daily metadata backups run at **02:00 UTC** using `docs-metadata-backup` and the separate `docs-metadata-backups` PVC. Backup files retain the existing 30-day policy. Registry, metadata backup and PostgreSQL each have a 10 GiB block PVC. Email remains explicitly disabled; users share links themselves. Document retrieval is enabled after successful schema migration and storage preflight.

Certificate reloads can briefly interrupt single-replica PostgreSQL, identity and registry services. CA rollover remains an operator procedure using overlapping trust; see [cert-manager administration](cert-manager.md). This namespace remains subject to the outstanding environment/production checks in [operator-checklist.md](operator-checklist.md).

## Build and deployment scripts

`scripts/docs-deploy.mjs` provides the initial `bootstrap`, `registry-route`, and `configure` stages. It uses checked-in public resource blueprints from the earlier deployment and imports the existing sender accounts only through Kubernetes Secrets in process memory. It refuses to run initial application configuration over an existing `docs` Deployment. Use targeted updates for later releases.

Create portable build input with:

```sh
python3 scripts/build-context.py
```

This packages only explicit source files. macOS extended archive attributes caused the first build attempts to fail during source extraction; portable USTAR input fixed both builds. No credentials, `.local` files, test evidence, or source attachments enter the image build context.

After initial configuration, run `scripts/docs-admin.mjs migrate` and `preflight`, wait for both Jobs to succeed, then invoke `scripts/docs-activate.mjs`. Activation enables retrieval, waits for two app replicas, exercises the certificate reload job, and enables the recurring backup and reload schedules. Administrative Jobs have a 24-hour TTL. These helpers deliberately target ACM/`docs`; they are not a general multi-cluster installer.

Use `scripts/docs-browser.ts` for the synthetic real-browser workflow and `scripts/docs-verify.mjs` for read-only deployment/TLS checks. Browser evidence still uses a labeled synthetic output adapter; it does not establish native Save-dialog behavior.

## Evidence

`evidence/docs/` contains the public resource snapshots, immutable image references, build/deployment verification, real browser workflow, local regression results and 4K UI screenshots. Validation covers browser encryption and full verification, role/ownership denial, metadata backup, responsive widths and certificate trust. Existing security and production-acceptance boundaries remain documented in [status.md](status.md).
