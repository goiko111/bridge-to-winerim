import { describe, expect, it } from "vitest";
import {
  buildLegacyRuntimeInvocation,
  buildRuntimeIdempotencyKey,
  canonicalJson,
  createRuntimeEnvelope,
  isRuntimeEnvelope,
} from "../../cloudflare/workers/middleware-runtime/src";

describe("Cloudflare runtime envelopes", () => {
  it("canonicalizes object keys without changing array order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: [2, 1] } })).toBe(
      '{"a":{"c":[2,1],"d":4},"b":2}',
    );
  });

  it("builds stable connection-scoped idempotency keys", async () => {
    const first = await buildRuntimeIdempotencyKey({
      connectionId: "connection-a",
      job: "outbound.process",
      dedupeScope: "cron:2026-08-02T10:00:00.000Z",
      payload: { z: 1, a: true },
    });
    const reordered = await buildRuntimeIdempotencyKey({
      connectionId: "connection-a",
      job: "outbound.process",
      dedupeScope: "cron:2026-08-02T10:00:00.000Z",
      payload: { a: true, z: 1 },
    });
    const otherConnection = await buildRuntimeIdempotencyKey({
      connectionId: "connection-b",
      job: "outbound.process",
      dedupeScope: "cron:2026-08-02T10:00:00.000Z",
      payload: { a: true, z: 1 },
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(otherConnection);
    expect(first).toMatch(/^idem:v1:[a-f0-9]{64}$/);
  });

  it("creates a valid immutable contract and maps it to the current runtime action", async () => {
    const envelope = await createRuntimeEnvelope({
      connectionId: "connection-a",
      job: "outbound.process",
      dedupeScope: "task:task-1",
      payload: { taskId: "task-1" },
      source: { kind: "queue", eventId: "task-1" },
      createdAt: "2026-08-02T10:00:00.000Z",
    });

    expect(isRuntimeEnvelope(envelope)).toBe(true);
    expect(envelope).toMatchObject({
      lane: "outbound-queue",
      retryProfile: "POS_OUTBOUND",
      maxAttempts: 5,
      attempt: 0,
    });
    expect(buildLegacyRuntimeInvocation(envelope)).toEqual({
      functionName: "agora-proxy",
      body: {
        action: "process-xml-outbound-queue",
        connectionId: "connection-a",
        serverLoop: true,
      },
    });
  });

  it("keeps leaf Winerim mutations separate from legacy proxy dispatch", async () => {
    const liveSale = await createRuntimeEnvelope({
      connectionId: "connection-a",
      job: "winerim.sales-import-live",
      dedupeScope: "sale:order-1",
      payload: { orderId: "order-1", live: true },
      source: { kind: "api", eventId: "order-1" },
      createdAt: "2026-08-02T10:00:00.000Z",
    });

    expect(liveSale).toMatchObject({
      lane: "sales-import",
      retryProfile: "WINERIM_MUTATION",
      maxAttempts: 3,
    });
    expect(buildLegacyRuntimeInvocation(liveSale)).toBeNull();
  });
});
