// Issues certificates for the explicitly authorized synthetic ACM namespace only.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
const ns = "secure-delivery-test";
const meta = (name) => ({
  name,
  namespace: ns,
  labels: { "app.kubernetes.io/part-of": "secure-delivery-test" },
});
const certificate = (name, spec) => ({
  apiVersion: "cert-manager.io/v1",
  kind: "Certificate",
  metadata: meta(name),
  spec,
});
const issuer = (name, spec) => ({
  apiVersion: "cert-manager.io/v1",
  kind: "Issuer",
  metadata: meta(name),
  spec,
});
export const internalTargets = [
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
];
const hosts = ["delivery", "identity", "registry"].map(
  (prefix) => `${prefix}-secure-delivery-test.apps.acm.sharkbait.tech`,
);
const items = [
  issuer("delivery-bootstrap", { selfSigned: {} }),
  certificate("delivery-internal-ca", {
    secretName: "delivery-internal-ca",
    isCA: true,
    commonName: "Secure Delivery ACM Test Internal CA",
    subject: { organizations: ["Secure Delivery Test"] },
    duration: "87600h",
    renewBefore: "8760h",
    privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Never" },
    issuerRef: { name: "delivery-bootstrap", kind: "Issuer" },
  }),
  issuer("delivery-internal", { ca: { secretName: "delivery-internal-ca" } }),
  certificate("delivery-public", {
    secretName: "delivery-public-tls",
    dnsNames: hosts,
    privateKey: { algorithm: "RSA", size: 2048, rotationPolicy: "Always" },
    renewBefore: "360h",
    issuerRef: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
  }),
  ...internalTargets.map((t) =>
    certificate(t.certificate, {
      secretName: t.certificate + "-tls",
      dnsNames: [`${t.name}.${ns}.svc`, `${t.name}.${ns}.svc.cluster.local`],
      duration: "2160h",
      renewBefore: "720h",
      privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Always" },
      usages: ["digital signature", "server auth"],
      issuerRef: { name: "delivery-internal", kind: "Issuer" },
    }),
  ),
];
writeFileSync(
  "evidence/cluster-test/certificates-public.json",
  JSON.stringify({ apiVersion: "v1", kind: "List", items }, null, 2) + "\n",
);
try {
  const result = execFileSync("oc", ["apply", "-f", "-"], {
    input: JSON.stringify({ apiVersion: "v1", kind: "List", items }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  console.log(result.trim());
} catch {
  console.error(
    "Certificate request failed. Inspect Certificate conditions; no provider response is logged.",
  );
  process.exitCode = 1;
}
