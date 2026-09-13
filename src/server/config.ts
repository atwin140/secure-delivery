import { readFileSync } from "node:fs";
export type Config = {
  origin: string;
  brandName: string;
  supportText: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  roleClient: string;
  role: string;
  databaseUrl: string;
  databaseCa: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  graphTenant: string;
  graphClientId: string;
  graphClientSecret: string;
  graphMailbox: string;
  emailEnabled?: boolean;
  auditDays: number;
  tlsCert: string;
  tlsKey: string;
  retrievalEnabled: boolean;
  development?: boolean;
};
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("Disabling TLS verification is not permitted");
  }
  const get = (name: string) => {
    const v = env[name];
    if (
      !v ||
      /REPLACE|CHANGEME|example\.(com|invalid)|development-only/i.test(v)
    )
      throw new Error(`Required production setting: ${name}`);
    return v;
  };
  const secret = (name: string) => {
    const value = readFileSync(get(name), "utf8").trim();
    if (!value || /REPLACE|CHANGEME|development-only/i.test(value))
      throw new Error("Missing production credential");
    return value;
  };
  const https = (name: string) => {
    const v = get(name),
      u = new URL(v);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new Error(`HTTPS setting required: ${name}`);
    return v.replace(/\/$/, "");
  };
  const origin = https("APP_ORIGIN");
  const emailSetting = env.LINK_EMAIL_ENABLED ?? "true";
  if (!["true", "false"].includes(emailSetting))
    throw new Error("Invalid link-email switch");
  const emailEnabled = emailSetting === "true";
  if (new URL(origin).pathname !== "/")
    throw new Error("APP_ORIGIN must be an origin");
  const auditDays = Number(env.AUDIT_RETENTION_DAYS ?? 90);
  if (!Number.isInteger(auditDays) || auditDays < 1 || auditDays > 3650)
    throw new Error("Invalid audit retention");
  if (!["true", "false"].includes(get("RETRIEVAL_ENABLED")))
    throw new Error("Explicit retrieval switch required");
  const databaseHost = get("DATABASE_HOST");
  if (!/^[a-zA-Z0-9.-]+$/.test(databaseHost))
    throw new Error("Invalid database hostname");
  const databaseUrl = `postgresql://${encodeURIComponent(get("DATABASE_USER"))}:${encodeURIComponent(secret("DATABASE_PASSWORD_FILE"))}@${databaseHost}:5432/${encodeURIComponent(get("DATABASE_NAME"))}`;
  return {
    origin,
    brandName: env.BRAND_NAME ?? "Secure Delivery",
    supportText: env.SUPPORT_TEXT ?? "Contact your sender for access help.",
    issuer: https("OIDC_ISSUER"),
    clientId: get("OIDC_CLIENT_ID"),
    clientSecret: secret("OIDC_CLIENT_SECRET_FILE"),
    roleClient: get("OIDC_ROLE_CLIENT"),
    role: env.OIDC_REQUIRED_ROLE ?? "repository-sender",
    databaseUrl,
    databaseCa: readFileSync(get("DATABASE_CA_FILE"), "utf8"),
    s3Endpoint: https("S3_ENDPOINT"),
    s3Region: get("S3_REGION"),
    s3Bucket: get("S3_BUCKET"),
    s3AccessKey: secret("S3_ACCESS_KEY_FILE"),
    s3SecretKey: secret("S3_SECRET_KEY_FILE"),
    emailEnabled,
    graphTenant: emailEnabled ? get("GRAPH_TENANT_ID") : "",
    graphClientId: emailEnabled ? get("GRAPH_CLIENT_ID") : "",
    graphClientSecret: emailEnabled ? secret("GRAPH_CLIENT_SECRET_FILE") : "",
    graphMailbox: emailEnabled ? get("GRAPH_MAILBOX") : "",
    auditDays,
    tlsCert: readFileSync(get("TLS_CERT_FILE"), "utf8"),
    tlsKey: readFileSync(get("TLS_KEY_FILE"), "utf8"),
    retrievalEnabled: env.RETRIEVAL_ENABLED === "true",
  };
}
