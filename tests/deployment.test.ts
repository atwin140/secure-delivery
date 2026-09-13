import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { parseAllDocuments } from "yaml";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
it("renders OpenShift resources with restricted containers, no RBAC grants, secrets and verified TLS paths", () => {
  const docs = parseAllDocuments(
    execFileSync("oc", ["kustomize", "deploy"], { encoding: "utf8" }),
  ).map((d) => d.toJSON());
  for (const d of docs) {
    const pod =
      d.spec?.template?.spec ?? d.spec?.jobTemplate?.spec?.template?.spec;
    if (!pod) continue;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    expect(pod.securityContext.seccompProfile.type).toBe("RuntimeDefault");
    expect(pod.securityContext.runAsUser).toBeUndefined();
    for (const c of pod.containers) {
      expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
      expect(c.securityContext.capabilities.drop).toContain("ALL");
      expect(c.securityContext.readOnlyRootFilesystem).toBe(true);
      expect(c.resources.requests).toBeTruthy();
      expect(c.resources.limits).toBeTruthy();
    }
  }
  expect(docs.some((d) => /RoleBinding|ClusterRole/.test(d.kind))).toBe(false);
  expect(docs.find((d) => d.kind === "Route").spec.tls.termination).toBe(
    "reencrypt",
  );
  expect(
    docs.find(
      (d) => d.kind === "NetworkPolicy" && d.metadata.name === "default-deny",
    ).spec.policyTypes,
  ).toEqual(["Ingress", "Egress"]);
  expect(docs.find((d) => d.kind === "StatefulSet").spec.replicas).toBe(1);
  expect(docs.find((d) => d.kind === "CronJob").spec.schedule).toBe(
    "0 2 * * *",
  );
  expect(readFileSync("deploy/backup.sh", "utf8")).toContain(
    "PGSSLMODE=verify-full",
  );
});
it("validates all YAML templates and renders a nonsecret synthetic configuration without applying it", async () => {
  const secrets = parseAllDocuments(
    readFileSync("deploy/secrets.example.yaml", "utf8"),
  );
  for (const d of secrets) expect(d.errors).toEqual([]);
  const dir = await mkdtemp(".local/render-");
  try {
    const input = JSON.parse(
      await readFile("deploy/operator.example.json", "utf8"),
    );
    input.appImage = "registry.test/delivery@sha256:" + "a".repeat(64);
    input.postgresImage = "registry.test/postgres@sha256:" + "b".repeat(64);
    input.host = "delivery.test";
    input.blockStorageClass = "synthetic-block";
    input.externalCaFile = process.env.TEST_TLS_CERT;
    input.serviceCaFile = process.env.TEST_TLS_CERT;
    input.externalHttpsCidrs = ["203.0.113.0/24"];
    input.certManager.apiCidrs = ["192.0.2.1/32"];
    for (const key of Object.keys(input.config))
      if (input.config[key].includes("REPLACE"))
        input.config[key] = key.endsWith("ISSUER")
          ? "https://keycloak.test/realms/test"
          : key.endsWith("ENDPOINT")
            ? "https://s3.test"
            : key === "GRAPH_MAILBOX"
              ? "synthetic@example.invalid"
              : "synthetic";
    await writeFile(dir + "/operator.json", JSON.stringify(input));
    execFileSync(process.execPath, [
      "scripts/render.mjs",
      dir + "/operator.json",
      dir + "/rendered.yaml",
    ]);
    const rendered = await readFile(dir + "/rendered.yaml", "utf8");
    expect(rendered).not.toContain("REPLACE_");
    expect(rendered).toContain("destinationCACertificate");
    expect(rendered).toContain("203.0.113.0/24");
    const resources = parseAllDocuments(rendered).map((d) => d.toJSON());
    const reloadRole = resources.find(
      (d) =>
        d.kind === "Role" && d.metadata.name === "delivery-certificate-reload",
    );
    expect(
      reloadRole.rules.some((r: any) => r.resources.includes("secrets")),
    ).toBe(false);
    expect(reloadRole.rules.every((r: any) => r.resourceNames.length > 0)).toBe(
      true,
    );
    const routeRole = resources.find(
      (d) =>
        d.kind === "Role" && d.metadata.name === "delivery-route-certificate",
    );
    expect(routeRole.rules[0].resourceNames).toEqual(["delivery-public-tls"]);
    expect(resources.filter((d) => d.kind === "Certificate")).toHaveLength(3);
    expect(
      resources.find((d) => d.kind === "Route").spec.tls.externalCertificate
        .name,
    ).toBe("delivery-public-tls");
    expect(rendered).not.toContain("serving-cert-secret-name");
    expect(rendered).not.toContain("inject-cabundle");
    const reloadJob = resources.find(
      (d) =>
        d.kind === "CronJob" &&
        d.metadata.name === "delivery-certificate-reload",
    );
    expect(
      reloadJob.spec.jobTemplate.spec.template.spec.containers[0]
        .securityContext.readOnlyRootFilesystem,
    ).toBe(true);
    expect(
      reloadJob.spec.jobTemplate.spec.template.spec.volumes.every(
        (v: any) => !v.secret,
      ),
    ).toBe(true);
    input.config.GRAPH_CLIENT_SECRET = "must-never-render";
    await writeFile(dir + "/operator.json", JSON.stringify(input));
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/render.mjs", dir + "/operator.json", dir + "/rejected.yaml"],
        { stdio: "ignore" },
      ),
    ).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
