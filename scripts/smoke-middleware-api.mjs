const baseUrl = (process.argv[2] || process.env.MIDDLEWARE_API_URL || "").replace(/\/+$/, "");
const adminToken = process.env.MIDDLEWARE_ADMIN_TOKEN || "";

if (!baseUrl) {
  console.error("Usage: node scripts/smoke-middleware-api.mjs <base-url>");
  process.exit(2);
}

async function request(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, init);
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

const health = await request("/health");
assert(health.status === 200 && health.body?.ok === true, "health endpoint", health);

const checklist = await request("/api/checklist?provider=agora");
assert(checklist.status === 200 && checklist.body?.success === true, "Agora checklist endpoint", checklist);

const unauthorized = await request("/api/onboarding/requests", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "agora", locationName: "Smoke Test", posBaseUrl: "example.com:8984" }),
});
assert([401, 503].includes(unauthorized.status), "onboarding request is not public", unauthorized);

const fleetUnauthorized = await request("/api/agora/fleet");
assert([401, 503].includes(fleetUnauthorized.status), "Agora fleet is not public", fleetUnauthorized);

if (adminToken) {
  const create = await request("/api/onboarding/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Middleware-Token": adminToken,
    },
    body: JSON.stringify({
      reviewPacket: {
        provider: "agora",
        locationName: "Smoke Test",
        posBaseUrl: "example.com:8984",
        posApiToken: "must-not-persist",
        winerimApiToken: "must-not-persist-either",
        readyForTechnicalReview: false,
        gateSummary: [{ id: "input", label: "Datos", status: "pass", detail: "OK", technicalDetail: "must-not-persist" }],
        nextRequiredChecklistIds: ["mapped-sale"],
      },
    }),
  });
  const serialized = JSON.stringify(create.body);
  assert(create.status === 201 && create.body?.success === true, "protected onboarding request can be created", create);
  assert(!serialized.includes("must-not-persist"), "protected onboarding response is sanitized", create);

  const fleet = await request("/api/agora/fleet", {
    headers: { "X-Middleware-Token": adminToken },
  });
  assert(fleet.status === 200 && fleet.body?.success === true && Array.isArray(fleet.body?.rows), "protected Agora fleet can be read", fleet);
} else {
  console.log("SKIP: protected create smoke test (MIDDLEWARE_ADMIN_TOKEN not set).");
}
