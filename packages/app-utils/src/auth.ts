/**
 * OAuth helpers for Cribl Cloud API authentication.
 * Used by deploy scripts, provisioning, and test helpers.
 */

export interface OAuthConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export function oauthEndpoints(baseUrl: string) {
  const isStaging = /cribl-staging\.cloud/.test(baseUrl);
  return isStaging
    ? {
        tokenUrl: 'https://login.cribl-staging.cloud/oauth/token',
        audience: 'https://api.cribl-staging.cloud',
      }
    : {
        tokenUrl: 'https://login.cribl.cloud/oauth/token',
        audience: 'https://api.cribl.cloud',
      };
}

export async function getBearerToken(config: OAuthConfig): Promise<string> {
  const { tokenUrl, audience } = oauthEndpoints(config.baseUrl);
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      audience,
    }),
  });
  if (!resp.ok) {
    throw new Error(`OAuth token exchange failed (${resp.status}): ${await resp.text()}`);
  }
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error(`OAuth response missing access_token`);
  }
  return data.access_token;
}
