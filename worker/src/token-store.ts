import { DurableObject } from "cloudflare:workers";

const OAUTH2_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_LIFETIME_MS = 7200 * 1000;

type Stored = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

export class TokenStore extends DurableObject<Env> {
  async getValidToken(): Promise<string> {
    const stored = await this.load();
    if (Date.now() < stored.expiresAt - REFRESH_THRESHOLD_MS) {
      return stored.accessToken;
    }
    return await this.refreshLocked(stored);
  }

  async refresh(): Promise<{ refreshed: boolean; expiresAt: number }> {
    const stored = await this.load();
    if (Date.now() < stored.expiresAt - REFRESH_THRESHOLD_MS) {
      return { refreshed: false, expiresAt: stored.expiresAt };
    }
    await this.refreshLocked(stored);
    const after = await this.ctx.storage.get<Stored>("tokens");
    return { refreshed: true, expiresAt: after?.expiresAt ?? 0 };
  }

  private async load(): Promise<Stored> {
    const stored = await this.ctx.storage.get<Stored>("tokens");
    if (stored) return stored;
    const seeded = await this.seedFromEnv();
    return seeded;
  }

  private async seedFromEnv(): Promise<Stored> {
    const accessToken = this.env.X_OAUTH2_ACCESS_TOKEN;
    const refreshToken = this.env.X_OAUTH2_REFRESH_TOKEN;
    if (!accessToken || !refreshToken) {
      throw new Error(
        "TokenStore is empty and X_OAUTH2_ACCESS_TOKEN / X_OAUTH2_REFRESH_TOKEN secrets are not set.",
      );
    }
    const seeded: Stored = {
      accessToken,
      refreshToken,
      expiresAt: Date.now(),
    };
    await this.ctx.storage.put("tokens", seeded);
    return seeded;
  }

  private async refreshLocked(stored: Stored): Promise<string> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const fresh = await this.ctx.storage.get<Stored>("tokens");
      const current = fresh ?? stored;
      if (Date.now() < current.expiresAt - REFRESH_THRESHOLD_MS) {
        return current.accessToken;
      }
      const next = await this.callRefresh(current.refreshToken);
      await this.ctx.storage.put("tokens", next);
      return next.accessToken;
    });
  }

  private async callRefresh(refreshToken: string): Promise<Stored> {
    const clientId = this.env.X_OAUTH2_CLIENT_ID;
    const clientSecret = this.env.X_OAUTH2_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("X_OAUTH2_CLIENT_ID / X_OAUTH2_CLIENT_SECRET not configured.");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });

    const auth = btoa(`${clientId}:${clientSecret}`);
    const resp = await fetch(OAUTH2_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${auth}`,
      },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "<no body>");
      throw new Error(`Token refresh failed: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as TokenResponse;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    };
  }
}
