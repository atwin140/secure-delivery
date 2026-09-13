// Read-only public TLS, deployment and credential-isolation evidence for docs.
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import https from "node:https";
import assert from "node:assert/strict";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
const ns = "docs";
const get = (kind, name, namespace = ns) =>
  JSON.parse(
    execFileSync(
      "oc",
      ["get", kind, ...(name ? [name] : []), "-n", namespace, "-o", "json"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
const certificate = new X509Certificate(
  Buffer.from(get("secret", "docs-public-tls").data["tls.crt"], "base64"),
);
const results = {
  checkedAt: new Date().toISOString(),
  namespace: ns,
  publicTls: [],
  certificates: get("certificates").items.map((c) => ({
    name: c.metadata.name,
    issuer: c.spec.issuerRef.name,
    ready: c.status?.conditions?.some(
      (x) => x.type === "Ready" && x.status === "True",
    ),
    expires: c.status?.notAfter,
    renews: c.status?.renewalTime,
  })),
  workloads: [],
  credentials: {},
};
for (const [hostname, path, status] of [
  ["docs.apps.acm.sharkbait.tech", "/health/ready", 200],
  [
    "identity-docs.apps.acm.sharkbait.tech",
    "/realms/docs/.well-known/openid-configuration",
    200,
  ],
  ["registry-docs.apps.acm.sharkbait.tech", "/v2/", 401],
]) {
  const checked = await new Promise((resolve, reject) => {
    const req = https.get({ hostname, path, rejectUnauthorized: true }, (r) => {
      try {
        const peer = r.socket.getPeerCertificate();
        assert.equal(r.statusCode, status);
        assert.equal(r.socket.authorized, true);
        assert.equal(peer.fingerprint256, certificate.fingerprint256);
        resolve({
          hostname,
          status: r.statusCode,
          verified: true,
          issuer: peer.issuer,
          protocol: r.socket.getProtocol(),
          expires: peer.valid_to,
        });
      } catch (e) {
        reject(e);
      }
      r.resume();
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("HTTPS timeout")));
  });
  results.publicTls.push(checked);
}
assert(results.certificates.every((c) => c.ready));
for (const d of [...get("deployments").items, ...get("statefulsets").items]) {
  assert.equal(d.status.readyReplicas, d.spec.replicas);
  results.workloads.push({
    name: d.metadata.name,
    ready: d.status.readyReplicas,
    desired: d.spec.replicas,
    image: d.spec.template.spec.containers[0].image,
  });
}
const current = get("secret", "docs-sender-accounts"),
  previous = get("secret", "test-sender-accounts", "secure-delivery-test");
results.credentials.senderPasswordsPreserved = ["sender-a", "sender-b"].every(
  (n) => current.data[n] === previous.data[n],
);
assert(results.credentials.senderPasswordsPreserved);
const account = `system:serviceaccount:${ns}:docs-certificate-reload`;
const permission = spawnSync(
  "oc",
  ["auth", "can-i", "get", "secret/docs-database", "-n", ns, "--as=" + account],
  { encoding: "utf8" },
);
assert.equal(permission.status, 1);
results.credentials.reloadCannotReadSecrets = true;
const cfg = get("configmap", "docs-config").data;
assert.equal(cfg.BRAND_NAME, "Docs signed by Sharkbait");
assert.equal(cfg.OIDC_CLIENT_ID, "docs");
assert.equal(
  cfg.OIDC_ISSUER,
  "https://identity-docs.apps.acm.sharkbait.tech/realms/docs",
);
assert.equal(cfg.RETRIEVAL_ENABLED, "true");
results.configuration = {
  brandName: cfg.BRAND_NAME,
  issuer: cfg.OIDC_ISSUER,
  client: cfg.OIDC_CLIENT_ID,
  role: cfg.OIDC_REQUIRED_ROLE,
  emailEnabled: cfg.LINK_EMAIL_ENABLED === "true",
  retrievalEnabled: true,
};
results.runtime = get("pods")
  .items.filter(
    (p) =>
      p.status.phase === "Running" &&
      p.metadata.labels?.["app.kubernetes.io/part-of"] === "docs",
  )
  .map((p) => ({
    name: p.metadata.name,
    scc: p.metadata.annotations?.["openshift.io/scc"],
    ready: p.status.containerStatuses?.every((c) => c.ready),
    containers: p.spec.containers.map((c) => ({
      name: c.name,
      runAsUser: c.securityContext?.runAsUser,
      readOnlyRoot: c.securityContext?.readOnlyRootFilesystem,
      allowPrivilegeEscalation: c.securityContext?.allowPrivilegeEscalation,
    })),
  }));
assert(results.runtime.every((p) => p.scc === "restricted-v2" && p.ready));
results.jobs = get("jobs").items.map((j) => ({
  name: j.metadata.name,
  succeeded: j.status.succeeded === 1,
  started: j.status.startTime,
  finished: j.status.completionTime,
}));
results.builds = get("builds").items.map((b) => ({
  name: b.metadata.name,
  phase: b.status.phase,
  reason: b.status.reason,
  durationSeconds: b.status.duration
    ? Number(b.status.duration) / 1e9
    : undefined,
}));
const live = get(
  "deployments,statefulsets,services,configmaps,routes,cronjobs,issuers,certificates,networkpolicies,roles,rolebindings,serviceaccounts,persistentvolumeclaims",
);
assert(!live.items.some((r) => r.metadata.name.includes("test")));
for (const r of live.items) {
  delete r.status;
  for (const key of [
    "managedFields",
    "resourceVersion",
    "uid",
    "generation",
    "creationTimestamp",
  ])
    delete r.metadata[key];
  if (r.metadata.annotations)
    delete r.metadata.annotations[
      "kubectl.kubernetes.io/last-applied-configuration"
    ];
}
writeFileSync(
  "evidence/docs/live-resources-public.json",
  JSON.stringify(live, null, 2) + "\n",
);
results.status = "passed";
writeFileSync(
  "evidence/docs/deployment-verification.json",
  JSON.stringify(results, null, 2) + "\n",
);
console.log(
  "Docs verified: TLS, ready workloads, namespace naming, docs realm, retained sender passwords, and restricted runtime.",
);
