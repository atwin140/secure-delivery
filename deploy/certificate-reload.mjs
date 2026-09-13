// Namespace-scoped renewal bridge. Reads public Certificate status, never TLS Secrets.
import { readFileSync } from "node:fs";
import { request } from "node:https";
const directory = "/var/run/secrets/kubernetes.io/serviceaccount/";
const namespace = readFileSync(directory + "namespace", "utf8").trim();
const targets = JSON.parse(readFileSync("/scripts/targets.json", "utf8"));
const annotation = "delivery.example/certificate-revision";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function api(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "kubernetes.default.svc",
        port: 443,
        path,
        method,
        ca: readFileSync(directory + "ca.crt"),
        rejectUnauthorized: true,
        headers: {
          Authorization:
            "Bearer " + readFileSync(directory + "token", "utf8").trim(),
          ...(body ? { "Content-Type": "application/merge-patch+json" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 4 * 1024 * 1024)
            req.destroy(new Error("API response too large"));
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error("Kubernetes API status " + res.statusCode));
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Invalid Kubernetes API response"));
          }
        });
      },
    );
    req.setTimeout(20000, () =>
      req.destroy(new Error("Kubernetes API timeout")),
    );
    req.on("error", () => reject(new Error("Kubernetes API request failed")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
function healthy(d) {
  const desired = d.spec.replicas ?? 1,
    s = d.status ?? {};
  return (
    s.observedGeneration >= d.metadata.generation &&
    (s.readyReplicas ?? 0) === desired &&
    (s.updatedReplicas ?? 0) === desired &&
    (d.kind === "StatefulSet"
      ? s.currentRevision === s.updateRevision
      : (s.replicas ?? 0) === desired)
  );
}
try {
  for (const t of targets) {
    const certificate = await api(
      `/apis/cert-manager.io/v1/namespaces/${namespace}/certificates/${t.certificate}`,
    );
    if (
      !certificate.status?.conditions?.some(
        (c) =>
          c.type === "Ready" &&
          c.status === "True" &&
          c.observedGeneration === certificate.metadata.generation,
      ) ||
      !certificate.status.revision
    )
      throw Error("Certificate is not ready: " + t.certificate);
    const revision =
      certificate.metadata.uid + "/" + certificate.status.revision;
    const path = `/apis/apps/v1/namespaces/${namespace}/${t.kind}/${t.name}`;
    let workload = await api(path);
    // An intentionally stopped workload must remain stopped.
    if (workload.spec.replicas === 0) {
      console.log(t.name + ": suspended");
      continue;
    }
    const changed =
      workload.spec.template.metadata.annotations?.[annotation] !== revision;
    if (changed) {
      await api(path, "PATCH", {
        spec: {
          template: { metadata: { annotations: { [annotation]: revision } } },
        },
      });
      console.log(
        t.name +
          ": certificate revision " +
          certificate.status.revision +
          " rollout requested",
      );
    }
    const deadline = Date.now() + 300000;
    do {
      workload = await api(path);
      if (healthy(workload)) break;
      if (Date.now() > deadline) throw Error("Rollout timeout: " + t.name);
      await pause(5000);
    } while (true);
    console.log(t.name + ": ready");
  }
} catch (error) {
  // Messages above contain only operation names and status codes, never API response bodies.
  console.error(
    error instanceof Error ? error.message : "Certificate reload failed",
  );
  process.exitCode = 1;
}
