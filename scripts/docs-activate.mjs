// Invoke only after successful schema migration and storage preflight in docs.
import { execFileSync } from "node:child_process";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
const ns = "docs";
const oc = (args, input) =>
  execFileSync("oc", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
const get = (kind, name) =>
  JSON.parse(oc(["get", kind, name, "-n", ns, "-o", "json"]));
const patch = (kind, name, value) =>
  oc(
    ["patch", kind, name, "-n", ns, "--type=merge", "--patch-file=/dev/stdin"],
    JSON.stringify(value),
  );
try {
  const jobs = JSON.parse(oc(["get", "jobs", "-n", ns, "-o", "json"])).items;
  for (const command of ["migrate", "preflight"])
    if (
      !jobs.some(
        (j) =>
          j.metadata.name.startsWith("docs-" + command + "-") &&
          j.status.succeeded === 1,
      )
    )
      throw Error("Successful migration and preflight jobs required");
  const enabled = execFileSync(
    process.execPath,
    ["scripts/docs-admin.mjs", "enable-retrieval"],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
  oc([
    "wait",
    "job/" + enabled,
    "-n",
    ns,
    "--for=condition=Complete",
    "--timeout=180s",
  ]);
  patch("cm", "docs-config", { data: { RETRIEVAL_ENABLED: "true" } });
  const c = get("certificate", "docs-app-cert-manager");
  patch("deployment", "docs", {
    spec: {
      replicas: 2,
      template: {
        metadata: {
          annotations: {
            "delivery.example/certificate-revision":
              c.metadata.uid + "/" + c.status.revision,
          },
        },
      },
    },
  });
  console.log("Docs app enabled with two replicas.");
  oc(["rollout", "status", "deployment/docs", "-n", ns, "--timeout=300s"]);
  const name = "docs-certificate-check-" + Date.now().toString(36);
  const job = JSON.parse(
    oc([
      "create",
      "job",
      name,
      "--from=cronjob/docs-certificate-reload",
      "-n",
      ns,
      "--dry-run=client",
      "-o",
      "json",
    ]),
  );
  delete job.metadata.ownerReferences;
  oc(["create", "-f", "-"], JSON.stringify(job));
  console.log("Checking automatic certificate reload: " + name);
  oc([
    "wait",
    "job/" + name,
    "-n",
    ns,
    "--for=condition=Complete",
    "--timeout=600s",
  ]);
  console.log(oc(["logs", "job/" + name, "-n", ns]).trim());
  patch("cronjob", "docs-certificate-reload", { spec: { suspend: false } });
  patch("cronjob", "docs-metadata-backup", { spec: { suspend: false } });
  console.log(
    "Docs ready; certificate renewal pickup and daily metadata backups enabled.",
  );
} catch (error) {
  console.error(
    error?.status
      ? "Activation step failed; inspect the named Job or workload."
      : error.message,
  );
  process.exitCode = 1;
}
