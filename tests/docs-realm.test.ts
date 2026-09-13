import { expect, it } from "vitest";

const modulePath = "../scripts/docs-realm.mjs";
const { createDocsRealm } = await import(modulePath);
const input = {
  origin: "https://docs.example.invalid",
  clientSecret: "synthetic-client-secret",
  passwords: {
    "sender-a": "synthetic-sender-a-password",
    "sender-b": "synthetic-sender-b-password",
    "denied-user": "synthetic-denied-password",
  },
};

it("bootstraps a standalone Docs realm with retained supplied credentials and restricted OIDC", () => {
  const realm = createDocsRealm(input);
  const client = realm.clients[0];
  expect(realm.realm).toBe("docs");
  expect(realm.sslRequired).toBe("all");
  expect(realm.registrationAllowed).toBe(false);
  expect(client).toMatchObject({
    clientId: "docs",
    secret: input.clientSecret,
    publicClient: false,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    implicitFlowEnabled: false,
    serviceAccountsEnabled: false,
    fullScopeAllowed: false,
    attributes: { "pkce.code.challenge.method": "S256" },
    defaultClientScopes: ["profile", "basic"],
    redirectUris: ["https://docs.example.invalid/auth/callback"],
    webOrigins: [input.origin],
  });
  expect(client.protocolMappers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        protocolMapper: "oidc-audience-mapper",
        config: {
          "included.client.audience": "docs",
          "access.token.claim": "true",
          "id.token.claim": "false",
        },
      }),
      expect.objectContaining({
        protocolMapper: "oidc-usermodel-client-role-mapper",
        config: expect.objectContaining({
          "usermodel.clientRoleMapping.clientId": "docs",
          "claim.name": "resource_access.docs.roles",
        }),
      }),
    ]),
  );
  expect(realm.clientScopeMappings.docs).toEqual([
    { client: "docs", roles: ["repository-sender"] },
  ]);
  for (const username of ["sender-a", "sender-b", "denied-user"] as const) {
    const user = realm.users.find(
      (u: { username: string }) => u.username === username,
    );
    expect(user.credentials).toEqual([
      { type: "password", value: input.passwords[username], temporary: false },
    ]);
    expect(user.clientRoles).toEqual(
      username === "denied-user" ? {} : { docs: ["repository-sender"] },
    );
  }
});

it("rejects incomplete credentials and non-exact HTTPS origins without echoing credential input", () => {
  for (const origin of [
    "http://docs.example.invalid",
    "https://docs.example.invalid/extra",
    "https://user:pass@docs.example.invalid",
  ]) {
    expect(() => createDocsRealm({ ...input, origin })).toThrow(
      "exact HTTPS origin",
    );
  }
  expect(() => createDocsRealm({ ...input, clientSecret: "" })).toThrow(
    "client credential is required",
  );
  expect(() => createDocsRealm({ ...input, passwords: {} })).toThrow(
    "All Docs account credentials are required",
  );
});
