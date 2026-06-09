/**
 * Cloudflare Access JWT verification — defense in depth.
 *
 * The Worker sits behind a Cloudflare Access application, which injects a
 * signed `Cf-Access-Jwt-Assertion` header on every allowed request. Relying on
 * the edge alone is fragile: a misconfigured route, a removed Access policy, or
 * a request that reaches the origin by another path would expose the MCP
 * endpoint — and with it full read/write access to the X account.
 *
 * This module re-verifies that JWT inside the Worker. It is gated on config:
 * when CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are set, every /mcp request must
 * carry a valid, unexpired token whose `aud` matches and whose issuer is the
 * configured Access team. When unset (e.g. local `wrangler dev`), verification
 * is skipped. PRODUCTION MUST SET BOTH.
 */

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

interface JwksResponse {
  keys: Jwk[];
}

interface AccessClaims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  email?: string;
  sub?: string;
}

export interface AccessResult {
  ok: boolean;
  /** True when verification was skipped because it isn't configured. */
  skipped?: boolean;
  status?: number;
  reason?: string;
  /** Identity (email or service-token sub) for logging, when verified. */
  subject?: string;
}

// Module-global JWKS cache. Worker isolates are reused across requests, so this
// avoids re-fetching certs on every call. Cloudflare rotates keys infrequently.
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
let jwksCache: { keys: Map<string, CryptoKey>; fetchedAt: number; issuer: string } | null = null;

function issuerFor(teamDomain: string): string {
  // Accept "team", "team.cloudflareaccess.com", or a full URL.
  let host = teamDomain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host.includes(".")) host = `${host}.cloudflareaccess.com`;
  return `https://${host}`;
}

export function accessConfigured(env: Env): boolean {
  return Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
}

export async function verifyAccess(request: Request, env: Env): Promise<AccessResult> {
  if (!accessConfigured(env)) {
    return { ok: true, skipped: true };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return { ok: false, status: 403, reason: "missing Cf-Access-Jwt-Assertion header" };
  }

  const issuer = issuerFor(env.CF_ACCESS_TEAM_DOMAIN!);

  let claims: AccessClaims;
  try {
    claims = await verifyJwt(token, issuer);
  } catch (err) {
    return {
      ok: false,
      status: 403,
      reason: err instanceof Error ? err.message : "invalid token",
    };
  }

  // Audience check — the AUD tag is unique to this specific Access application.
  const aud = claims.aud;
  const audMatch = Array.isArray(aud)
    ? aud.includes(env.CF_ACCESS_AUD!)
    : aud === env.CF_ACCESS_AUD;
  if (!audMatch) {
    return { ok: false, status: 403, reason: "audience mismatch" };
  }

  if (claims.iss !== issuer) {
    return { ok: false, status: 403, reason: "issuer mismatch" };
  }

  return { ok: true, subject: claims.email ?? claims.sub };
}

async function verifyJwt(token: string, issuer: string): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(decodeUtf8(base64UrlToBytes(headerB64))) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== "RS256") throw new Error(`unsupported alg: ${header.alg}`);
  if (!header.kid) throw new Error("missing kid");

  const key = await getKey(header.kid, issuer);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBytes(signatureB64);

  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature,
    data,
  );
  if (!valid) throw new Error("signature verification failed");

  const claims = JSON.parse(decodeUtf8(base64UrlToBytes(payloadB64))) as AccessClaims;

  const now = Math.floor(Date.now() / 1000);
  const skew = 60; // allow 60s clock skew
  if (typeof claims.exp === "number" && now > claims.exp + skew) {
    throw new Error("token expired");
  }
  if (typeof claims.nbf === "number" && now + skew < claims.nbf) {
    throw new Error("token not yet valid");
  }

  return claims;
}

async function getKey(kid: string, issuer: string): Promise<CryptoKey> {
  const fresh =
    jwksCache &&
    jwksCache.issuer === issuer &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;

  if (fresh && jwksCache!.keys.has(kid)) {
    return jwksCache!.keys.get(kid)!;
  }

  // Cache miss or unknown kid (possible key rotation) — refetch.
  const keys = await fetchJwks(issuer);
  jwksCache = { keys, fetchedAt: Date.now(), issuer };
  const key = keys.get(kid);
  if (!key) throw new Error(`unknown signing key: ${kid}`);
  return key;
}

async function fetchJwks(issuer: string): Promise<Map<string, CryptoKey>> {
  const resp = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`failed to fetch Access certs: HTTP ${resp.status}`);
  }
  const { keys } = (await resp.json()) as JwksResponse;
  const map = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    map.set(jwk.kid, key);
  }
  return map;
}

function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
