// Explicit ACM test deployment. Secrets are generated in memory and stored only in Kubernetes Secrets.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { parseAllDocuments, stringify } from "yaml";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
// Initial provisioning only: use the targeted TLS migration script on an existing deployment.
if (
  execFileSync(
    "oc",
    [
      "get",
      "deploy",
      "delivery",
      "-n",
      "secure-delivery-test",
      "--ignore-not-found",
      "-o",
      "name",
    ],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim()
)
  throw Error(
    "Application already exists. Use the targeted migration or normal operator deployment workflow.",
  );
const ns = "secure-delivery-test",
  host = "delivery-secure-delivery-test.apps.acm.sharkbait.tech",
  identityHost = "identity-secure-delivery-test.apps.acm.sharkbait.tech";
const registry = "registry-secure-delivery-test.apps.acm.sharkbait.tech";
const dbHost = `delivery-postgres.${ns}.svc`,
  identityImage =
    "registry.redhat.io/rhbk/keycloak-rhel9@sha256:52d3b0a986484ef8428d81b4db512f94741e89761fe47217dbc7529b5bcfa623";
const meta = (name) => ({
  name,
  namespace: ns,
  labels: { "app.kubernetes.io/part-of": "secure-delivery-test" },
});
const oc = (args, input) =>
  execFileSync("oc", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
const get = (type, name) =>
  JSON.parse(oc(["get", type, name, "-n", ns, "-o", "json"]));
const apply = (items) =>
  oc(
    ["apply", "-f", "-"],
    JSON.stringify({ apiVersion: "v1", kind: "List", items }),
  );
function secret(name, create) {
  try {
    return get("secret", name);
  } catch {
    const v = create();
    oc(
      ["create", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: meta(name),
        type: "Opaque",
        stringData: v,
      }),
    );
    return get("secret", name);
  }
}
const decode = (s, k) => Buffer.from(s.data[k], "base64").toString();
const random = () => randomBytes(32).toString("base64url");
secret("delivery-postgres-admin", () => ({ password: random() }));
secret("delivery-database", () => ({ password: random() }));
secret("delivery-backup", () => {
  const password = random();
  return {
    password,
    pgpass: `${dbHost}:5432:delivery:delivery_backup:${password}\n`,
  };
});
const oidc = secret("delivery-oidc", () => ({ "client-secret": random() }));
secret("test-identity-database", () => ({ password: random() }));
const accounts = secret("test-sender-accounts", () => ({
  "sender-a": random(),
  "sender-b": random(),
  "denied-user": random(),
}));
secret("delivery-s3", () => {
  const s = get("secret", "delivery-documents");
  return {
    "access-key": decode(s, "AWS_ACCESS_KEY_ID"),
    "secret-key": decode(s, "AWS_SECRET_ACCESS_KEY"),
  };
});
const realm = {
  realm: "delivery-test",
  enabled: true,
  sslRequired: "all",
  registrationAllowed: false,
  resetPasswordAllowed: false,
  bruteForceProtected: true,
  loginWithEmailAllowed: false,
  accessTokenLifespan: 300,
  ssoSessionIdleTimeout: 900,
  ssoSessionMaxLifespan: 3600,
  roles: { client: { "secure-delivery": [{ name: "repository-sender" }] } },
  clients: [
    {
      clientId: "secure-delivery",
      enabled: true,
      protocol: "openid-connect",
      publicClient: false,
      secret: decode(oidc, "client-secret"),
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      implicitFlowEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: false,
      redirectUris: [`https://${host}/auth/callback`],
      webOrigins: [`https://${host}`],
      attributes: { "pkce.code.challenge.method": "S256" },
      defaultClientScopes: ["profile", "basic"],
      protocolMappers: [
        {
          name: "sender-roles",
          protocol: "openid-connect",
          protocolMapper: "oidc-usermodel-client-role-mapper",
          config: {
            "usermodel.clientRoleMapping.clientId": "secure-delivery",
            "claim.name": "resource_access.secure-delivery.roles",
            "jsonType.label": "String",
            multivalued: "true",
            "access.token.claim": "true",
            "id.token.claim": "false",
          },
        },
        {
          name: "delivery-audience",
          protocol: "openid-connect",
          protocolMapper: "oidc-audience-mapper",
          config: {
            "included.client.audience": "secure-delivery",
            "access.token.claim": "true",
            "id.token.claim": "false",
          },
        },
      ],
    },
  ],
  clientScopeMappings: {
    "secure-delivery": [
      { client: "secure-delivery", roles: ["repository-sender"] },
    ],
  },
  users: ["sender-a", "sender-b", "denied-user"].map((username) => ({
    username,
    enabled: true,
    firstName: "Synthetic",
    lastName: "Test",
    emailVerified: true,
    email: username + "@example.invalid",
    credentials: [
      { type: "password", value: decode(accounts, username), temporary: false },
    ],
    clientRoles:
      username === "denied-user"
        ? {}
        : { "secure-delivery": ["repository-sender"] },
  })),
};
secret("test-identity-realm", () => ({
  "delivery-test-realm.json": JSON.stringify(realm),
}));
const initScript = `#!/usr/bin/env bash
set -euo pipefail
export TEST_IDENTITY_PASSWORD
TEST_IDENTITY_PASSWORD=$(cat /test-identity-secret/password)
if ! psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null 2>&1 <<'SQL'
\\getenv identity_password TEST_IDENTITY_PASSWORD
SELECT format('CREATE ROLE keycloak LOGIN PASSWORD %L', :'identity_password') \\gexec
CREATE DATABASE keycloak OWNER keycloak;
SQL
then echo 'Isolated identity database initialization failed.' >&2; exit 1; fi
unset TEST_IDENTITY_PASSWORD
`;
apply([
  {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: meta("test-identity-db-init"),
    data: { "20-test-identity.sh": initScript },
  },
]);
if (process.argv[2] === "prepare") {
  console.log(
    "Prepared test-only Secret contracts and isolated realm. No credential values were printed.",
  );
  process.exit(0);
}
const auth = JSON.parse(
  decode(get("secret", "test-registry-push"), ".dockerconfigjson"),
).auths[registry].auth;
async function image(name) {
  const r = await fetch(`https://${registry}/v2/${name}/manifests/test`, {
    method: "HEAD",
    headers: {
      authorization: `Basic ${auth}`,
      accept:
        "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
    },
  });
  if (!r.ok)
    throw Error(`Built image unavailable: ${name}, status ${r.status}`);
  const d = r.headers.get("docker-content-digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(d ?? ""))
    throw Error("Missing built digest");
  return `${registry}/${name}@${d}`;
}
const [appImage, postgresImage] = await Promise.all([
  image("delivery"),
  image("delivery-postgres"),
]);
const bucket = get("cm", "delivery-documents").data;
const serviceCa = Buffer.from(
  get("secret", "delivery-internal-ca").data["tls.crt"],
  "base64",
).toString();
const externalCa = get("cm", "delivery-service-ca").data["service-ca.crt"];
writeFileSync(".local/cluster-test/cert-manager-ca.crt", serviceCa);
writeFileSync(".local/cluster-test/service-ca.crt", externalCa);
// Node retains its public root store; this adds the OpenShift service CA for internal RGW.
const addresses = await lookup(host, { all: true });
const clusterCidrs = JSON.parse(
  readFileSync("evidence/cluster-test/discovered-network.json"),
).inClusterIdentityHttpsCidrs;
const input = {
  namespace: ns,
  appImage,
  postgresImage,
  host,
  blockStorageClass: "ocs-storagecluster-ceph-rbd",
  serviceCaFile: ".local/cluster-test/cert-manager-ca.crt",
  certManager: {
    publicIssuer: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
    internalIssuer: { name: "delivery-internal", kind: "Issuer" },
    publicHosts: [host, identityHost, registry],
    apiCidrs: [
      "172.30.0.1/32",
      "10.0.1.141/32",
      "10.0.1.142/32",
      "10.0.1.143/32",
    ],
    imagePullSecrets: [{ name: "test-registry-push" }],
    targets: [
      {
        name: "test-registry",
        kind: "deployments",
        certificate: "test-registry-cert-manager",
      },
      {
        name: "delivery-postgres",
        kind: "statefulsets",
        certificate: "delivery-postgres-cert-manager",
      },
      {
        name: "test-identity",
        kind: "deployments",
        certificate: "test-identity-cert-manager",
      },
      {
        name: "delivery",
        kind: "deployments",
        certificate: "delivery-app-cert-manager",
      },
    ],
  },
  externalCaFile: ".local/cluster-test/service-ca.crt",
  externalHttpsCidrs: [
    ...new Set([
      ...addresses.map((a) => a.address + (a.family === 4 ? "/32" : "/128")),
      ...clusterCidrs,
    ]),
  ],
  config: {
    OIDC_ISSUER: `https://${identityHost}/realms/delivery-test`,
    OIDC_CLIENT_ID: "secure-delivery",
    OIDC_ROLE_CLIENT: "secure-delivery",
    OIDC_REQUIRED_ROLE: "repository-sender",
    S3_ENDPOINT: `https://${bucket.BUCKET_HOST}`,
    S3_REGION: bucket.BUCKET_REGION || "us-east-1",
    S3_BUCKET: bucket.BUCKET_NAME,
    S3_STORAGE_CLASS: "ocs-storagecluster-ceph-rgw",
    GRAPH_TENANT_ID: "",
    GRAPH_CLIENT_ID: "",
    GRAPH_MAILBOX: "",
    LINK_EMAIL_ENABLED: "false",
    BRAND_NAME: "Secure Delivery · deployment test",
    SUPPORT_TEXT:
      "Synthetic test deployment. Contact the test operator for access.",
    RETRIEVAL_ENABLED: "false",
    AUDIT_RETENTION_DAYS: "90",
  },
};
writeFileSync(
  "evidence/cluster-test/operator-public.json",
  JSON.stringify(input, null, 2) + "\n",
);
oc(["version", "--client"]);
execFileSync(
  process.execPath,
  [
    "scripts/render.mjs",
    "evidence/cluster-test/operator-public.json",
    ".local/cluster-test/rendered.yaml",
  ],
  { stdio: "pipe" },
);
const docs = parseAllDocuments(
  readFileSync(".local/cluster-test/rendered.yaml", "utf8"),
).map((d) => d.toJSON());
for (const d of docs) {
  const pod =
    d.spec?.template?.spec ?? d.spec?.jobTemplate?.spec?.template?.spec;
  if (pod) pod.imagePullSecrets = [{ name: "test-registry-push" }];
  if (d.kind === "Deployment") d.spec.replicas = 0; // Migrate and preflight before enabling app replicas.
  if (d.kind === "CronJob") d.spec.suspend = true;
  if (d.kind === "ConfigMap" && d.metadata.name === "delivery-postgres-config")
    d.data["pg_hba.conf"] +=
      "hostssl keycloak keycloak 0.0.0.0/0 scram-sha-256\nhostssl keycloak keycloak ::/0 scram-sha-256\n";
  if (d.kind === "StatefulSet") {
    pod.containers[0].volumeMounts.push(
      {
        name: "identity-db-init",
        mountPath: "/docker-entrypoint-initdb.d/20-test-identity.sh",
        subPath: "20-test-identity.sh",
        readOnly: true,
      },
      {
        name: "identity-secret",
        mountPath: "/test-identity-secret",
        readOnly: true,
      },
    );
    pod.volumes.push(
      {
        name: "identity-db-init",
        configMap: { name: "test-identity-db-init", defaultMode: 365 },
      },
      {
        name: "identity-secret",
        secret: { secretName: "test-identity-database", defaultMode: 288 },
      },
    );
  }
}
const sec = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
};
const identity = [
  {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: meta("test-identity"),
    automountServiceAccountToken: false,
  },
  {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      ...meta("test-identity"),
    },
    spec: {
      selector: { app: "test-identity" },
      ports: [{ name: "https", port: 8443, targetPort: 8443 }],
    },
  },
  {
    apiVersion: "route.openshift.io/v1",
    kind: "Route",
    metadata: meta("test-identity"),
    spec: {
      host: identityHost,
      to: { kind: "Service", name: "test-identity" },
      port: { targetPort: "https" },
      tls: {
        termination: "reencrypt",
        externalCertificate: { name: "delivery-public-tls" },
        insecureEdgeTerminationPolicy: "Redirect",
        destinationCACertificate: serviceCa,
      },
    },
  },
  {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: meta("test-identity"),
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "test-identity" } },
      template: {
        metadata: { labels: { app: "test-identity" } },
        spec: {
          serviceAccountName: "test-identity",
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            seccompProfile: { type: "RuntimeDefault" },
          },
          initContainers: [
            {
              name: "prepare-runtime",
              image: identityImage,
              command: ["/bin/bash", "-ec", "cp -R /opt/keycloak/. /work/"],
              securityContext: sec,
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "1", memory: "512Mi" },
              },
              volumeMounts: [{ name: "runtime", mountPath: "/work" }],
            },
          ],
          containers: [
            {
              name: "identity",
              image: identityImage,
              command: ["/opt/keycloak/bin/kc.sh", "start", "--import-realm"],
              securityContext: sec,
              resources: {
                requests: { cpu: "500m", memory: "768Mi" },
                limits: { cpu: "2", memory: "2Gi" },
              },
              env: [
                { name: "KC_HOSTNAME", value: `https://${identityHost}` },
                { name: "KC_HOSTNAME_STRICT", value: "true" },
                { name: "KC_HTTP_ENABLED", value: "false" },
                { name: "KC_PROXY_HEADERS", value: "xforwarded" },
                { name: "KC_HTTPS_CERTIFICATE_FILE", value: "/tls/tls.crt" },
                {
                  name: "KC_HTTPS_CERTIFICATE_KEY_FILE",
                  value: "/tls/tls.key",
                },
                { name: "KC_DB", value: "postgres" },
                {
                  name: "KC_DB_URL",
                  value: `jdbc:postgresql://${dbHost}:5432/keycloak?sslmode=verify-full&sslrootcert=/trust/service-ca.crt`,
                },
                { name: "KC_DB_USERNAME", value: "keycloak" },
                {
                  name: "KC_DB_PASSWORD",
                  valueFrom: {
                    secretKeyRef: {
                      name: "test-identity-database",
                      key: "password",
                    },
                  },
                },
                { name: "KC_LOG_LEVEL", value: "warn" },
              ],
              ports: [{ containerPort: 8443, name: "https" }],
              readinessProbe: {
                tcpSocket: { port: 8443 },
                initialDelaySeconds: 15,
                periodSeconds: 5,
              },
              volumeMounts: [
                { name: "runtime", mountPath: "/opt/keycloak" },
                {
                  name: "realm",
                  mountPath: "/opt/keycloak/data/import",
                  readOnly: true,
                },
                { name: "tls", mountPath: "/tls", readOnly: true },
                { name: "trust", mountPath: "/trust", readOnly: true },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            { name: "runtime", emptyDir: { sizeLimit: "1Gi" } },
            {
              name: "realm",
              secret: { secretName: "test-identity-realm", defaultMode: 288 },
            },
            {
              name: "tls",
              secret: {
                secretName: "test-identity-cert-manager-tls",
                defaultMode: 288,
              },
            },
            { name: "trust", configMap: { name: "delivery-internal-trust" } },
            { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "128Mi" } },
          ],
        },
      },
    },
  },
  {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta("router-to-test-identity"),
    spec: {
      podSelector: { matchLabels: { app: "test-identity" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "network.openshift.io/policy-group": "ingress" },
              },
            },
          ],
          ports: [{ protocol: "TCP", port: 8443 }],
        },
      ],
    },
  },
  {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta("test-identity-to-database"),
    spec: {
      podSelector: { matchLabels: { app: "delivery-postgres" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { app: "test-identity" } } }],
          ports: [{ protocol: "TCP", port: 5432 }],
        },
      ],
    },
  },
  {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta("application-to-rgw"),
    spec: {
      podSelector: { matchLabels: { app: "delivery" } },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "openshift-storage",
                },
              },
              podSelector: { matchLabels: { app: "rook-ceph-rgw" } },
            },
          ],
          ports: [{ protocol: "TCP", port: 443 }],
        },
      ],
    },
  },
];
const adminPolicies = JSON.parse(
  readFileSync("evidence/cluster-test/admin-network-public.json"),
).items;
const all = [...docs, ...identity, ...adminPolicies];
const yaml = all.map(stringify).join("---\n");
writeFileSync("evidence/cluster-test/deployment-public.yaml", yaml);
oc(
  ["apply", "--dry-run=server", "-f", "-"],
  JSON.stringify({ apiVersion: "v1", kind: "List", items: all }),
);
apply(all);
console.log(
  JSON.stringify({
    namespace: ns,
    appImage,
    postgresImage,
    applicationReplicas: 0,
    emailEnabled: false,
    backupScheduleSuspended: true,
    identity: "isolated TLS Keycloak, synthetic accounts only",
  }),
);
