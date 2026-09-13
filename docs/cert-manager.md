# TLS certificates with cert-manager

The ACM test deployment in `secure-delivery-test` uses cert-manager for its public Route certificate and all four application-owned backend certificates. Browser encryption and document keys are independent of this TLS configuration.

## Deployed certificates

| Certificate                      | Issuer                           | Use                                                                                     |
| -------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `delivery-public`                | ClusterIssuer `letsencrypt-prod` | A single SAN certificate for the delivery, isolated identity, and private registry URLs |
| `delivery-app-cert-manager`      | Issuer `delivery-internal`       | Router and health checks to app                                                         |
| `delivery-postgres-cert-manager` | Issuer `delivery-internal`       | Verified PostgreSQL connections from app, identity and backup jobs                      |
| `test-identity-cert-manager`     | Issuer `delivery-internal`       | Router to isolated Keycloak                                                             |
| `test-registry-cert-manager`     | Issuer `delivery-internal`       | Router to private test registry                                                         |
| `delivery-internal-ca`           | Issuer `delivery-bootstrap`      | Ten-year test CA backing the internal issuer                                            |

The existing public issuer solves DNS-01 through its configured Cloudflare account. No issuer credentials were copied or changed. The public certificate is issued by Let's Encrypt and currently expires **2026-12-12 00:21:42 UTC**. Public renewal is scheduled 15 days before expiry; internal 90-day leaves renew 30 days before expiry. Every leaf specifies `rotationPolicy: Always`.

