import { describe, expect, it, vi } from "vitest";

import { createRuntimeEnvelope } from "../../cloudflare/workers/middleware-runtime/src/idempotency";
import { createRuntimeExecutorService } from "../../cloudflare/workers/middleware-runtime/src/executor/service";

async function envelope() {
  return createRuntimeEnvelope({
    connectionId: "11111111-1111-4111-8111-111111111111",
    job: "catalog.sync-master",
    dedupeScope: "service-test",
    payload: { dryRun: true },
    createdAt: "2026-08-02T09:00:00.000Z",
    availableAt: "2026-08-02T09:00:00.000Z",
    source: { kind: "queue", eventId: "service-test" },
  });
}

describe("runtime executor service", () => {
  it("accepts only the internal execution route and a valid envelope", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, detail: "catalog:preview:1" });
    const service = createRuntimeExecutorService({ execute });
    const response = await service.fetch(new Request("https://executor.internal/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: await envelope() }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed for invalid envelopes and oversized bodies", async () => {
    const execute = vi.fn();
    const service = createRuntimeExecutorService({ execute });
    const invalid = await service.fetch(new Request("https://executor.internal/v1/execute", {
      method: "POST",
      body: JSON.stringify({ envelope: { job: "catalog.sync-master" } }),
    }));
    expect(invalid.status).toBe(422);

    const oversized = await service.fetch(new Request("https://executor.internal/v1/execute", {
      method: "POST",
      body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    }));
    expect(oversized.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });
});
