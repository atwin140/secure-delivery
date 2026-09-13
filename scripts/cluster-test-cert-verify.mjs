// Redacted certificate metadata and independently verified HTTPS evidence.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import https from "node:https";
import assert from "node:assert/strict";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
const ns = "secure-delivery-test";
const get = (kind, name) =>
  JSON.parse(
    execFileSync(
      "oc",
      ["get", kind, ...(name ? [name] : []), "-n", ns, "-o", "json"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
const expected = new X509Certificate(
  Buffer.from(get("secret", "delivery-public-tls").data["tls.crt"], "base64"),
);
const endpoints = [
  ["delivery", "/health/ready", 200],
  ["identity", "/realms/delivery-test/.well-known/openid-configuration", 200],
  ["registry", "/v2/", 401],
];
const results = {
  checkedAt: new Date().toISOString(),
  namespace: ns,
  certificates: get("certificates").items.map((c) => ({
    name: c.metadata.name,
    issuer: c.spec.issuerRef.name,
    ready: c.status?.conditions?.some(
      (s) => s.type === "Ready" && s.status === "True",
    ),
    revision: c.status?.revision,
    notAfter: c.status?.notAfter,
    renewalTime: c.status?.renewalTime,
  })),
  routes: [],
};
for (const [prefix, path, status] of endpoints) {
  const hostname = `${prefix}-secure-delivery-test.apps.acm.sharkbait.tech`;
  results.routes.push(
    await new Promise((resolve, reject) => {
      const req = https.get(
        { hostname, path, rejectUnauthorized: true },
        (r) => {
          const peer = r.socket.getPeerCertificate();
          try {
            assert.equal(r.statusCode, status);
            assert.equal(peer.fingerprint256, expected.fingerprint256);
            assert.equal(r.socket.authorized, true);
            resolve({
              hostname,
              status: r.statusCode,
              verified: true,
              certificateMatchesSecret: true,
              issuer: peer.issuer,
              validTo: peer.valid_to,
              fingerprint256: peer.fingerprint256,
              protocol: r.socket.getProtocol(),
            });
          } catch (e) {
            reject(e);
          }
          r.resume();
        },
      );
      req.on("error", reject);
      req.setTimeout(15000, () => req.destroy(new Error("HTTPS timeout")));
    }),
  );
}
assert(results.certificates.every((c) => c.ready));
results.workloads = [
  ...get("deployments").items,
  ...get("statefulsets").items,
].map((d) => ({
  name: d.metadata.name,
  desired: d.spec.replicas,
  ready: d.status.readyReplicas ?? 0,
  tlsSecret: d.spec.template.spec.volumes?.find((v) => v.name === "tls")?.secret
    ?.secretName,
  trust: d.spec.template.spec.volumes?.find((v) =>
    ["service-ca", "trust"].includes(v.name),
  )?.configMap?.name,
  certificateRevision:
    d.spec.template.metadata.annotations?.[
      "delivery.example/certificate-revision"
    ],
}));
assert(results.workloads.every((w) => w.desired === w.ready));
const appPods = get("pods").items.filter(
  (p) =>
    p.metadata.labels?.app === "delivery" &&
    p.metadata.ownerReferences?.some((o) => o.kind === "ReplicaSet") &&
    p.status.phase === "Running",
);
results.internalAppTls = [];
const probe = `const fs=require('fs'),https=require('https'),{X509Certificate}=require('crypto');
const expected=new X509Certificate(fs.readFileSync('/tls/tls.crt'));
const ca=fs.readFileSync('/trust/service/service-ca.crt');
const request=(servername,trust)=>new Promise(resolve=>{const req=https.get({hostname:'127.0.0.1',port:8443,servername,ca:trust,rejectUnauthorized:true,path:'/health/ready'},r=>{resolve({status:r.statusCode,fingerprint:r.socket.getPeerCertificate().fingerprint256,authorized:r.socket.authorized});r.resume()});req.on('error',e=>resolve({error:e.code}));req.setTimeout(5000,()=>req.destroy());});
(async()=>{const good=await request(process.env.APP_INTERNAL_HOST,ca),badHost=await request('wrong-host.invalid',ca),badCa=await request(process.env.APP_INTERNAL_HOST,fs.readFileSync('/trust/external/ca-bundle.pem'));
const result={verified:good.status===200&&good.authorized&&good.fingerprint===expected.fingerprint256,fingerprint:good.fingerprint,badHostnameRejected:badHost.error==='ERR_TLS_CERT_ALTNAME_INVALID',badCaRejected:!!badCa.error,caCertificates:(ca.toString().match(/BEGIN CERTIFICATE/g)||[]).length};console.log(JSON.stringify(result));if(!result.verified||!result.badHostnameRejected||!result.badCaRejected)process.exitCode=1;})();`;
for (const p of appPods) {
  const value = JSON.parse(
    execFileSync(
      "oc",
      ["exec", p.metadata.name, "-n", ns, "--", "node", "-e", probe],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  results.internalAppTls.push({ pod: p.metadata.name, ...value });
}
const renewal = get("job", "test-certificate-renewal");
results.renewal = {
  succeeded: renewal.status.succeeded === 1,
  started: renewal.status.startTime,
  finished: renewal.status.completionTime,
  log: execFileSync("oc", ["logs", "job/test-certificate-renewal", "-n", ns], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  })
    .trim()
    .split("\n"),
};
assert(results.renewal.succeeded);
assert.equal(results.internalAppTls.length, 2);
writeFileSync(
  "evidence/cluster-test/cert-manager-verification.json",
  JSON.stringify(results, null, 2) + "\n",
);
console.log(
  "Both app replicas serve the renewed certificate, and reject a wrong CA and hostname.",
);
