import { writeFile } from "node:fs/promises";
const images = {
  node: ["library/node", "24.21.0-bookworm-slim"],
  postgres: ["library/postgres", "18.6-bookworm"],
};
const pins = {};
for (const [name, [repository, tag]] of Object.entries(images)) {
  const auth = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!auth.ok) throw new Error("Registry authorization failed");
  const { token } = await auth.json();
  const r = await fetch(
    `https://registry-1.docker.io/v2/${repository}/manifests/${tag}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!r.ok) throw new Error(`Registry manifest unavailable: ${name}`);
  const digest = r.headers.get("docker-content-digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? ""))
    throw new Error("Registry digest missing");
  pins[name] = `docker.io/${repository}:${tag}@${digest}`;
}
await writeFile("deploy/image-pins.json", JSON.stringify(pins, null, 2) + "\n");
console.log(
  "Pinned official Node and PostgreSQL image manifest digests. Images have not been built or run.",
);
