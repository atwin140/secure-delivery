// Cert-manager migration for the synthetic ACM deployment. No private keys leave Kubernetes.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { certManagerResources } from "./cert-manager-resources.mjs";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
const ns = "secure-delivery-test";
const run = (args, input) =>
  execFileSync("oc", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
const get = (kind, name) =>
  JSON.parse(run(["get", kind, name, "-n", ns, "-o", "json"]));
const patch = (kind, name, value) =>
  run(
    ["patch", kind, name, "-n", ns, "--type=merge", "--patch-file=/dev/stdin"],
    JSON.stringify(value),
  );
const targets = [
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
const publicHosts = ["delivery", "identity", "registry"].map(
  (p) => `${p}-secure-delivery-test.apps.acm.sharkbait.tech`,
);
const ca = Buffer.from(
  get("secret", "delivery-internal-ca").data["tls.crt"],
  "base64",
).toString();
new X509Certificate(ca);
const stage = process.argv[2];
try {
  if (stage === "prepare") {
    for (const t of [...targets, { certificate: "delivery-public" }]) {
      const c = get("certificate", t.certificate);
      if (
        !c.status?.conditions?.some(
          (x) => x.type === "Ready" && x.status === "True",
        )
      )
        throw Error("Certificate pending: " + t.certificate);
    }
    const previous = get("cm", "delivery-service-ca").data["service-ca.crt"];
    const bundle = previous.includes(ca) ? previous : previous + "\n" + ca;
    // A new ConfigMap avoids queued writes by the old serving-CA controller.
    run(
      ["apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "delivery-internal-trust", namespace: ns },
        data: { "service-ca.crt": bundle },
      }),
    );
    // Keep both trust roots until every backend has moved; retain ODF's distinct service CA separately.
    patch("cm", "delivery-service-ca", {
      metadata: {
        annotations: { "service.beta.openshift.io/inject-cabundle": null },
      },
      data: { "service-ca.crt": bundle },
    });
    const resources = certManagerResources({
      namespace: ns,
      appImage: get("deploy", "delivery").spec.template.spec.containers[0]
        .image,
      publicIssuer: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
      internalIssuer: { name: "delivery-internal", kind: "Issuer" },
      publicHosts,
      apiCidrs: [
        "172.30.0.1/32",
        "10.0.1.141/32",
        "10.0.1.142/32",
        "10.0.1.143/32",
      ],
      targets,
      imagePullSecrets: [{ name: "test-registry-push" }],
    });
    resources.find((r) => r.kind === "CronJob").spec.suspend = true;
    writeFileSync(
      "evidence/cluster-test/cert-manager-resources-public.json",
      JSON.stringify(
        { apiVersion: "v1", kind: "List", items: resources },
        null,
        2,
      ) + "\n",
    );
    run(
      ["apply", "-f", "-"],
      JSON.stringify({ apiVersion: "v1", kind: "List", items: resources }),
    );
    for (const name of ["delivery", "test-identity", "test-registry"])
      patch("route", name, {
        spec: {
          tls: {
            externalCertificate: { name: "delivery-public-tls" },
            certificate: null,
            key: null,
            caCertificate: null,
            destinationCACertificate: bundle,
          },
        },
      });
    console.log(
      "Public Route certificates and transition trust bundle installed.",
    );
  } else if (targets.some((t) => t.name === stage)) {
    const t = targets.find((t) => t.name === stage),
      d = get(t.kind, t.name),
      c = get("certificate", t.certificate);
    const volume = d.spec.template.spec.volumes.find((v) => v.name === "tls");
    if (!volume?.secret) throw Error("TLS volume missing");
    volume.secret.secretName = t.certificate + "-tls";
    for (const v of d.spec.template.spec.volumes)
      if (v.configMap?.name === "delivery-service-ca")
        v.configMap.name = "delivery-internal-trust";
    patch("service", t.name, {
      metadata: {
        annotations: {
          "service.beta.openshift.io/serving-cert-secret-name": null,
        },
      },
    });
    patch(t.kind, t.name, {
      spec: {
        template: {
          metadata: {
            annotations: {
              "delivery.example/certificate-revision":
                c.metadata.uid + "/" + c.status.revision,
            },
          },
          spec: { volumes: d.spec.template.spec.volumes },
        },
      },
    });
    console.log(
      "Switched " + t.name + " to cert-manager. Waiting for readiness.",
    );
    console.log(
      run([
        "rollout",
        "status",
        t.kind + "/" + t.name,
        "-n",
        ns,
        "--timeout=300s",
      ]).trim(),
    );
  } else if (stage === "finish") {
    for (const t of targets) {
      const d = get(t.kind, t.name);
      if (
        d.spec.template.spec.volumes.find((v) => v.name === "tls")?.secret
          ?.secretName !==
        t.certificate + "-tls"
      )
        throw Error("Migration incomplete");
    }
    patch("cm", "delivery-internal-trust", { data: { "service-ca.crt": ca } });
    const backup = get("cronjob", "delivery-metadata-backup");
    for (const v of backup.spec.jobTemplate.spec.template.spec.volumes)
      if (v.configMap?.name === "delivery-service-ca")
        v.configMap.name = "delivery-internal-trust";
    patch("cronjob", "delivery-metadata-backup", {
      spec: {
        jobTemplate: {
          spec: {
            template: {
              spec: {
                volumes: backup.spec.jobTemplate.spec.template.spec.volumes,
              },
            },
          },
        },
      },
    });
    for (const name of ["delivery", "test-identity", "test-registry"])
      patch("route", name, { spec: { tls: { destinationCACertificate: ca } } });
    patch("cronjob", "delivery-certificate-reload", {
      spec: { suspend: false },
    });
    writeFileSync(".local/cluster-test/cert-manager-ca.crt", ca);
    console.log(
      "All application backends now use the private cert-manager CA; automatic leaf renewal reloads enabled.",
    );
  } else
    throw Error(
      "Use prepare, delivery, test-identity, delivery-postgres, test-registry, or finish",
    );
} catch (error) {
  console.error(
    error?.status
      ? "Cluster operation failed; inspect target resource conditions."
      : error.message,
  );
  process.exitCode = 1;
}
