type AccessJwtHeader = Readonly<{ alg?: string; kid?: string }>;
type AccessJwtPayload = Readonly<{
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  iss?: string;
  sub?: string;
}>;

export type AccessIdentity = Readonly<{ principalSha256: string }>;

export type AccessConfig = Readonly<{
  audience: string;
  teamDomain: string;
  maxTokenTtlSeconds: number;
}>;

export type AccessDependencies = Readonly<{
  fetchKeys?: (teamDomain: string) => Promise<JsonWebKey[]>;
  now?: () => number;
}>;

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("ACCESS_TOKEN_MALFORMED");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(value))) as T;
}

function normalizedTeamDomain(value: string): string {
  try {
    const parsed = new URL(/^https:\/\//i.test(value) ? value : `https://${value}`);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) throw new Error("invalid");
    return parsed.origin;
  } catch {
    throw new Error("ACCESS_CONFIG_INVALID");
  }
}

async function defaultFetchKeys(teamDomain: string): Promise<JsonWebKey[]> {
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("ACCESS_CERTS_UNAVAILABLE");
  const body = await response.json() as { keys?: JsonWebKey[] };
  return Array.isArray(body.keys) ? body.keys : [];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyAccessIdentity(
  request: Request,
  config: AccessConfig,
  dependencies: AccessDependencies = {},
): Promise<AccessIdentity> {
  const audience = config.audience.trim();
  const teamDomain = normalizedTeamDomain(config.teamDomain.trim());
  if (!audience || !Number.isInteger(config.maxTokenTtlSeconds) || config.maxTokenTtlSeconds > 3_600) {
    throw new Error("ACCESS_CONFIG_INVALID");
  }
  const token = request.headers.get("CF-Access-Jwt-Assertion")?.trim() ?? "";
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("ACCESS_IDENTITY_REQUIRED");

  const header = decodeJwtPart<AccessJwtHeader>(parts[0]);
  const payload = decodeJwtPart<AccessJwtPayload>(parts[1]);
  const now = Math.floor((dependencies.now?.() ?? Date.now()) / 1_000);
  const audienceMatches = Array.isArray(payload.aud)
    ? payload.aud.includes(audience)
    : payload.aud === audience;
  if (header.alg !== "RS256" || !header.kid) throw new Error("ACCESS_TOKEN_REJECTED");
  if (!audienceMatches || payload.iss !== teamDomain) throw new Error("ACCESS_TOKEN_REJECTED");
  if (
    typeof payload.exp !== "number"
    || typeof payload.iat !== "number"
    || payload.exp <= now
    || payload.iat > now + 30
    || payload.exp - payload.iat > config.maxTokenTtlSeconds
    || (typeof payload.nbf === "number" && payload.nbf > now + 30)
  ) throw new Error("ACCESS_TOKEN_REJECTED");
  const principal = `${String(payload.sub ?? "").trim()}|${String(payload.email ?? "").trim().toLowerCase()}`;
  if (principal === "|") throw new Error("ACCESS_TOKEN_REJECTED");

  const keys = await (dependencies.fetchKeys ?? defaultFetchKeys)(teamDomain);
  const jwk = keys.find((candidate) => (
    (candidate as JsonWebKey & { kid?: string }).kid === header.kid && candidate.kty === "RSA"
  ));
  if (!jwk) throw new Error("ACCESS_TOKEN_REJECTED");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error("ACCESS_TOKEN_REJECTED");
  return { principalSha256: await sha256Hex(principal) };
}
