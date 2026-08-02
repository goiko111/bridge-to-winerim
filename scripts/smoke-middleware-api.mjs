const baseUrl = (process.argv[2] || process.env.MIDDLEWARE_API_URL || "").replace(/\/+$/, "");
const adminToken = process.env.MIDDLEWARE_ADMIN_TOKEN || "";
const accessClientId = process.env.CLOUDFLARE_ACCESS_CLIENT_ID || "";
const accessClientSecret = process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET || "";
const expectedHostname = process.env.MIDDLEWARE_EXPECTED_HOSTNAME || "";
const requestTimeoutMs = Number(process.env.MIDDLEWARE_SMOKE_TIMEOUT_MS || 8000);

if (!baseUrl) {
  console.error("Usage: node scripts/smoke-middleware-api.mjs <base-url>");
  process.exit(2);
}

const parsedBaseUrl = new URL(baseUrl);
assertSafeTarget(parsedBaseUrl);

const accessConfigured = Boolean(accessClientId && accessClientSecret);
let accessCookie = "";
if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
  console.error("FAIL: both Cloudflare Access service-token values are required");
  process.exit(2);
}

function assertSafeTarget(url) {
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    console.error("FAIL: remote smoke target must use HTTPS");
    process.exit(2);
  }
  if (url.hostname.endsWith(".workers.dev")) {
    console.error("FAIL: workers.dev is not an allowed staging surface");
    process.exit(2);
  }
  if (expectedHostname && url.hostname !== expectedHostname) {
    console.error(`FAIL: expected smoke hostname ${expectedHostname}`);
    process.exit(2);
  }
}

function protectedHeaders() {
  const headers = {};
  if (accessConfigured) {
    headers["CF-Access-Client-Id"] = accessClientId;
    headers["CF-Access-Client-Secret"] = accessClientSecret;
    if (accessCookie) headers.Cookie = accessCookie;
  }
  if (adminToken) headers["X-Middleware-Token"] = adminToken;
  return headers;
}

async function request(path, init = {}, { protectedRequest = true } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(protectedRequest ? protectedHeaders() : {}),
        ...(init.headers || {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    return { status: 0, body: { error: "REQUEST_FAILED", detail: String(error) } };
  }
  if (accessConfigured && protectedRequest) {
    const setCookies = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") || ""];
    for (const value of setCookies) {
      const match = value.match(/(?:^|,\s*)CF_Authorization=([^;]+)/i);
      if (match) accessCookie = `CF_Authorization=${match[1]}`;
    }
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function assert(condition, message, detail) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    process.exit(1);
  }
  console.log(`OK: ${message}`);
}

if (accessConfigured) {
  const accessDenied = await request("/health", {}, { protectedRequest: false });
  assert([302, 401, 403].includes(accessDenied.status), "Access blocks unauthenticated traffic", accessDenied);
}

const health = await request("/health");
assert(health.status === 200 && health.body?.ok === true, "health endpoint", health);

const checklist = await request("/api/checklist?provider=agora");
assert(checklist.status === 200 && checklist.body?.success === true, "Agora checklist endpoint", checklist);

const fleetUnauthorized = await request("/api/agora/fleet", {}, { protectedRequest: false });
assert([302, 401, 403, 503].includes(fleetUnauthorized.status), "Agora fleet is not public", fleetUnauthorized);

if (accessConfigured || adminToken) {
  const ready = await request("/ready");
  assert(ready.status === 200 && ready.body?.ok === true && ready.body?.database === "staging", "database readiness", ready);
  const fleet = await request("/api/agora/fleet", {
    method: "GET",
  });
  assert(fleet.status === 200 && fleet.body?.success === true && Array.isArray(fleet.body?.rows), "protected Agora fleet can be read", fleet);
} else {
  console.log("SKIP: protected read-only smoke (Access service token or admin token not set).");
}
