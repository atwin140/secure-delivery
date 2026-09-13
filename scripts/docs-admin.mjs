import { execFileSync } from "node:child_process";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
const [command] = process.argv.slice(2),
  ns = "docs";
if (
  ![
    "migrate",
    "preflight",
    "cleanup",
    "enable-retrieval",
    "disable-retrieval",
    "restore-invalidate",
  ].includes(command)
)
  throw Error("Unknown Docs administrative action");
const run = (args, input) =>
  execFileSync("oc", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
const d = JSON.parse(
  run(["get", "deployment", "docs", "-n", ns, "-o", "json"]),
);
const spec = d.spec.template.spec;
spec.restartPolicy = "Never";
const c = spec.containers[0];
c.command = ["node", "--import", "tsx", "scripts/admin.ts", command];
delete c.readinessProbe;
delete c.livenessProbe;
delete c.ports;
const name = `docs-${command}-${Date.now().toString(36)}`;
const job = {
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: {
    name,
    namespace: ns,
    labels: { "app.kubernetes.io/part-of": "docs" },
  },
  spec: {
    ttlSecondsAfterFinished: 86400,
    backoffLimit: 0,
    activeDeadlineSeconds: 180,
    template: {
      metadata: { labels: { app: "docs-admin", "admin-command": command } },
      spec,
    },
  },
};
run(["create", "-f", "-"], JSON.stringify(job));
console.log(name);
