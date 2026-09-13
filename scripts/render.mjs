import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseAllDocuments, stringify } from "yaml";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { certManagerResources } from "./cert-manager-resources.mjs";
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error(
    "Usage: node scripts/render.mjs public-config.json rendered.yaml",
  );
const o = JSON.parse(await readFile(input, "utf8"));
if (
  !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(o.namespace) ||
  o.namespace.length > 63
)
  throw new Error("Invalid namespace");
for (const image of [o.appImage, o.postgresImage])
  if (!/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error(
      "Immutable application and database image digests required",
    );
if (!/^[a-z0-9.-]+$/.test(o.host) || o.host.includes("REPLACE"))
  throw new Error("Valid application hostname required");
if (!o.externalHttpsCidrs?.length)
  throw new Error("Explicit HTTPS egress CIDRs required");
for (const cidr of o.externalHttpsCidrs) {
  const [ip, bits] = cidr.split("/");
  const family = isIP(ip);
  if (
    !family ||
    !/^\d+$/.test(bits) ||
    Number(bits) < 1 ||
    Number(bits) > (family === 4 ? 32 : 128)
  )
    throw new Error("Explicit non-global CIDRs required");
}
const serviceCa = await readFile(o.serviceCaFile, "utf8"),
  externalCa = await readFile(o.externalCaFile, "utf8");
new X509Certificate(serviceCa);
new X509Certificate(externalCa);
const docs = parseAllDocuments(
  execFileSync("oc", ["kustomize", "deploy"], { encoding: "utf8" }),
).map((d) => d.toJSON());
for (const d of docs) {
  if (d.kind === "Namespace") d.metadata.name = o.namespace;
  else d.metadata.namespace = o.namespace;
  if (d.kind === "Deployment")
    d.spec.template.spec.containers[0].image = o.appImage;
  if (d.kind === "StatefulSet") {
    d.spec.template.spec.containers[0].image = o.postgresImage;
    d.spec.volumeClaimTemplates[0].spec.storageClassName = o.blockStorageClass;
  }
  if (d.kind === "PersistentVolumeClaim")
    d.spec.storageClassName = o.blockStorageClass;
  if (d.kind === "ConfigMap" && d.metadata.name === "delivery-config") {
    const allowed = new Set([
      "BRAND_NAME",
      "SUPPORT_TEXT",
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_ROLE_CLIENT",
      "OIDC_REQUIRED_ROLE",
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_BUCKET",
      "S3_STORAGE_CLASS",
      "GRAPH_TENANT_ID",
      "GRAPH_CLIENT_ID",
      "GRAPH_MAILBOX",
      "AUDIT_RETENTION_DAYS",
      "RETRIEVAL_ENABLED",
      "LINK_EMAIL_ENABLED",
    ]);
    for (const key of Object.keys(o.config))
      if (!allowed.has(key) || typeof o.config[key] !== "string")
        throw new Error("Unrecognized public operator setting");
    Object.assign(d.data, o.config, {
      APP_ORIGIN: `https://${o.host}`,
      APP_INTERNAL_HOST: `delivery.${o.namespace}.svc`,
      DATABASE_HOST: `delivery-postgres.${o.namespace}.svc`,
    });
  }
  if (d.kind === "ConfigMap" && d.metadata.name === "delivery-internal-trust")
    d.data["service-ca.crt"] = serviceCa;
  if (d.kind === "ConfigMap" && d.metadata.name === "delivery-external-ca")
    d.data["ca-bundle.pem"] = externalCa;
  if (d.kind === "Route") {
    d.spec.host = o.host;
    d.spec.tls.destinationCACertificate = serviceCa;
  }
}
docs.push({
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: { name: "approved-external-https", namespace: o.namespace },
  spec: {
    podSelector: { matchLabels: { app: "delivery" } },
    policyTypes: ["Egress"],
    egress: [
      {
        to: o.externalHttpsCidrs.map((cidr) => ({ ipBlock: { cidr } })),
        ports: [{ protocol: "TCP", port: 443 }],
      },
    ],
  },
});
if (!o.certManager)
  throw new Error("certManager issuer and API egress configuration required");
docs.push(
  ...certManagerResources({
    namespace: o.namespace,
    appImage: o.appImage,
    publicIssuer: o.certManager.publicIssuer,
    internalIssuer: o.certManager.internalIssuer,
    publicHosts: o.certManager.publicHosts ?? [o.host],
    apiCidrs: o.certManager.apiCidrs,
    imagePullSecrets: o.certManager.imagePullSecrets ?? [],
    targets: o.certManager.targets ?? [
      {
        name: "delivery-postgres",
        kind: "statefulsets",
        certificate: "delivery-postgres-cert-manager",
      },
      {
        name: "delivery",
        kind: "deployments",
        certificate: "delivery-app-cert-manager",
      },
    ],
  }),
);
const rendered = docs.map((d) => stringify(d)).join("---\n");
if (rendered.includes("REPLACE_"))
  throw new Error("Unresolved deployment placeholder");
await writeFile(output, rendered);
console.log(
  "Rendered deployment with immutable images, CA trust and explicit egress. No resources applied.",
);
