// Public realm definition; callers supply credentials in memory, never in source.
export const senderNames = ["sender-a", "sender-b", "denied-user"];

export function createDocsRealm({ origin, clientSecret, passwords }) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin)
    throw Error("Docs requires an exact HTTPS origin");
  if (typeof clientSecret !== "string" || !clientSecret.length)
    throw Error("Docs client credential is required");
  for (const name of senderNames)
    if (typeof passwords?.[name] !== "string" || !passwords[name].length)
      throw Error("All Docs account credentials are required");
  return {
    realm: "docs",
    displayName: "Docs signed by Sharkbait",
    enabled: true,
    sslRequired: "all",
    registrationAllowed: false,
    resetPasswordAllowed: false,
    bruteForceProtected: true,
    loginWithEmailAllowed: false,
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 900,
    ssoSessionMaxLifespan: 3600,
    roles: { client: { docs: [{ name: "repository-sender" }] } },
    clients: [
      {
        clientId: "docs",
        name: "Docs signed by Sharkbait",
        enabled: true,
        protocol: "openid-connect",
        publicClient: false,
        secret: clientSecret,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        implicitFlowEnabled: false,
        serviceAccountsEnabled: false,
        fullScopeAllowed: false,
        redirectUris: [`${origin}/auth/callback`],
        webOrigins: [origin],
        attributes: { "pkce.code.challenge.method": "S256" },
        defaultClientScopes: ["profile", "basic"],
        protocolMappers: [
          {
            name: "sender-roles",
            protocol: "openid-connect",
            protocolMapper: "oidc-usermodel-client-role-mapper",
            config: {
              "usermodel.clientRoleMapping.clientId": "docs",
              "claim.name": "resource_access.docs.roles",
              "jsonType.label": "String",
              multivalued: "true",
              "access.token.claim": "true",
              "id.token.claim": "false",
            },
          },
          {
            name: "delivery-audience",
            protocol: "openid-connect",
            protocolMapper: "oidc-audience-mapper",
            config: {
              "included.client.audience": "docs",
              "access.token.claim": "true",
              "id.token.claim": "false",
            },
          },
        ],
      },
    ],
    clientScopeMappings: {
      docs: [{ client: "docs", roles: ["repository-sender"] }],
    },
    users: senderNames.map((username) => ({
      username,
      enabled: true,
      firstName: "Docs",
      lastName: "Sender",
      emailVerified: true,
      email: `${username}@example.invalid`,
      credentials: [
        { type: "password", value: passwords[username], temporary: false },
      ],
      clientRoles:
        username === "denied-user" ? {} : { docs: ["repository-sender"] },
    })),
  };
}
