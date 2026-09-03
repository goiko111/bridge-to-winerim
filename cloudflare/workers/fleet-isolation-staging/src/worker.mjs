const HARNESS_MODE = "STAGING_SYNTHETIC_ONLY";
const MAX_DELAY_MS = 90_000;
const SLOW_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const FAST_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

import { consumeRuntimeQueueBatch } from "../../middleware-runtime/src/queue";

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function timingSafeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function assertHarnessEnv(env) {
  if (env.HARNESS_MODE !== HARNESS_MODE) throw new Error("ISOLATION_HARNESS_MODE_DISABLED");
  if (!env.ISOLATION_QUEUE || typeof env.ISOLATION_QUEUE.sendBatch !== "function") {
    throw new Error("ISOLATION_HARNESS_QUEUE_MISSING");
  }
}

function eventPayload(event, message, timestamp = new Date().toISOString()) {
  return {
    component: "fleet-isolation-staging",
    event,
    runId: message.runId,
    messageId: message.messageId,
    connectionId: message.connectionId,
    delayMs: Number(message.payload?.delayMs || 0),
    timestamp,
  };
}

export function buildIsolationMessages(runId) {
  if (!/^[a-z0-9-]{8,64}$/u.test(runId)) throw new Error("ISOLATION_RUN_ID_INVALID");
  return [
    {
      body: {
        name: "winerim.middleware.runtime",
        version: 1,
        runId,
        messageId: `${runId}-slow`,
        idempotencyKey: `${runId}-slow`,
        connectionId: SLOW_CONNECTION_ID,
        lane: "catalog",
        job: "catalog.sync-master",
        retryProfile: "POS_OUTBOUND",
        attempt: 0,
        maxAttempts: 1,
        createdAt: "2026-09-03T00:00:00.000Z",
        availableAt: "2026-09-03T00:00:00.000Z",
        source: { kind: "api", eventId: `${runId}-slow` },
        payload: { runId, delayMs: 60_000 },
      },
      contentType: "json",
    },
    {
      body: {
        name: "winerim.middleware.runtime",
        version: 1,
        runId,
        messageId: `${runId}-fast`,
        idempotencyKey: `${runId}-fast`,
        connectionId: FAST_CONNECTION_ID,
        lane: "catalog",
        job: "catalog.sync-master",
        retryProfile: "POS_OUTBOUND",
        attempt: 0,
        maxAttempts: 1,
        createdAt: "2026-09-03T00:00:00.000Z",
        availableAt: "2026-09-03T00:00:00.000Z",
        source: { kind: "api", eventId: `${runId}-fast` },
        payload: { runId, delayMs: 25 },
      },
      contentType: "json",
    },
  ];
}

export function parseIsolationMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ISOLATION_MESSAGE_INVALID");
  }
  const message = value;
  const runId = String(message.payload?.runId || "");
  if (!/^[a-z0-9-]{8,64}$/u.test(runId)) {
    throw new Error("ISOLATION_MESSAGE_RUN_ID_INVALID");
  }
  if (!/^[a-z0-9-]{8,96}$/u.test(String(message.messageId || ""))) {
    throw new Error("ISOLATION_MESSAGE_ID_INVALID");
  }
  if (![SLOW_CONNECTION_ID, FAST_CONNECTION_ID].includes(String(message.connectionId || ""))) {
    throw new Error("ISOLATION_MESSAGE_CONNECTION_INVALID");
  }
  const delayMs = Number(message.payload?.delayMs);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    throw new Error("ISOLATION_MESSAGE_DELAY_INVALID");
  }
  return Object.freeze({
    ...message,
    runId,
    messageId: String(message.messageId),
    payload: Object.freeze({ runId, delayMs }),
  });
}

export async function consumeIsolationBatch(batch, dependencies = {}) {
  const sleep = dependencies.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const log = dependencies.log || ((payload) => console.log(JSON.stringify(payload)));
  const now = dependencies.now || (() => new Date().toISOString());

  if (!batch || !Array.isArray(batch.messages) || batch.messages.length > 10) {
    throw new Error("ISOLATION_BATCH_SIZE_INVALID");
  }
  for (const message of batch.messages) parseIsolationMessage(message.body);
  return consumeRuntimeQueueBatch(batch, {
    reserve: async () => "acquired",
    execute: async (message) => {
      const parsed = parseIsolationMessage(message);
      log(eventPayload("started", parsed, now()));
      await sleep(parsed.payload.delayMs);
      log(eventPayload("completed", parsed, now()));
      return { ok: true };
    },
    complete: async () => undefined,
    releaseForRetry: async () => undefined,
    releaseForDeadLetter: async () => undefined,
    recordTerminal: async () => undefined,
  });
}

export default {
  async fetch(request, env) {
    assertHarnessEnv(env);
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, mode: HARNESS_MODE });
    }
    if (url.pathname !== "/run" || request.method !== "POST") return json({ error: "NOT_FOUND" }, 404);

    const suppliedKey = request.headers.get("x-staging-run-key") || "";
    if (!timingSafeEqual(suppliedKey, env.STAGING_RUN_KEY || "")) {
      return json({ error: "UNAUTHORIZED" }, 401);
    }
    const requestBody = await request.json().catch(() => ({}));
    const runId = String(requestBody.runId || "");
    const messages = buildIsolationMessages(runId);
    await env.ISOLATION_QUEUE.sendBatch(messages);
    return json({ accepted: true, runId, messages: messages.length }, 202);
  },

  async queue(batch, env) {
    assertHarnessEnv(env);
    await consumeIsolationBatch(batch);
  },
};
