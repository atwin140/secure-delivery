import { readFileSync } from "node:fs";
import { isIP } from "node:net";
export function certManagerResources({
  namespace,
  appImage,
  publicIssuer,
  internalIssuer,
  publicHosts,
  apiCidrs,
  targets,
  imagePullSecrets = [],
}) {
  const valid = (s) =>
    typeof s === "string" && /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(s);
  if (
    !valid(namespace) ||
    !publicHosts?.every(valid) ||
    !publicHosts.length ||
    !targets?.length
  )
    throw Error("Invalid TLS resource configuration");
  for (const i of [publicIssuer, internalIssuer])
    if (!valid(i?.name) || !["Issuer", "ClusterIssuer"].includes(i.kind))
      throw Error("An explicit cert-manager issuer is required");
  if (
    !apiCidrs?.length ||
    apiCidrs.some((c) => {
      const [ip, bits] = c.split("/");
      return !isIP(ip) || Number(bits) !== (isIP(ip) === 4 ? 32 : 128);
    })
  )
    throw Error("Exact Kubernetes API destination CIDRs required");
  for (const t of targets)
    if (
      !valid(t.name) ||
      !valid(t.certificate) ||
      !["deployments", "statefulsets"].includes(t.kind)
    )
      throw Error("Invalid reload target");
  const meta = (name) => ({ name, namespace });
  const resource = (apiVersion, kind, name, fields) => ({
    apiVersion,
    kind,
    metadata: meta(name),
    ...fields,
  });
  const cert = (name, spec) =>
    resource("cert-manager.io/v1", "Certificate", name, { spec });
  const securityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  return [
    cert("delivery-public", {
      secretName: "delivery-public-tls",
      dnsNames: publicHosts,
      privateKey: { algorithm: "RSA", size: 2048, rotationPolicy: "Always" },
      renewBefore: "360h",
      issuerRef: publicIssuer,
    }),
    ...targets.map((t) =>
      cert(t.certificate, {
        secretName: t.certificate + "-tls",
        dnsNames: [
          `${t.name}.${namespace}.svc`,
          `${t.name}.${namespace}.svc.cluster.local`,
        ],
        duration: "2160h",
        renewBefore: "720h",
        privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Always" },
        usages: ["digital signature", "server auth"],
        issuerRef: internalIssuer,
      }),
    ),
    resource(
      "rbac.authorization.k8s.io/v1",
      "Role",
      "delivery-route-certificate",
      {
        rules: [
          {
            apiGroups: [""],
            resources: ["secrets"],
            resourceNames: ["delivery-public-tls"],
            verbs: ["get", "list", "watch"],
          },
        ],
      },
    ),
    resource(
      "rbac.authorization.k8s.io/v1",
      "RoleBinding",
      "delivery-route-certificate",
      {
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: "delivery-route-certificate",
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: "router",
            namespace: "openshift-ingress",
          },
        ],
      },
    ),
    resource("v1", "ServiceAccount", "delivery-certificate-reload", {
      automountServiceAccountToken: false,
    }),
    resource(
      "rbac.authorization.k8s.io/v1",
      "Role",
      "delivery-certificate-reload",
      {
        rules: [
          {
            apiGroups: ["cert-manager.io"],
            resources: ["certificates"],
            resourceNames: targets.map((t) => t.certificate),
            verbs: ["get"],
          },
          ...["deployments", "statefulsets"]
            .filter((kind) => targets.some((t) => t.kind === kind))
            .map((kind) => ({
              apiGroups: ["apps"],
              resources: [kind],
              resourceNames: targets
                .filter((t) => t.kind === kind)
                .map((t) => t.name),
              verbs: ["get", "patch"],
            })),
        ],
      },
    ),
    resource(
      "rbac.authorization.k8s.io/v1",
      "RoleBinding",
      "delivery-certificate-reload",
      {
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: "delivery-certificate-reload",
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: "delivery-certificate-reload",
            namespace,
          },
        ],
      },
    ),
    resource("v1", "ConfigMap", "delivery-certificate-reload", {
      data: {
        "certificate-reload.mjs": readFileSync(
          "deploy/certificate-reload.mjs",
          "utf8",
        ),
        "targets.json": JSON.stringify(targets),
      },
    }),
    resource(
      "networking.k8s.io/v1",
      "NetworkPolicy",
      "delivery-certificate-reload",
      {
        spec: {
          podSelector: { matchLabels: { app: "delivery-certificate-reload" } },
          policyTypes: ["Ingress", "Egress"],
          ingress: [],
          egress: [
            {
              to: apiCidrs.map((cidr) => ({ ipBlock: { cidr } })),
              ports: [
                { protocol: "TCP", port: 443 },
                { protocol: "TCP", port: 6443 },
              ],
            },
          ],
        },
      },
    ),
    resource("batch/v1", "CronJob", "delivery-certificate-reload", {
      spec: {
        schedule: "*/5 * * * *",
        timeZone: "Etc/UTC",
        concurrencyPolicy: "Forbid",
        startingDeadlineSeconds: 240,
        successfulJobsHistoryLimit: 1,
        failedJobsHistoryLimit: 2,
        jobTemplate: {
          spec: {
            backoffLimit: 1,
            activeDeadlineSeconds: 1500,
            ttlSecondsAfterFinished: 86400,
            template: {
              metadata: { labels: { app: "delivery-certificate-reload" } },
              spec: {
                restartPolicy: "Never",
                serviceAccountName: "delivery-certificate-reload",
                automountServiceAccountToken: true,
                imagePullSecrets,
                securityContext: {
                  runAsNonRoot: true,
                  seccompProfile: { type: "RuntimeDefault" },
                },
                containers: [
                  {
                    name: "reload",
                    image: appImage,
                    command: ["node", "/scripts/certificate-reload.mjs"],
                    securityContext,
                    resources: {
                      requests: { cpu: "25m", memory: "64Mi" },
                      limits: { cpu: "250m", memory: "128Mi" },
                    },
                    volumeMounts: [
                      {
                        name: "scripts",
                        mountPath: "/scripts",
                        readOnly: true,
                      },
                    ],
                  },
                ],
                volumes: [
                  {
                    name: "scripts",
                    configMap: { name: "delivery-certificate-reload" },
                  },
                ],
              },
            },
          },
        },
      },
    }),
  ];
}
