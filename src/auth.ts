// OAuth2 token fetch + refresh for Keka's PSA/HRIS APIs.
//
// Token endpoint reference: https://developers.keka.com/reference/token-1
// Refresh endpoint reference: https://developers.keka.com/reference/refresh-token-generate-access-token-using-refresh-token-endpoint
//
// Keka's API-key exchange (grant_type=kekaapi) does not currently return a
// refresh_token for this integration (confirmed with the user up front), so
// in practice getValidToken() re-runs the full API-key exchange whenever the
// cached token expires. The refresh_token path below exists so this starts
// using it automatically the moment Keka does start issuing one, without any
// code changes.

export interface KekaConfig {
  clientId: string;
  clientSecret: string;
  apiKey: string;
  /** Base URL for PSA/HRIS data calls, e.g. https://yourcompany.keka.com (no trailing slash). */
  baseUrl: string;
  /** OAuth token endpoint, e.g. https://login.keka.com/connect/token - a different host from baseUrl. */
  tokenUrl: string;
}

const REQUIRED_ENV_VARS = [
  "KEKA_CLIENT_ID",
  "KEKA_CLIENT_SECRET",
  "KEKA_API_KEY",
  "KEKA_BASE_URL",
  "KEKA_TOKEN_URL",
] as const;

/**
 * Reads and validates the env vars this server needs. Throws on any missing
 * value - this is the one class of error that's allowed to be fatal at
 * startup, per spec.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KekaConfig {
  const missing = REQUIRED_ENV_VARS.filter((key) => !env[key] || env[key]!.trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill in real values.`
    );
  }
  return {
    clientId: env.KEKA_CLIENT_ID!,
    clientSecret: env.KEKA_CLIENT_SECRET!,
    apiKey: env.KEKA_API_KEY!,
    baseUrl: env.KEKA_BASE_URL!.replace(/\/+$/, ""),
    tokenUrl: env.KEKA_TOKEN_URL!,
  };
}

interface KekaTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
  refreshToken?: string;
}

/** Refresh this long before actual expiry, so in-flight tool calls don't race a token that just expired. */
const REFRESH_SKEW_MS = 60_000;

export class TokenManager {
  private cache: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly config: KekaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Returns a currently-valid access token, fetching or refreshing one if
   * needed. Safe to call from every tool handler before each request.
   */
  async getValidToken(): Promise<string> {
    if (this.cache && this.now() < this.cache.expiresAtMs - REFRESH_SKEW_MS) {
      return this.cache.accessToken;
    }
    // Coalesce concurrent callers into a single outstanding token request.
    if (!this.inFlight) {
      this.inFlight = this.refreshOrFetch().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async refreshOrFetch(): Promise<string> {
    if (this.cache?.refreshToken) {
      try {
        return await this.doRefresh(this.cache.refreshToken);
      } catch (err) {
        console.error(
          `[auth] refresh_token exchange failed, falling back to API-key exchange: ${(err as Error).message}`
        );
      }
    }
    return this.doApiKeyExchange();
  }

  private async doApiKeyExchange(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "kekaapi",
      scope: "kekaapi",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      api_key: this.config.apiKey,
    });
    return this.postToken(body);
  }

  private async doRefresh(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
    });
    // Keep reusing the same refresh_token if the refresh response doesn't
    // reissue a new one.
    return this.postToken(body, refreshToken);
  }

  private async postToken(body: URLSearchParams, fallbackRefreshToken?: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "keka-mcp/0.1.0",
        },
        body: body.toString(),
      });
    } catch (err) {
      throw new Error(`Network error calling Keka token endpoint (${this.config.tokenUrl}): ${(err as Error).message}`);
    }

    const text = await res.text();
    let json: KekaTokenResponse | undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok || !json?.access_token) {
      const detail = json?.error_description || json?.error || text || res.statusText;
      throw new Error(`Keka token request failed (HTTP ${res.status}): ${detail}`);
    }

    this.cache = {
      accessToken: json.access_token,
      expiresAtMs: this.now() + json.expires_in * 1000,
      refreshToken: json.refresh_token ?? fallbackRefreshToken,
    };
    console.error(
      `[auth] obtained access token, expires in ${json.expires_in}s` +
        (this.cache.refreshToken ? " (refresh_token cached)" : " (no refresh_token; will re-run API-key exchange on expiry)")
    );
    return this.cache.accessToken;
  }
}
