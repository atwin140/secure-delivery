import type { Config } from "./config";
export type Mailer = (
  addresses: string[],
  link: string,
  expiresAt: string,
) => Promise<void>;
export function graphMailer(c: Config): Mailer {
  return async (addresses, link, expiresAt) => {
    if (c.emailEnabled === false) throw new Error("Link email is disabled");
    const token = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(c.graphTenant)}/oauth2/v2.0/token`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: c.graphClientId,
          client_secret: c.graphClientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      },
    );
    if (!token.ok) throw new Error("Email provider unavailable");
    const data = (await token.json()) as { access_token?: string };
    if (!data.access_token) throw new Error("Email provider unavailable");
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(c.graphMailbox)}/sendMail`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: `Bearer ${data.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject: "A secure delivery is available",
            body: {
              contentType: "Text",
              content: `A secure delivery is available until ${expiresAt}.\n\n${link}\n\nObtain the portable key bundle and its password from your sender through a separate channel.`,
            },
            bccRecipients: addresses.map((address) => ({
              emailAddress: { address },
            })),
          },
          saveToSentItems: false,
        }),
      },
    );
    if (response.status !== 202)
      throw new Error("Email provider did not accept the request");
  };
}
