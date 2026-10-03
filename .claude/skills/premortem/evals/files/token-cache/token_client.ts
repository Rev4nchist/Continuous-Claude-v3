import { fetch } from "undici";

const TOKEN_URL = "https://auth.partner.example.com/oauth/token";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// The partner token endpoint has hung for minutes in the past. Abort after 5 s
// and retry twice with backoff, so a slow endpoint never blocks a request forever.
const TIMEOUT_MS = 5_000;
const RETRIES = 2;

export async function refreshToken(refresh: string): Promise<TokenPair> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`token endpoint ${res.status}`);
      const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
      return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}
