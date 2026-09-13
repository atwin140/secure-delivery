// Explicit ACM deployment into docs. Credentials stay in memory and Kubernetes Secrets.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, X509Certificate } from "node:crypto";
import { certManagerResources } from "./cert-manager-resources.mjs";
import { createDocsRealm, senderNames } from "./docs-realm.mjs";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
const ns = "docs",
  host = "docs.apps.acm.sharkbait.tech",
  identityHost = "identity-docs.apps.acm.sharkbait.tech",
  registry = "registry-docs.apps.acm.sharkbait.tech";
const mode = process.argv[2];
const accountOption = process.argv[3];
if (
  process.argv.length > 4 ||
  (accountOption &&
    (mode !== "configure" ||
      !/^--accounts-from=[a-z0-9.-]+\/[a-z0-9.-]+$/.test(accountOption)))
)
  throw Error(
    "Use configure [--accounts-from=NAMESPACE/SECRET], bootstrap, or registry-route",
  );
const accountSource = accountOption
  ?.slice("--accounts-from=".length)
  .split("/");
mkdirSync(".local/docs", { recursive: true });
mkdirSync("evidence/docs", { recursive: true });
const oc = (args, input) =>
  execFileSync("oc", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
const get = (kind, name, namespace = ns) =>
  JSON.parse(oc(["get", kind, name, "-n", namespace, "-o", "json"]));
const meta = (name) => ({
  name,
  namespace: ns,
  labels: { "app.kubernetes.io/part-of": "docs" },
});
const apply = (items) =>
  oc(
    ["apply", "-f", "-"],
    JSON.stringify({ apiVersion: "v1", kind: "List", items }),
  );
const patch = (kind, name, value) =>
  oc(
    ["patch", kind, name, "-n", ns, "--type=merge", "--patch-file=/dev/stdin"],
    JSON.stringify(value),
  );
const random = () => randomBytes(32).toString("base64url");
function secret(name, make, type = "Opaque") {
  const exists = oc([
    "get",
    "secret",
    name,
    "-n",
    ns,
    "--ignore-not-found",
    "-o",
    "name",
  ]).trim();
  if (!exists)
    oc(
      ["create", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: meta(name),
        type,
        stringData: make(),
      }),
    );
  return get("secret", name);
}
const decode = (s, key) => Buffer.from(s.data[key], "base64").toString();
// Public, already validated resource shapes from the earlier deployment; no Secrets are imported.
const blueprint = JSON.parse(
  readFileSync("evidence/cluster-test/cert-manager-live-resources-public.json"),
).items;
const names = new Map(
  blueprint.map((r) => [
    r.metadata.name,
    r.metadata.name
      .replaceAll("test-", "docs-")
      .replace(/^delivery-/, "docs-")
      .replace(/^delivery$/, "docs"),
  ]),
);
for (const name of [
  "delivery-admin",
  "test-registry-auth",
  "test-registry-push",
  "test-identity-realm",
  "test-identity-database",
  "test-sender-accounts",
  "delivery-postgres-admin",
  "delivery-database",
  "delivery-backup",
  "delivery-oidc",
  "delivery-s3",
  "delivery-graph",
  "delivery-app-cert-manager-tls",
  "delivery-postgres-cert-manager-tls",
  "test-registry-cert-manager-tls",
  "test-identity-cert-manager-tls",
  "delivery-public-tls",
])
  names.set(
    name,
    name.replaceAll("test-", "docs-").replace(/^delivery-/, "docs-"),
  );
