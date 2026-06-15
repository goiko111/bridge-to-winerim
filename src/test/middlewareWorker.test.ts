import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../cloudflare/workers/middleware-api/src/index";

const env = {
  ENVIRONMENT: "test",
  RELEASE: "test",
  ALLOWED_ORIGIN: "https://staging.middleware.winerim.wine",
};

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
      new Request("https://api.example.test/api/onboarding/test", {
        method: "OPTIONS",
        headers: {
          Origin: "https://preview.middleware.winerim.wine",
          "Access-Control-Request-Method": "POST",
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
});
