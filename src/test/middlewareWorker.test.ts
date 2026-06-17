import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../cloudflare/workers/middleware-api/src/index";

const env = {
  ENVIRONMENT: "test",
  RELEASE: "test",
  ALLOWED_ORIGIN: "https://staging.middleware.winerim.wine",
};

function base64Url(value: ArrayBuffer | Record<string, unknown>): string {
  const isArrayBuffer = value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]";
  const buffer = isArrayBuffer
    ? Buffer.from(value)
    : Buffer.from(JSON.stringify(value));
  return buffer.toString("base64url");
}

async function createAccessJwt(options: {
  aud: string | string[];
  email: string;
  exp?: number;
  kid?: string;
}) {
  const kid = options.kid || "test-key";
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const header = base64Url({ alg: "RS256", kid, typ: "JWT" });
  const payload = base64Url({
    aud: options.aud,
    email: options.email,
    exp: options.exp || Math.floor(Date.now() / 1000) + 3600,
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return {
    token: `${signingInput}.${base64Url(signature)}`,
    publicJwk,
  };
}

async function jsonOf(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("Cloudflare middleware worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("responds to health checks with CORS headers", async () => {
    const response = await worker.fetch(new Request("https://api.example.test/health"), env);
    const body = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(env.ALLOWED_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(body).toMatchObject({
      ok: true,
      service: "winerim-middleware-api",
      environment: "test",
      release: "test",
    });
  });

  it("supports Access-friendly preflight with the requesting allowed origin", async () => {
    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/requests/11111111-1111-1111-1111-111111111111", {
        method: "OPTIONS",
        headers: {
          Origin: "https://preview.middleware.winerim.wine",
          "Access-Control-Request-Method": "PATCH",
        },
      }),
      {
        ...env,
        ALLOWED_ORIGINS: "https://staging.middleware.winerim.wine, https://preview.middleware.winerim.wine",
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://preview.middleware.winerim.wine");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("CF-Access-Client-Id");
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("does not reflect unconfigured browser origins", async () => {
    const response = await worker.fetch(
      new Request("https://api.example.test/health", {
        headers: { Origin: "https://untrusted.example.test" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(env.ALLOWED_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Origin")).not.toBe("https://untrusted.example.test");
  });

  it("rejects incomplete onboarding payloads without external calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "revo", locationName: "Demo REVO" }),
      }),
      env,
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(body)).toContain("revoTenant");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tests REVO with official headers and does not echo secrets", async () => {
    const secrets = {
      accessToken: "secret-access-token",
      clientToken: "secret-client-token",
      winerimToken: "secret-winerim-token",
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url.includes("app.winerim.com/api/v2/wines")) {
        expect(headers.get("WINERIM-API-TOKEN")).toBe(secrets.winerimToken);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }

      if (url === "https://revoxef.works/api/external/v2/paymentMethods") {
        expect(headers.get("Authorization")).toBe(`Bearer ${secrets.accessToken}`);
        expect(headers.get("tenant")).toBe("tenant-demo");
        expect(headers.get("client-token")).toBe(secrets.clientToken);
        return new Response(JSON.stringify([]), { status: 200 });
      }

      return new Response("unexpected url", { status: 500 });
    });

    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "revo",
          locationName: "Demo REVO",
          posApiToken: secrets.accessToken,
          revoTenant: "tenant-demo",
          revoClientToken: secrets.clientToken,
          winerimApiToken: secrets.winerimToken,
        }),
      }),
      env,
    );
    const body = await jsonOf(response);
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.readyForTechnicalReview).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(serialized).not.toContain(secrets.accessToken);
    expect(serialized).not.toContain(secrets.clientToken);
    expect(serialized).not.toContain(secrets.winerimToken);
  });

  it("keeps onboarding request storage disabled by default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ success: false, error: "REQUEST_STORAGE_DISABLED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires a Cloudflare Access identity before storing onboarding requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      {
        ...env,
        ONBOARDING_REQUESTS_ENABLED: "true",
      },
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ success: false, error: "ACCESS_IDENTITY_REQUIRED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stores only sanitized onboarding request metadata when enabled", async () => {
    const secrets = {
      posToken: "secret-pos-token",
      winerimToken: "secret-winerim-token",
      serviceKey: "secret-service-role",
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://lovable.example/rest/v1/onboarding_requests");
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBe(secrets.serviceKey);
      expect(headers.get("Authorization")).toBe(`Bearer ${secrets.serviceKey}`);

      const row = JSON.parse(String(init?.body));
      const serializedRow = JSON.stringify(row);
      expect(row).toMatchObject({
        provider: "agora",
        location_name: "Casa Demo",
        pos_base_url: "http://demo.example.test:8984",
        status: "READY_FOR_TECHNICAL_REVIEW",
        requested_by_email: "ops@winerim.com",
        ready_for_technical_review: true,
      });
      expect(row.normalized_input).toMatchObject({
        posAuthProvided: true,
        winerimAuthProvided: true,
      });
      expect(serializedRow).not.toContain(secrets.posToken);
      expect(serializedRow).not.toContain(secrets.winerimToken);

      return new Response(JSON.stringify([{ id: "req_123" }]), { status: 201 });
    });

    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Authenticated-User-Email": "ops@winerim.com",
        },
        body: JSON.stringify({
          input: {
            provider: "agora",
            locationName: "Casa Demo",
            posBaseUrl: "demo.example.test:8984",
            posApiToken: secrets.posToken,
            winerimApiToken: secrets.winerimToken,
          },
          gates: [
            { id: "input", label: "Datos", status: "pass", detail: `OK ${secrets.posToken}` },
            { id: "winerim", label: "Winerim", status: "pass", detail: "OK" },
            { id: "pos", label: "Agora", status: "pass", detail: "OK" },
            { id: "write", label: "Escritura", status: "blocked", detail: "No writes" },
          ],
        }),
      }),
      {
        ...env,
        ONBOARDING_REQUESTS_ENABLED: "true",
        LOVABLE_CLOUD_REST_URL: "https://lovable.example/rest/v1",
        LOVABLE_CLOUD_SERVICE_KEY: secrets.serviceKey,
      },
    );
    const body = await jsonOf(response);
    const serializedResponse = JSON.stringify(body);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      success: true,
      id: "req_123",
      status: "READY_FOR_TECHNICAL_REVIEW",
      readyForTechnicalReview: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(serializedResponse).not.toContain(secrets.posToken);
    expect(serializedResponse).not.toContain(secrets.winerimToken);
    expect(serializedResponse).not.toContain(secrets.serviceKey);
  });

  it("lists onboarding requests only when storage and Access identity are present", async () => {
    const serviceKey = "secret-service-role";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toContain("https://lovable.example/rest/v1/onboarding_requests?");
      expect(String(input)).toContain("status=eq.READY_FOR_TECHNICAL_REVIEW");
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBe(serviceKey);
      return new Response(JSON.stringify([
        {
          id: "11111111-1111-1111-1111-111111111111",
          provider: "agora",
          location_name: "Casa Demo",
          status: "READY_FOR_TECHNICAL_REVIEW",
        },
      ]), { status: 200 });
    });

    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/requests?status=READY_FOR_TECHNICAL_REVIEW", {
        headers: { "CF-Access-Authenticated-User-Email": "ops@winerim.com" },
      }),
      {
        ...env,
        ONBOARDING_REQUESTS_ENABLED: "true",
        LOVABLE_CLOUD_REST_URL: "https://lovable.example/rest/v1",
        LOVABLE_CLOUD_SERVICE_KEY: serviceKey,
      },
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.items).toEqual([
      {
        id: "11111111-1111-1111-1111-111111111111",
        provider: "agora",
        location_name: "Casa Demo",
        status: "READY_FOR_TECHNICAL_REVIEW",
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("validates Cloudflare Access JWT audience before listing private requests", async () => {
    const serviceKey = "secret-service-role";
    const access = await createAccessJwt({
      aud: "winerim-staging-aud",
      email: "ops@winerim.com",
      kid: "access-key-1",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://winerim.cloudflareaccess.com/cdn-cgi/access/certs") {
        return new Response(JSON.stringify({ keys: [access.publicJwk] }), { status: 200 });
      }

      expect(url).toContain("https://lovable.example/rest/v1/onboarding_requests?");
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBe(serviceKey);
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/requests", {
        headers: { "CF-Access-Jwt-Assertion": access.token },
      }),
      {
        ...env,
        ONBOARDING_REQUESTS_ENABLED: "true",
        LOVABLE_CLOUD_REST_URL: "https://lovable.example/rest/v1",
        LOVABLE_CLOUD_SERVICE_KEY: serviceKey,
        CF_ACCESS_AUD: "winerim-staging-aud",
        CF_ACCESS_TEAM_DOMAIN: "https://winerim.cloudflareaccess.com",
      },
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, items: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects Cloudflare Access JWTs with the wrong audience before storage access", async () => {
    const access = await createAccessJwt({
      aud: "other-aud",
      email: "ops@winerim.com",
      kid: "access-key-2",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/requests", {
        headers: { "CF-Access-Jwt-Assertion": access.token },
      }),
      {
        ...env,
        ONBOARDING_REQUESTS_ENABLED: "true",
        LOVABLE_CLOUD_REST_URL: "https://lovable.example/rest/v1",
        LOVABLE_CLOUD_SERVICE_KEY: "secret-service-role",
        CF_ACCESS_AUD: "winerim-staging-aud",
        CF_ACCESS_TEAM_DOMAIN: "https://winerim.cloudflareaccess.com",
      },
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ success: false, error: "ACCESS_IDENTITY_REQUIRED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("updates onboarding request status without converting connections", async () => {
    const serviceKey = "secret-service-role";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      expect(url).toContain("https://lovable.example/rest/v1/onboarding_requests?");
      expect(url).toContain("id=eq.11111111-1111-1111-1111-111111111111");

      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify([
          {
            id: "11111111-1111-1111-1111-111111111111",
            status: "READY_FOR_TECHNICAL_REVIEW",
          },
        ]), { status: 200 });
      }

      expect(init.method).toBe("PATCH");
      const row = JSON.parse(String(init?.body));
      expect(row.status).toBe("TECHNICAL_REVIEW");
      expect(row.reviewed_at).toBeTruthy();
      expect(JSON.stringify(row)).not.toContain(serviceKey);

      return new Response(JSON.stringify([
        {
          id: "11111111-1111-1111-1111-111111111111",
          status: "TECHNICAL_REVIEW",
        },
      ]), { status: 200 });
    });

    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/requests/11111111-1111-1111-1111-111111111111", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Authenticated-User-Email": "ops@winerim.com",
        },
        body: JSON.stringify({ status: "TECHNICAL_REVIEW" }),
      }),
      {
        ...env,
        ONBOARDING_REQUESTS_ENABLED: "true",
        LOVABLE_CLOUD_REST_URL: "https://lovable.example/rest/v1",
        LOVABLE_CLOUD_SERVICE_KEY: serviceKey,
      },
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      item: {
        id: "11111111-1111-1111-1111-111111111111",
        status: "TECHNICAL_REVIEW",
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe onboarding status transitions before patching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify([
        {
          id: "11111111-1111-1111-1111-111111111111",
          status: "TESTED",
        },
      ]), { status: 200 });
    });

    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/requests/11111111-1111-1111-1111-111111111111", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Authenticated-User-Email": "ops@winerim.com",
        },
        body: JSON.stringify({ status: "CONVERTED" }),
      }),
      {
        ...env,
        ONBOARDING_REQUESTS_ENABLED: "true",
        LOVABLE_CLOUD_REST_URL: "https://lovable.example/rest/v1",
        LOVABLE_CLOUD_SERVICE_KEY: "secret-service-role",
      },
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      error: "INVALID_STATUS_TRANSITION",
      from: "TESTED",
      to: "CONVERTED",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid onboarding request status updates", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(
      new Request("https://api.example.test/api/onboarding/requests/11111111-1111-1111-1111-111111111111", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Authenticated-User-Email": "ops@winerim.com",
        },
        body: JSON.stringify({ status: "AUTO_CREATE_CONNECTION" }),
      }),
      {
        ...env,
        ONBOARDING_REQUESTS_ENABLED: "true",
        LOVABLE_CLOUD_REST_URL: "https://lovable.example/rest/v1",
        LOVABLE_CLOUD_SERVICE_KEY: "secret-service-role",
      },
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, error: "INVALID_STATUS" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
