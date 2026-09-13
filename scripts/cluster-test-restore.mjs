// Destructive only within the explicitly selected synthetic test database.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
const ns = "secure-delivery-test",
  report = JSON.parse(
    readFileSync("evidence/cluster-test/browser-workflow.json"),
  );
if (
  report.status !== "passed" ||
  !report.metadataBackupWhileFinalized ||
  !report.revokedRetrievalDenied
)
  throw Error("Successful synthetic backup/revocation scenario required");
const id = report.restoreCandidateRepositoryId;
if (!/^[a-f0-9]{32}$/.test(id)) throw Error("Invalid synthetic repository ID");
const oc = (args, input) =>
  execFileSync("oc", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
const get = (type, name) =>
  JSON.parse(oc(["get", type, name, "-n", ns, "-o", "json"]));
const c = get("cm", "delivery-config");
if (
  c.data.APP_ORIGIN !==
    "https://delivery-secure-delivery-test.apps.acm.sharkbait.tech" ||
  c.data.LINK_EMAIL_ENABLED !== "false"
)
  throw Error("Not the isolated test environment");
const started = Date.now();
oc([
  "patch",
  "cm",
  "delivery-config",
  "-n",
  ns,
  "--type=merge",
  "-p",
  JSON.stringify({ data: { RETRIEVAL_ENABLED: "false" } }),
]);
oc(["scale", "deploy/delivery", "--replicas=0", "-n", ns]);
for (let n = 0; n < 45; n++) {
  const pods = JSON.parse(
    oc(["get", "pods", "-n", ns, "-l", "app=delivery", "-o", "json"]),
  ).items;
  if (
    !pods.some((p) =>
      p.metadata.ownerReferences?.some((r) => r.kind === "ReplicaSet"),
    )
  )
    break;
  if (n === 44) throw Error("Application replicas did not stop");
  await new Promise((r) => setTimeout(r, 1000));
}
const script = `#!/usr/bin/env bash
set -euo pipefail
umask 077
export PGSSLMODE=verify-full PGSSLROOTCERT=/trust/service-ca.crt PGPASSFILE=/tmp/restore-pgpass
trap 'rm -f /tmp/restore-pgpass' EXIT
printf '%s:5432:delivery:postgres:%s\\n' "$DATABASE_HOST" "$(cat /restore-admin/password)" > "$PGPASSFILE"
printf '%s:5432:delivery:delivery:%s\\n' "$DATABASE_HOST" "$(cat /restore-app/password)" >> "$PGPASSFILE"
chmod 600 "$PGPASSFILE"
shopt -s nullglob
files=(/backups/metadata-*.dump)
test "\${#files[@]}" -gt 0
archive="\${files[\${#files[@]}-1]}"
pg_restore --list "$archive" >/dev/null
# Every caller is stopped. This database contains synthetic delivery test data only.
psql -h "$DATABASE_HOST" -U postgres -d delivery -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION delivery;' >/dev/null 2>&1
pg_restore -h "$DATABASE_HOST" -U delivery -d delivery --exit-on-error --no-owner --no-privileges "$archive" >/dev/null 2>&1
test "$(psql -h "$DATABASE_HOST" -U delivery -d delivery -Atc "SELECT status FROM repositories WHERE id='${id}'")" = finalized
echo 'Restored backup contains the formerly finalized synthetic delivery; all application replicas remain stopped.'
wc -c < "$archive"
`;
oc(
  ["apply", "-f", "-"],
  JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "test-restore-script", namespace: ns },
    data: { "restore.sh": script },
  }),
);
const spec = get("cronjob", "delivery-metadata-backup").spec.jobTemplate.spec
  .template.spec;
spec.volumes.push(
  { name: "restore-script", configMap: { name: "test-restore-script" } },
  {
    name: "restore-admin",
    secret: { secretName: "delivery-postgres-admin", defaultMode: 288 },
  },
  {
    name: "restore-app",
    secret: { secretName: "delivery-database", defaultMode: 288 },
  },
);
const container = spec.containers[0];
container.command = ["/bin/bash", "/test-restore.sh"];
container.volumeMounts.push(
  {
    name: "restore-script",
    mountPath: "/test-restore.sh",
    subPath: "restore.sh",
    readOnly: true,
  },
  { name: "restore-admin", mountPath: "/restore-admin", readOnly: true },
  { name: "restore-app", mountPath: "/restore-app", readOnly: true },
);
const name = "test-restore-" + Date.now().toString(36);
oc(
  ["create", "-f", "-"],
  JSON.stringify({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: ns },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 180,
      template: { metadata: { labels: { app: "delivery-backup" } }, spec },
    },
  }),
);
writeFileSync(
  "evidence/cluster-test/restore-progress.json",
  JSON.stringify(
    {
      startedAt: new Date(started).toISOString(),
      restoreJob: name,
      repositoryId: id,
      applicationReplicas: 0,
      retrievalEnabled: false,
      status: "restoring",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    restoreJob: name,
    applicationReplicas: 0,
    retrievalEnabled: false,
  }),
);