Each Route remains `reencrypt` with HTTP redirected to HTTPS. `spec.tls.externalCertificate.name` references `delivery-public-tls`; the router loads future Secret updates directly. A namespace Role grants `openshift-ingress:router` access only to that public-serving Secret. Private keys remain in Kubernetes Secrets and are never embedded in Route YAML, source, or evidence. This follows [OpenShift's external certificate mechanism](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/routes#nw-ingress-route-secret-load-external-cert_creating-advanced-routes).

Internal certificates include their Service's `.svc` and `.svc.cluster.local` DNS names. The public CA is stored in `delivery-internal-trust`, key `service-ca.crt`, and each Route's destination CA. App, identity, backup, and monitoring configuration use that trust bundle. A separate `delivery-external-ca` still trusts the **cluster-managed ODF RGW** certificate. The shared cluster ingress, shared Keycloak, and ODF certificate configuration were not changed.

## Renewal pickup and CA rotation

Cert-manager renews Secrets, but processes that load certificates only at startup need a reload. `delivery-certificate-reload` runs every five minutes and checks the UID/revision and Ready condition of each named Certificate. It rolls changed workloads in dependency order (registry, database, identity, app), waits for readiness, and fails visibly on an unready certificate or rollout timeout. It retries a pending rollout on the next run and leaves workloads with zero replicas stopped. Public Route renewal requires no pod restart. See [cert-manager's renewal and key rotation behavior](https://cert-manager.io/docs/usage/certificate/).

The reload job uses the existing immutable app image and a mounted script. Its dedicated service account can get only the named Certificate resources and get/patch only the named Deployments/StatefulSet. It cannot read TLS Secrets or application credentials. Its root filesystem is read-only, it runs under `restricted-v2`, and its network policy lists the exact Kubernetes API Service and endpoint IPs. The application and database service accounts still have no Kubernetes API token or RBAC grants. Update these destination IPs if the API topology changes.

**PostgreSQL has one replica:** certificate renewal restarts it and briefly interrupts database-dependent operations. Renewal of registry and identity can also interrupt their single-instance services. Monitor failed reload Jobs, failed/expiring Certificates, and database/application readiness. Scheduled jobs keep one successful and two failed histories; details expire after 24 hours. The explicit renewal test Job is also temporary.

The long-lived test CA uses a stable key (`rotationPolicy: Never`), with its first renewal scheduled for **2035-09-11**. CA trust distribution is an operator procedure, separate from automatic leaf renewal: arrange rotation before that date. Cert-manager's CA issuer does not update client trust or automatically reissue every leaf when a CA changes. Provision a new CA/issuer, distribute an overlapping old/new public trust bundle to all clients and Routes, reload clients, change leaf issuer references and wait for renewed leaves/workload rollouts, then remove the old trust anchor. Preserve an approved recovery copy of the CA Secret through the cluster's protected credential-backup process. Never substitute a leaf certificate for the trust anchor. See the [CA issuer limitations](https://cert-manager.io/docs/configuration/ca/).

## Deploying and maintaining the configuration

Normal deployments use `scripts/render.mjs` / `scripts/deploy.sh` with `certManager` settings in `deploy/operator.example.json`. Provision ready public and internal issuers beforehand. `serviceCaFile` is the public trust bundle for the internal issuer; `externalCaFile` is the additional trust for external providers. Set exact API destination CIDRs for the reload job. The renderer adds the Certificates, narrow RBAC, renewal CronJob, and Secret-backed Route reference. `deploy/monitoring.yaml` remains optional and must use the target namespace and service name.

For the existing ACM test namespace, use the focused scripts; do not rerun initial bootstrap/deployment to update TLS:

```sh
export KUBECONFIG="$HOME/acm-kubeconfig"
node scripts/cluster-test-cert-issue.mjs
oc wait certificate --all -n secure-delivery-test --for=condition=Ready --timeout=180s
node scripts/cluster-test-cert-migrate.mjs prepare
node scripts/cluster-test-cert-migrate.mjs delivery
node scripts/cluster-test-cert-migrate.mjs test-identity
node scripts/cluster-test-cert-migrate.mjs delivery-postgres
node scripts/cluster-test-cert-migrate.mjs test-registry
node scripts/cluster-test-cert-migrate.mjs finish
```

`prepare` retains both trust roots during migration and suspends the reload CronJob; `finish` uses only the cert-manager CA for application backends, updates backup trust, and enables renewal pickup. Readiness waits must succeed before continuing. The obsolete serving-cert Secrets are retained unused for rollback. The original serving-CA ConfigMap is distinct from the active internal trust bundle because queued serving-CA controller writes can overwrite a ConfigMap even during annotation removal; the first rollout exposed this and the migration now creates a separate trust resource.

For fresh synthetic infrastructure, registry bootstrap/build precede certificate issuance; issue and wait for certificates before `cluster-test-deploy.mjs`, run the documented database migration/preflight, and complete the TLS migration steps above. Initial deployment intentionally starts the app stopped and retrieval disabled. These test scripts have fixed ACM names/IPs and are not portable production installers.

## Verified on ACM

- All six Certificates Ready, all three Routes admitted, app **2/2**, database/identity/registry each **1/1**.
- Public TLS 1.3 and system-root chain validation on app readiness (200), OIDC discovery (200), and unauthenticated registry (401). Served fingerprints equal the issued Secret's certificate.
- Controlled app leaf reissuance from revision 1 through 5 (temporary lifetime change, then restored to 90 days). The reload Job observed revision 5, rolled the app, and completed. Both live replicas serve that renewed certificate and reject a wrong hostname and an unrelated CA.
- Real Chrome OIDC login, encrypted upload/finalization, whole-package verification, individual/ZIP test output, cross-owner and missing-role denial, revocation and pending-state denial, and a native TLS-verified metadata backup passed after migration. The output adapter limitation from the original browser test still applies; this did not retest native Save dialogs.
- Provider probes cover verified PostgreSQL TLS, OIDC discovery and real ODF put/get/delete. No live mail was sent; it remains disabled.
- Updated renderer passed server-side admission dry run. Local TypeScript and the 48-test regression suite passed; local TLS fixture servers require permission to bind loopback sockets.

Evidence is in `evidence/cluster-test/cert-manager-verification.json`, `cert-manager-browser-workflow.json`, `cert-manager-provider-checks.ndjson`, and the public resource manifests. This validates an immediate renewal/reload cycle; it is not a months-long observation of scheduled renewal or a CA rollover drill.
