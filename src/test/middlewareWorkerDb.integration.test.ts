import { describe, expect, it } from "vitest";
import worker from "../../cloudflare/workers/middleware-api/src/index";

const connectionString = process.env.MIDDLEWARE_TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;
const env = {
  ENVIRONMENT: "staging",
  RELEASE: "integration-test",
  ALLOWED_ORIGIN: "https://staging.middleware.winerim.wine",
  MIDDLEWARE_ADMIN_TOKEN: "integration-test-admin",
  MIDDLEWARE_DB: { connectionString: connectionString || "postgresql://missing" },
};
const auth = { Authorization: "Bearer integration-test-admin" };

describeDatabase("middleware Worker with a real empty Postgres bootstrap", () => {
  it("verifies the database sentinel through /ready", async () => {
    const response = await worker.fetch(new Request("https://api.example.test/ready", { headers: auth }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      database: "staging",
      role: "middleware_api_login",
    });
  });

  it("reads the seeded Agora fleet through Hyperdrive-compatible pg", async () => {
    const response = await worker.fetch(new Request("https://api.example.test/api/agora/fleet", { headers: auth }), env);
    const body = await response.json() as { success: boolean; rows: Array<Record<string, unknown>> };
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      connection: { location_name: "Staging Restaurant", enabled: false },
      metrics: { verifiedProducts: 0, outboundOpen: 0, stockFailedOpen: 0 },
    });
  });

  it("persists only a sanitized onboarding review packet", async () => {
    const response = await worker.fetch(new Request("https://api.example.test/api/onboarding/requests", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "agora",
        locationName: "Staging Candidate",
        posBaseUrl: "https://pos.example.test",
        readyForTechnicalReview: false,
        gateSummary: [],
        nextRequiredChecklistIds: ["connection"],
      }),
    }), env);
    const body = await response.json() as { success: boolean; request: { location_name: string; status: string } };
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      success: true,
      request: { location_name: "Staging Candidate", status: "DRAFT" },
    });
  });
});
