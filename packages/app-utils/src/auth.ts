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

export interface BearerToken {
  accessToken: string;
  /** Epoch ms after which the token must not be used. */
  expiresAt: number;
}

/** Client-credentials exchange that also reports when the token expires. */
export async function fetchBearerToken(config: OAuthConfig): Promise<BearerToken> {
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
  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error(`OAuth response missing access_token`);
  }
  const ttlSeconds = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  return { accessToken: data.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
}

export async function getBearerToken(config: OAuthConfig): Promise<string> {
  return (await fetchBearerToken(config)).accessToken;
}

export interface CachedBearerTokenOptions {
  /** Refetch when less than this much lifetime remains (default 60 000 ms). */
  refreshMarginMs?: number;
}

let tokenCache: Map<string, Promise<BearerToken>> | undefined;

function cacheKey(config: OAuthConfig): string {
  return JSON.stringify([oauthEndpoints(config.baseUrl).tokenUrl, config.clientId, config.clientSecret]);
}

/**
 * `getBearerToken` with a per-process cache keyed by endpoint + credentials.
 * A token is reused until less than `refreshMarginMs` of its lifetime is
 * left, so a page never starts API calls with a token about to expire.
 * Concurrent callers share one in-flight exchange; a failed exchange is not
 * cached. Use it in Node test helpers and scripts that need many API calls.
 */
export async function getCachedBearerToken(
  config: OAuthConfig,
  options: CachedBearerTokenOptions = {},
): Promise<string> {
  const margin = options.refreshMarginMs ?? 60_000;
  tokenCache ??= new Map();
  const key = cacheKey(config);
  const pending = tokenCache.get(key);
  if (pending) {
    try {
      const token = await pending;
      if (token.expiresAt - Date.now() > margin) return token.accessToken;
    } catch {
      /* the failed exchange was evicted below; fall through and retry */
    }
    // Another caller may have refreshed while we awaited.
    const current = tokenCache.get(key);
    if (current && current !== pending) return getCachedBearerToken(config, options);
  }
  const next = fetchBearerToken(config);
  tokenCache.set(key, next);
  next.catch(() => {
    if (tokenCache?.get(key) === next) tokenCache.delete(key);
  });
  return (await next).accessToken;
}

/** Forget every cached token (tests, credential rotation). */
export function clearBearerTokenCache(): void {
  tokenCache?.clear();
}
