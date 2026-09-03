import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildIsolationMessages,
  consumeIsolationBatch,
} from "../../cloudflare/workers/fleet-isolation-staging/src/worker.mjs";
import { renderIsolationConfig } from "../../infrastructure/runtime/render-fleet-isolation-staging-config.mjs";

const root = resolve(import.meta.dirname, "../..");
const template = readFileSync(
  resolve(root, "cloudflare/workers/fleet-isolation-staging/wrangler.toml.example"),
  "utf8",
);

describe("Fleet Queue staging isolation harness", () => {
  it("renders a synthetic-only batch-one consumer with concurrency two", () => {
    const result = renderIsolationConfig(template, "20260903-a");

    expect(result.workerName).toBe("winerim-fleet-isolation-20260903-a");
    expect(result.rendered).toContain("max_batch_size = 10");
    expect(result.rendered).toContain("max_concurrency = 2");
    expect(result.rendered).toContain('HARNESS_MODE = "STAGING_SYNTHETIC_ONLY"');
    expect(result.rendered).not.toContain("{{");
    expect(result.rendered).not.toMatch(/(?:postgres|supabase|api[_-]?token|password)/iu);
  });

  it("creates one slow and one fast connection without real identifiers", () => {
    const messages = buildIsolationMessages("20260903-a");

    expect(messages).toHaveLength(2);
    expect(messages.map((item) => item.body.connectionId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(messages.map((item) => item.body.payload.delayMs)).toEqual([60_000, 25]);
  });

  it("acks only after one valid message completes", async () => {
    const ack = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const body = buildIsolationMessages("20260903-a")[1].body;

    await consumeIsolationBatch({ messages: [{ body, ack }] }, {
      sleep,
      log,
      now: () => "2026-09-03T10:00:00.000Z",
    });

    expect(sleep).toHaveBeenCalledWith(25);
    expect(log.mock.calls.map(([entry]) => entry.event)).toEqual(["started", "completed"]);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("fails closed if Cloudflare ever delivers a batch larger than ten", async () => {
    const body = buildIsolationMessages("20260903-a")[1].body;
    await expect(consumeIsolationBatch({
      messages: Array.from({ length: 11 }, (_, index) => ({
        id: `message-${index}`,
        attempts: 1,
        body: { ...body, messageId: `20260903-a-fast-${index}`, idempotencyKey: `20260903-a-fast-${index}` },
        ack: vi.fn(),
        retry: vi.fn(),
      })),
    })).rejects.toThrow("ISOLATION_BATCH_SIZE_INVALID");
  });
});