function transform(value) {
  if (typeof value === "string") {
    let s = value
      .replaceAll(
        "registry-secure-delivery-test.apps.acm.sharkbait.tech",
        registry,
      )
      .replaceAll(
        "identity-secure-delivery-test.apps.acm.sharkbait.tech",
        identityHost,
      )
      .replaceAll("delivery-secure-delivery-test.apps.acm.sharkbait.tech", host)
      .replaceAll("secure-delivery-test", ns);
    if (names.has(s)) return names.get(s);
    for (const [from, to] of [...names]
      .filter(([name]) => name !== "delivery")
      .sort((a, b) => b[0].length - a[0].length))
      s = s.replaceAll(from, to);
    return s.replaceAll("delivery.docs.svc", "docs.docs.svc");
  }
  if (Array.isArray(value)) return value.map(transform);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [transform(k), transform(v)]),
    );
  return value;
}
function template(kind, name) {
  const src = blueprint.find(
    (r) => r.kind === kind && r.metadata.name === name,
  );
  if (!src) throw Error("Missing public template: " + kind + "/" + name);
  const r = transform(structuredClone(src));
  r.metadata = meta(r.metadata.name);
  delete r.status;
  if (r.kind === "Service") {
    for (const k of ["clusterIP", "clusterIPs", "ipFamilies", "ipFamilyPolicy"])
      delete r.spec[k];
  }
  if (r.spec?.template) {
    delete r.spec.template.metadata.annotations;
    r.spec.template.metadata.labels["app.kubernetes.io/part-of"] = "docs";
  }
  return r;
}
const targets = [
  {
    name: "docs-registry",
    kind: "deployments",
    certificate: "docs-registry-cert-manager",
  },
  {
    name: "docs-postgres",
    kind: "statefulsets",
    certificate: "docs-postgres-cert-manager",
  },
  {
    name: "docs-identity",
    kind: "deployments",
    certificate: "docs-identity-cert-manager",
  },
  { name: "docs", kind: "deployments", certificate: "docs-app-cert-manager" },
];
function tlsResources(appImage) {
  const resources = certManagerResources({
    namespace: ns,
    appImage,
    publicIssuer: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
    internalIssuer: { name: "docs-internal", kind: "Issuer" },
    publicHosts: [host, identityHost, registry],
    apiCidrs: [
      "172.30.0.1/32",
      "10.0.1.141/32",
      "10.0.1.142/32",
      "10.0.1.143/32",
    ],
    targets,
    imagePullSecrets: [{ name: "docs-registry-push" }],
  });
  // Generic helper names are translated to the deployment's application name.
  return resources.map(transform);
}
try {
  if (mode === "bootstrap") {
    const namespace = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: ns,
        labels: {
          "app.kubernetes.io/part-of": "docs",
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/warn": "restricted",
        },
      },
    };
    apply([namespace]);
    secret("docs-registry-auth", () => {
      const password = random();
      const htpasswd = execFileSync("htpasswd", ["-Bni", "docs-registry"], {
        input: password + "\n",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      secret(
        "docs-registry-push",
        () => ({
          ".dockerconfigjson": JSON.stringify({
            auths: {
              [registry]: {
                auth: Buffer.from("docs-registry:" + password).toString(
                  "base64",
                ),
              },
            },
          }),
        }),
        "kubernetes.io/dockerconfigjson",
      );
      return { htpasswd, "http-secret": random() };
    });
    const root = template("Certificate", "delivery-internal-ca");
    root.spec.commonName = "Docs signed by Sharkbait Internal CA";
    root.spec.subject = { organizations: ["Sharkbait"] };
    const tls = tlsResources("unused@sha256:" + "0".repeat(64)).filter(
      (r) =>
        ["Certificate", "Role", "RoleBinding"].includes(r.kind) &&
        r.metadata.name !== "docs-certificate-reload",
    );
    const items = [
      template("Issuer", "delivery-bootstrap"),
      root,
      template("Issuer", "delivery-internal"),
      ...tls,
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          ...meta("docs-odf-ca"),
          annotations: { "service.beta.openshift.io/inject-cabundle": "true" },
        },
      },
      {
        apiVersion: "objectbucket.io/v1alpha1",
        kind: "ObjectBucketClaim",
        metadata: meta("docs-documents"),
        spec: {
          generateBucketName: "docs",
          storageClassName: "ocs-storagecluster-ceph-rgw",
        },
      },
      {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: meta("docs-registry"),
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "ocs-storagecluster-ceph-rbd",
          resources: { requests: { storage: "10Gi" } },
        },
      },
      template("ServiceAccount", "test-registry"),
      template("Service", "test-registry"),
      template("Deployment", "test-registry"),
      template("NetworkPolicy", "default-deny"),
      template("NetworkPolicy", "required-internal-egress"),
      template("NetworkPolicy", "router-to-test-registry"),
    ];
    items
      .find((r) => r.kind === "Deployment")
      .spec.template.spec.containers[0].env.find(
        (e) => e.name === "REGISTRY_AUTH_HTPASSWD_REALM",
      ).value = "Docs private registry";
    apply(items);
    const buildNetwork = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta("docs-build-egress"),
      spec: {
        podSelector: {
          matchExpressions: [
            { key: "openshift.io/build.name", operator: "Exists" },
          ],
        },
        policyTypes: ["Egress"],
        egress: [
          {
            ports: [
              { protocol: "TCP", port: 443 },
              { protocol: "TCP", port: 6443 },
            ],
          },
        ],
      },
    };
    const builds = ["docs", "docs-postgres"].map((name) => ({
      apiVersion: "build.openshift.io/v1",
      kind: "BuildConfig",
      metadata: meta(name),
      spec: {
        runPolicy: "Serial",
        nodeSelector: { "kubernetes.io/hostname": "acm-wk-03" },
        source: { type: "Binary", binary: {} },
        strategy: {
          type: "Docker",
          dockerStrategy: {
            dockerfilePath:
              name === "docs"
                ? "Containerfile"
                : "deploy/Containerfile.postgres",
          },
        },
        output: {
          to: { kind: "DockerImage", name: `${registry}/${name}:latest` },
          pushSecret: { name: "docs-registry-push" },
        },
        resources: {
          requests: { cpu: "500m", memory: "1Gi" },
          limits: { cpu: "4", memory: "4Gi" },
        },
        successfulBuildsHistoryLimit: 2,
        failedBuildsHistoryLimit: 2,
      },
    }));
    apply([buildNetwork, ...builds]);
    writeFileSync(
      "evidence/docs/bootstrap-public.json",
      JSON.stringify(
        {
          apiVersion: "v1",
          kind: "List",
          items: [namespace, ...items, buildNetwork, ...builds],
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "Created docs namespace, dedicated registry, bucket claim, cert-manager certificates and build definitions.",
    );
  } else if (mode === "registry-route") {
    const ca = decode(get("secret", "docs-internal-ca"), "tls.crt");
    new X509Certificate(ca);
    const route = template("Route", "test-registry");
    route.spec.tls.destinationCACertificate = ca;
    apply([route]);
    console.log("Registry Route configured with cert-manager TLS.");
  } else if (mode === "configure") {
    if (
      oc([
        "get",
        "deploy",
        "docs",
        "-n",
        ns,
        "--ignore-not-found",
        "-o",
        "name",
      ]).trim()
    )
      throw Error(
        "Docs is already configured; use targeted changes instead of initial provisioning.",
      );
    const ca = decode(get("secret", "docs-internal-ca"), "tls.crt");
    new X509Certificate(ca);
    const externalCa = get("cm", "docs-odf-ca").data["service-ca.crt"];
    new X509Certificate(externalCa);
    const auth = JSON.parse(
      decode(get("secret", "docs-registry-push"), ".dockerconfigjson"),
    ).auths[registry].auth;
    async function built(name) {
      const r = await fetch(`https://${registry}/v2/${name}/manifests/latest`, {
        method: "HEAD",
        headers: {
          authorization: "Basic " + auth,
          accept:
            "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        },
      });
      const digest = r.headers.get("docker-content-digest");
      if (!r.ok || !/^sha256:[a-f0-9]{64}$/.test(digest))
        throw Error("Built image unavailable: " + name);
      return registry + "/" + name + "@" + digest;
    }
    const appImage = await built("docs"),
      postgresImage = await built("docs-postgres");
    for (const name of [
      "docs-postgres-admin",
      "docs-database",
      "docs-identity-database",
    ])
      secret(name, () => ({ password: random() }));
    secret("docs-backup", () => {
      const password = random();
      return {
        password,
        pgpass: `docs-postgres.docs.svc:5432:delivery:delivery_backup:${password}\n`,
      };
    });
    const oidc = secret("docs-oidc", () => ({ "client-secret": random() }));
    const accounts = secret("docs-sender-accounts", () => {
      const previous = accountSource
        ? get("secret", accountSource[1], accountSource[0])
        : undefined;
      return Object.fromEntries(
        senderNames.map((n) => [n, previous ? decode(previous, n) : random()]),
      );
    });
    const realm = createDocsRealm({
      origin: `https://${host}`,
      clientSecret: decode(oidc, "client-secret"),
      passwords: Object.fromEntries(
        senderNames.map((n) => [n, decode(accounts, n)]),
      ),
    });
    secret("docs-identity-realm", () => ({
      "docs-realm.json": JSON.stringify(realm),
    }));
    secret("docs-s3", () => {
      const s = get("secret", "docs-documents");
      return {
        "access-key": decode(s, "AWS_ACCESS_KEY_ID"),
        "secret-key": decode(s, "AWS_SECRET_ACCESS_KEY"),
      };
    });
    const resources = [];
    for (const [kind, name] of [
      ["ServiceAccount", "delivery"],
      ["ServiceAccount", "delivery-db"],
      ["ServiceAccount", "test-identity"],
      ["Service", "delivery"],
      ["Service", "delivery-postgres"],
      ["Service", "test-identity"],
      ["Deployment", "delivery"],
      ["Deployment", "test-identity"],
      ["StatefulSet", "delivery-postgres"],
      ["ConfigMap", "delivery-config"],
      ["ConfigMap", "delivery-internal-trust"],
      ["ConfigMap", "delivery-external-ca"],
      ["ConfigMap", "delivery-postgres-config"],
      ["ConfigMap", "delivery-backup-script"],
      ["ConfigMap", "test-identity-db-init"],
      ["CronJob", "delivery-metadata-backup"],
      ["Route", "delivery"],
      ["Route", "test-identity"],
    ])
      resources.push(template(kind, name));
    const config = resources.find(
      (r) => r.kind === "ConfigMap" && r.metadata.name === "docs-config",
    );
    const bucket = get("cm", "docs-documents").data;
    Object.assign(config.data, {
      BRAND_NAME: "Docs signed by Sharkbait",
      SUPPORT_TEXT:
        "Contact your Sharkbait administrator for account access, or your sender for delivery help.",
      APP_ORIGIN: `https://${host}`,
      OIDC_ISSUER: `https://${identityHost}/realms/docs`,
      OIDC_CLIENT_ID: "docs",
      OIDC_ROLE_CLIENT: "docs",
      DATABASE_NAME: "delivery",
      DATABASE_USER: "delivery",
      APP_INTERNAL_HOST: "docs.docs.svc",
      DATABASE_HOST: "docs-postgres.docs.svc",
      S3_ENDPOINT: `https://${bucket.BUCKET_HOST}`,
      S3_BUCKET: bucket.BUCKET_NAME,
      S3_REGION: bucket.BUCKET_REGION || "us-east-1",
      LINK_EMAIL_ENABLED: "false",
      RETRIEVAL_ENABLED: "false",
    });
    for (const r of resources) {
      if (r.kind === "ConfigMap" && r.metadata.name === "docs-internal-trust")
        r.data = { "service-ca.crt": ca };
      if (r.kind === "ConfigMap" && r.metadata.name === "docs-external-ca")
        r.data = { "ca-bundle.pem": externalCa };
      if (r.kind === "Route") r.spec.tls.destinationCACertificate = ca;
      if (r.kind === "Deployment" && r.metadata.name === "docs") {
        r.spec.replicas = 0;
        r.spec.template.spec.containers[0].image = appImage;
      }
      if (r.kind === "StatefulSet") {
        r.spec.template.spec.containers[0].image = postgresImage;
        r.spec.template.spec.containers[0].env.find(
          (e) => e.name === "POSTGRES_DB",
        ).value = "delivery";
        for (const pvc of r.spec.volumeClaimTemplates) {
          pvc.metadata = { name: pvc.metadata.name };
          delete pvc.status;
        }
      }
      const pod =
        r.spec?.template?.spec ?? r.spec?.jobTemplate?.spec?.template?.spec;
      if (pod) pod.imagePullSecrets = [{ name: "docs-registry-push" }];
      if (r.kind === "CronJob") r.spec.suspend = true;
    }
    resources.push({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta("docs-metadata-backups"),
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "ocs-storagecluster-ceph-rbd",
        resources: { requests: { storage: "10Gi" } },
      },
    });
    for (const r of blueprint.filter(
      (r) =>
        r.kind === "NetworkPolicy" &&
        !["delivery-certificate-reload", "router-to-test-registry"].includes(
          r.metadata.name,
        ),
    ))
      resources.push(template("NetworkPolicy", r.metadata.name));
    const reload = tlsResources(appImage);
    reload.find((r) => r.kind === "CronJob").spec.suspend = true;
    resources.push(...reload);
    resources.push({
      apiVersion: "policy/v1",
      kind: "PodDisruptionBudget",
      metadata: meta("docs"),
      spec: { minAvailable: 1, selector: { matchLabels: { app: "docs" } } },
    });
    writeFileSync(
      "evidence/docs/deployment-public.json",
      JSON.stringify(
        { apiVersion: "v1", kind: "List", items: resources },
        null,
        2,
      ) + "\n",
    );
    if (resources.some((r) => r.metadata.name.includes("test")))
      throw Error("Unexpected test resource name");
    oc(
      ["apply", "--dry-run=server", "-f", "-"],
      JSON.stringify({ apiVersion: "v1", kind: "List", items: resources }),
    );
    apply(resources);
    writeFileSync(
      "evidence/docs/images.json",
      JSON.stringify({ appImage, postgresImage }, null, 2) + "\n",
    );
    console.log(
      "Docs configured with dedicated storage, docs realm and sender accounts; retrieval is disabled for preflight. Existing Docs account Secrets are preserved; otherwise passwords come from --accounts-from or are newly generated.",
    );
  } else throw Error("Use bootstrap, registry-route, or configure");
} catch (error) {
  console.error(
    error?.status
      ? "Cluster operation failed; inspect resource conditions."
      : error.message,
  );
  process.exitCode = 1;
}
