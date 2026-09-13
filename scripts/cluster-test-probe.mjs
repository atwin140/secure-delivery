import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
const ns = "secure-delivery-test",
  run = (args, input) =>
    execFileSync("oc", args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
run(
  ["apply", "-f", "-"],
  JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "test-probe-script", namespace: ns },
    data: {
      "cluster-test-probe.ts": readFileSync(
        "scripts/cluster-test-probe.ts",
        "utf8",
      ),
    },
  }),
);
const d = JSON.parse(
    run(["get", "deploy", "delivery", "-n", ns, "-o", "json"]),
  ),
  spec = d.spec.template.spec,
  c = spec.containers[0];
spec.restartPolicy = "Never";
delete c.readinessProbe;
delete c.livenessProbe;
delete c.ports;
c.command = ["node", "--import", "tsx", "scripts/cluster-test-probe.ts"];
if (process.argv[2]) {
  if (!/^[a-f0-9]{32}$/.test(process.argv[2]))
    throw Error("Invalid test repository ID");
  c.env = [
    ...(c.env ?? []),
    { name: "TEST_RESTORE_CHECK_ID", value: process.argv[2] },
  ];
}
c.volumeMounts.push({
  name: "probe",
  mountPath: "/app/scripts/cluster-test-probe.ts",
  subPath: "cluster-test-probe.ts",
  readOnly: true,
});
spec.volumes.push({ name: "probe", configMap: { name: "test-probe-script" } });
const name = "test-probe-" + Date.now().toString(36);
run(
  ["create", "-f", "-"],
  JSON.stringify({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: ns },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 240,
      template: { metadata: { labels: { app: "delivery-admin" } }, spec },
    },
  }),
);
console.log(name);
