// Explicitly invoked integration-test infrastructure. Never contains credentials.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
if (
  execFileSync(
    "oc",
    [
      "get",
      "certificate",
      "delivery-public",
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
    "This namespace already uses cert-manager. Use cluster-test-cert-migrate.mjs; historical bootstrap must not overwrite its TLS configuration.",
  );
const ns = "secure-delivery-test";
const host = "registry-secure-delivery-test.apps.acm.sharkbait.tech";
const oc = (args, input) =>
  execFileSync("oc", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
const apply = (items) =>
  oc(
    ["apply", "-f", "-"],
    JSON.stringify({ apiVersion: "v1", kind: "List", items }),
  );
const meta = (name) => ({
  name,
  namespace: ns,
  labels: { "app.kubernetes.io/part-of": "secure-delivery-test" },
});
const image = JSON.parse(
  readFileSync("evidence/cluster-test/registry-image.json"),
).image;
const sec = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
};
const exists = (name) => {
  try {
    oc(["get", "secret", name, "-n", ns, "-o", "name"]);
    return true;
  } catch {
    return false;
  }
};
if (!exists("test-registry-auth")) {
  const password = randomBytes(32).toString("base64url");
  const htpasswd = execFileSync(
    "/usr/sbin/htpasswd",
    ["-Bni", "registry-test"],
    {
      input: password + "\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const auth = Buffer.from("registry-test:" + password).toString("base64");
  oc(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta("test-registry-auth"),
      type: "Opaque",
      stringData: { htpasswd, "http-secret": randomBytes(32).toString("hex") },
    }),
  );
  oc(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta("test-registry-push"),
      type: "kubernetes.io/dockerconfigjson",
      stringData: {
        ".dockerconfigjson": JSON.stringify({ auths: { [host]: { auth } } }),
      },
    }),
  );
}
const resources = [
  {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: meta("test-registry"),
    automountServiceAccountToken: false,
  },
  {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      ...meta("delivery-service-ca"),
      annotations: { "service.beta.openshift.io/inject-cabundle": "true" },
    },
  },
  {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: meta("test-registry"),
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "ocs-storagecluster-ceph-rbd",
      resources: { requests: { storage: "10Gi" } },
    },
  },
  {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      ...meta("test-registry"),
      annotations: {
        "service.beta.openshift.io/serving-cert-secret-name":
          "test-registry-tls",
      },
    },
    spec: {
      selector: { app: "test-registry" },
      ports: [{ name: "https", port: 5000, targetPort: 5000 }],
    },
  },
  {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: meta("test-registry"),
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: "test-registry" } },
      template: {
        metadata: { labels: { app: "test-registry" } },
        spec: {
          serviceAccountName: "test-registry",
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "registry",
              image,
              securityContext: sec,
              env: [
                { name: "REGISTRY_HTTP_ADDR", value: ":5000" },
                {
                  name: "REGISTRY_HTTP_TLS_CERTIFICATE",
                  value: "/tls/tls.crt",
                },
                { name: "REGISTRY_HTTP_TLS_KEY", value: "/tls/tls.key" },
                {
                  name: "REGISTRY_HTTP_SECRET",
                  valueFrom: {
                    secretKeyRef: {
                      name: "test-registry-auth",
                      key: "http-secret",
                    },
                  },
                },
                { name: "REGISTRY_AUTH", value: "htpasswd" },
                {
                  name: "REGISTRY_AUTH_HTPASSWD_REALM",
                  value: "Secure Delivery test registry",
                },
                {
                  name: "REGISTRY_AUTH_HTPASSWD_PATH",
                  value: "/auth/htpasswd",
                },
                { name: "REGISTRY_LOG_LEVEL", value: "error" },
                { name: "OTEL_TRACES_EXPORTER", value: "none" },
              ],
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "1", memory: "512Mi" },
              },
              ports: [{ name: "https", containerPort: 5000 }],
              readinessProbe: { tcpSocket: { port: 5000 } },
              volumeMounts: [
                { name: "data", mountPath: "/var/lib/registry" },
                { name: "tls", mountPath: "/tls", readOnly: true },
                { name: "auth", mountPath: "/auth", readOnly: true },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            {
              name: "data",
              persistentVolumeClaim: { claimName: "test-registry" },
            },
            {
              name: "tls",
              secret: { secretName: "test-registry-tls", defaultMode: 288 },
            },
            {
              name: "auth",
              secret: { secretName: "test-registry-auth", defaultMode: 288 },
            },
            { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "32Mi" } },
          ],
        },
      },
    },
  },
  ...parseAllDocuments(readFileSync("deploy/network.yaml", "utf8")).map((d) => {
    const v = d.toJSON();
    v.metadata.namespace = ns;
    return v;
  }),
  {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta("router-to-test-registry"),
    spec: {
      podSelector: { matchLabels: { app: "test-registry" } },
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
          ports: [{ protocol: "TCP", port: 5000 }],
        },
      ],
    },
  },
  // Build workloads need registry/npm HTTPS and the Kubernetes API. App egress stays denied.
  {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta("test-build-egress"),
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
  },
  {
    apiVersion: "objectbucket.io/v1alpha1",
    kind: "ObjectBucketClaim",
    metadata: meta("delivery-documents"),
    spec: {
      generateBucketName: "secure-delivery-test",
      storageClassName: "ocs-storagecluster-ceph-rgw",
    },
  },
];
apply(resources);
let ca = "";
for (let i = 0; i < 30 && !ca; i++) {
  ca =
    JSON.parse(oc(["get", "cm", "delivery-service-ca", "-n", ns, "-o", "json"]))
      .data?.["service-ca.crt"] ?? "";
  if (!ca) await new Promise((r) => setTimeout(r, 1000));
}
if (!ca) throw Error("Service CA injection pending");
const route = {
  apiVersion: "route.openshift.io/v1",
  kind: "Route",
  metadata: meta("test-registry"),
  spec: {
    host,
    to: { kind: "Service", name: "test-registry" },
    port: { targetPort: "https" },
    tls: {
      termination: "reencrypt",
      insecureEdgeTerminationPolicy: "Redirect",
      destinationCACertificate: ca,
    },
  },
};
apply([route]);
const builds = ["delivery", "delivery-postgres"].map((name) => ({
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
          name === "delivery"
            ? "Containerfile"
            : "deploy/Containerfile.postgres",
      },
    },
    output: {
      to: { kind: "DockerImage", name: `${host}/${name}:test` },
      pushSecret: { name: "test-registry-push" },
    },
    resources: {
      requests: { cpu: "500m", memory: "1Gi" },
      limits: { cpu: "4", memory: "4Gi" },
    },
    successfulBuildsHistoryLimit: 2,
    failedBuildsHistoryLimit: 2,
  },
}));
apply(builds);
writeFileSync(
  "evidence/cluster-test/bootstrap-public.json",
  JSON.stringify(
    { apiVersion: "v1", kind: "List", items: [...resources, route, ...builds] },
    null,
    2,
  ) + "\n",
);
writeFileSync(".local/cluster-test/service-ca.crt", ca);
console.log(
  "Created isolated TLS/authenticated test registry, build definitions and dedicated ODF bucket claim. Credential values were not written to local files or output.",
);
