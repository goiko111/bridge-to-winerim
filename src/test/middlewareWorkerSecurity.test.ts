import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import worker, { verifyAccessJwt } from "../../cloudflare/workers/middleware-api/src/index";

const localEnv = {
  ENVIRONMENT: "test",
  RELEASE: "test",
  ALLOWED_ORIGIN: "https://staging.middleware.winerim.wine",
  MIDDLEWARE_ADMIN_TOKEN: "admin-test-token",
  POS_TEST_ALLOWED_HOSTS: "pos.example.test",
};

function base64Url(value: ArrayBuffer | Record<string, unknown>): string {
  const isArrayBuffer = value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]";
  return Buffer.from(isArrayBuffer ? value as ArrayBuffer : JSON.stringify(value)).toString("base64url");
}

async function accessJwt() {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  Object.assign(publicJwk, { kid: "security-test-key", alg: "RS256", use: "sig" });
  const header = base64Url({ alg: "RS256", kid: "security-test-key" });
  const payload = base64Url({
    aud: "security-test-audience",
    iss: "https://security-test.cloudflareaccess.com",
    email: "ops@winerim.com",
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return { token: `${signingInput}.${base64Url(signature)}`, publicJwk };
}

describe("middleware Worker security gates", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires Access and disables workers.dev in staging and production", () => {
    const config = readFileSync(resolve(import.meta.dirname, "../../wrangler.middleware.toml"), "utf8");
    const staging = config.slice(config.indexOf("[env.staging]"), config.indexOf("[env.production]"));
    const production = config.slice(config.indexOf("[env.production]"));
    for (const section of [staging, production]) {
      expect(section).toContain("workers_dev = false");
      expect(section).toContain('REQUIRE_ACCESS_JWT = "true"');
      expect(section).toContain('POS_TEST_ALLOWED_HOSTS = ""');
    }
    expect(staging).toContain('{ pattern = "api-staging.middleware.winerim.wine", custom_domain = true }');
    expect(staging).toContain('CF_ACCESS_AUD = "73274f22dd76b3448149994f075d6de604c14d91c0568d6f9d280cd812babc2b"');
    expect(staging).toContain('CF_ACCESS_TEAM_DOMAIN = "https://still-credit-1c67.cloudflareaccess.com"');
  });

  it("keeps health public but protects onboarding tests", async () => {
    const health = await worker.fetch(new Request("https://api.example.test/health"), localEnv);
    expect(health.status).toBe(200);
    expect(health.headers.get("Access-Control-Allow-Credentials")).toBe("true");

    const protectedResponse = await worker.fetch(new Request("https://api.example.test/api/onboarding/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }), localEnv);
    expect(protectedResponse.status).toBe(401);
    await expect(protectedResponse.json()).resolves.toMatchObject({ error: "UNAUTHORIZED" });
  });

  it("requires both Access identity and an application token for service automation", async () => {
    const serviceEnv = { ...localEnv, REQUIRE_ACCESS_JWT: "true" };
    const denied = await worker.fetch(new Request("https://api.example.test/api/onboarding/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }), serviceEnv);
    expect(denied.status).toBe(401);

    const allowed = await worker.fetch(new Request("https://api.example.test/api/onboarding/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Middleware-Token": localEnv.MIDDLEWARE_ADMIN_TOKEN,
      },
      body: "{}",
    }), serviceEnv);
    expect(allowed.status).toBe(401);
    await expect(allowed.json()).resolves.toMatchObject({ error: "ACCESS_IDENTITY_REQUIRED" });
  });

  it("rejects a private POS destination before making an outbound request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(new Request("https://api.example.test/api/onboarding/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-test-token",
      },
      body: JSON.stringify({
        provider: "agora",
        locationName: "Private target",
        posBaseUrl: "http://192.168.1.2:8984",
        posApiToken: "pos-token",
        winerimApiToken: "winerim-token",
      }),
    }), { ...localEnv, POS_TEST_ALLOWED_HOSTS: "192.168.1.2" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "PRIVATE_DESTINATION" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized onboarding payloads before external I/O", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(new Request("https://api.example.test/api/onboarding/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-test-token",
      },
      body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    }), localEnv);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "PAYLOAD_TOO_LARGE" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks redirects while testing an allowlisted POS", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new TypeError("redirect mode is set to error"));
    const response = await worker.fetch(new Request("https://api.example.test/api/onboarding/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-test-token",
      },
      body: JSON.stringify({
        provider: "agora",
        locationName: "Redirect target",
        posBaseUrl: "https://pos.example.test",
        posApiToken: "pos-token",
        winerimApiToken: "winerim-token",
      }),
    }), localEnv);

    expect(response.status).toBe(200);
    const body = await response.json() as { gates: Array<{ id: string; status: string }> };
    expect(body.gates.find((item) => item.id === "pos")?.status).toBe("fail");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ redirect: "error" }));
    }
  });

  it("validates a signed Cloudflare Access JWT before entering a private route", async () => {
    const access = await accessJwt();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ keys: [access.publicJwk] }),
      { status: 200 },
    ));
    const request = new Request("https://api.example.test/api/onboarding/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Access-Jwt-Assertion": access.token,
        "X-Middleware-Token": localEnv.MIDDLEWARE_ADMIN_TOKEN,
      },
      body: "{}",
    });
    const accessEnv = {
      ...localEnv,
      REQUIRE_ACCESS_JWT: "true",
      CF_ACCESS_AUD: "security-test-audience",
      CF_ACCESS_TEAM_DOMAIN: "https://security-test.cloudflareaccess.com",
    };
    await expect(verifyAccessJwt(request.clone(), accessEnv)).resolves.toEqual({ valid: true });
    const response = await worker.fetch(request, accessEnv);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "VALIDATION_FAILED" });
    const cookieRequest = new Request("https://api.example.test/api/onboarding/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `CF_Authorization=${access.token}`,
        "X-Middleware-Token": localEnv.MIDDLEWARE_ADMIN_TOKEN,
      },
      body: "{}",
    });
    await expect(verifyAccessJwt(cookieRequest.clone(), accessEnv)).resolves.toEqual({ valid: true });
    const cookieResponse = await worker.fetch(cookieRequest, accessEnv);
    expect(cookieResponse.status).toBe(400);
    await expect(cookieResponse.json()).resolves.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://security-test.cloudflareaccess.com/cdn-cgi/access/certs",
      expect.objectContaining({ redirect: "error" }),
    );
  });
});
