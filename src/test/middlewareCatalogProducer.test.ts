import { describe, expect, it, vi } from "vitest";

import type { DatabaseAdapter } from "../../cloudflare/workers/middleware-api/src/db";
import type {
  SecretTextPort,
  WinerimCatalogClient,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/http";
import {
  CATALOG_PRODUCER_CRON,
  runCatalogProducerScheduled,
  type CatalogProducerDependencies,
  type CatalogProducerTarget,
  type MiddlewareCatalogProducerEnv,
} from "../../cloudflare/workers/middleware-catalog-producer/src/worker";

const TARGET: CatalogProducerTarget = Object.freeze({
  connectionId: "11111111-1111-4111-8111-111111111111",
  runId: "albariza-catalog-a",
  winerimWineId: "855797",
  format: "BOTTLE",
  agoraProductId: "1055797",
});

function credential(overrides: Record<string, unknown> = {}): SecretTextPort {
  return {
    read: () => "secret",
    attestation: () => ({
      reference: `runtime-vault://postgres/${TARGET.connectionId}/agora/winerim`,
      version: "a".repeat(64),
      connectionId: TARGET.connectionId,
      provider: "agora",
      kind: "winerim",
      ...overrides,
    }),
  } as SecretTextPort;
}

function env(send = vi.fn().mockResolvedValue(undefined)): MiddlewareCatalogProducerEnv {
  return {
    ENVIRONMENT: "rescue-production",
    CATALOG_PRODUCER_ENABLED: "true",
    CANARY_RUN_ID: TARGET.runId,
    CANARY_CONNECTION_ID: TARGET.connectionId,
    CANARY_WINERIM_WINE_ID: TARGET.winerimWineId,
    CANARY_CATALOG_FORMAT: TARGET.format,
    CANARY_AGORA_PRODUCT_ID: TARGET.agoraProductId,
    RUNTIME_VAULT_KEY_VERSION: "v1",
    WINERIM_API_BASE_URL: "https://app.winerim.com",
    WINERIM_ALLOWED_HOSTS: "app.winerim.com",
    MIDDLEWARE_DB: { connectionString: "postgresql://unused.invalid/db" },
    RUNTIME_VAULT_KEY: { get: vi.fn().mockResolvedValue("unused") },
    MIDDLEWARE_CATALOG_QUEUE: { send },
  };
}

function dependencies(input: {
  scope?: CatalogProducerTarget | null;
  secret?: SecretTextPort | null;
  catalog?: WinerimCatalogClient;
} = {}): CatalogProducerDependencies {
  const database = {} as DatabaseAdapter;
  return {
    database: vi.fn(() => database),
    loadScope: vi.fn().mockResolvedValue(input.scope === undefined ? TARGET : input.scope),
    openCredential: vi.fn().mockResolvedValue(input.secret === undefined ? credential() : input.secret),
    catalog: vi.fn(() => input.catalog ?? {
      fetchOne: vi.fn().mockResolvedValue({
        fingerprint: "f".repeat(64),
        wine: {
          winerimId: TARGET.winerimWineId,
          name: "Canary wine",
          vintage: "2024",
          wineType: "tinto",
          active: true,
          variant: { format: "BOTTLE", salePrice: 13, costPrice: 5, enabled: true },
        },
      }),
    }),
  };
}

describe("exact Albariza catalog producer", () => {
  it("emits one causal catalog.sync-master envelope with refreshBeforeApply", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const bindings = env(send);
    const ports = dependencies();

    const result = await runCatalogProducerScheduled({
      cron: CATALOG_PRODUCER_CRON,
      scheduledTime: Date.parse("2026-08-04T10:20:37Z"),
    }, bindings, ports);

    expect(result).toEqual({ status: "dispatched", messages: 1, fingerprint: "f".repeat(64) });
    expect(send).toHaveBeenCalledOnce();
    const envelope = send.mock.calls[0][0];
    expect(envelope).toMatchObject({
      connectionId: TARGET.connectionId,
      job: "catalog.sync-master",
      lane: "catalog",
      source: {
        kind: "cron",
        scheduledSlot: "2026-08-04T10:20:00.000Z",
        trigger: "* * * * *",
      },
      payload: {
        winerimWineIds: [TARGET.winerimWineId],
        formatTypes: [TARGET.format],
        agoraProductId: TARGET.agoraProductId,
        target: {
          connectionId: TARGET.connectionId,
          winerimWineId: TARGET.winerimWineId,
          format: TARGET.format,
          agoraProductId: TARGET.agoraProductId,
        },
        refreshBeforeApply: {
          version: 1,
          runId: TARGET.runId,
          source: "winerim.bulk",
          endpoint: "/api/v2/wines/bulk",
          fingerprint: "f".repeat(64),
          wine: expect.objectContaining({ winerimId: TARGET.winerimWineId }),
        },
      },
    });
    expect(ports.loadScope).toHaveBeenCalledWith(expect.anything(), TARGET);
    expect(ports.openCredential).toHaveBeenCalledWith(expect.anything(), bindings, TARGET);
  });

  it("keeps message and idempotency identity stable while the observed fingerprint is unchanged", async () => {
    const firstSend = vi.fn().mockResolvedValue(undefined);
    const secondSend = vi.fn().mockResolvedValue(undefined);
    await runCatalogProducerScheduled(
      { cron: CATALOG_PRODUCER_CRON, scheduledTime: Date.parse("2026-08-04T10:20:00Z") },
      env(firstSend),
      dependencies(),
    );
    await runCatalogProducerScheduled(
      { cron: CATALOG_PRODUCER_CRON, scheduledTime: Date.parse("2026-08-04T10:21:00Z") },
      env(secondSend),
      dependencies(),
    );

    expect(firstSend.mock.calls[0][0].messageId).toBe(secondSend.mock.calls[0][0].messageId);
    expect(firstSend.mock.calls[0][0].idempotencyKey).toBe(secondSend.mock.calls[0][0].idempotencyKey);
  });

  it("does not fetch or enqueue when the DB source scope is absent or mismatched", async () => {
    const send = vi.fn();
    const catalog = { fetchOne: vi.fn() } as WinerimCatalogClient;
    const ports = dependencies({ scope: null, catalog });

    await expect(runCatalogProducerScheduled(
      { cron: CATALOG_PRODUCER_CRON, scheduledTime: Date.now() },
      env(send),
      ports,
    )).resolves.toEqual({ status: "inactive", reason: "SOURCE_SCOPE_REJECTED", messages: 0 });
    expect(ports.openCredential).not.toHaveBeenCalled();
    expect(catalog.fetchOne).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not fetch or enqueue with a credential attested to another connection", async () => {
    const send = vi.fn();
    const catalog = { fetchOne: vi.fn() } as WinerimCatalogClient;
    const ports = dependencies({
      secret: credential({ connectionId: "22222222-2222-4222-8222-222222222222" }),
      catalog,
    });

    await expect(runCatalogProducerScheduled(
      { cron: CATALOG_PRODUCER_CRON, scheduledTime: Date.now() },
      env(send),
      ports,
    )).resolves.toEqual({ status: "inactive", reason: "CREDENTIAL_REJECTED", messages: 0 });
    expect(catalog.fetchOne).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("is inert for a wrong cron, disabled switch or incomplete exact target", async () => {
    const ports = dependencies();
    const wrongCron = await runCatalogProducerScheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now() },
      env(),
      ports,
    );
    const disabledEnv = env();
    disabledEnv.CATALOG_PRODUCER_ENABLED = "false";
    const disabled = await runCatalogProducerScheduled(
      { cron: CATALOG_PRODUCER_CRON, scheduledTime: Date.now() },
      disabledEnv,
      ports,
    );
    const incompleteEnv = env();
    incompleteEnv.CANARY_AGORA_PRODUCT_ID = "";
    const incomplete = await runCatalogProducerScheduled(
      { cron: CATALOG_PRODUCER_CRON, scheduledTime: Date.now() },
      incompleteEnv,
      ports,
    );

    expect(wrongCron).toEqual({ status: "inactive", reason: "INVALID_CRON", messages: 0 });
    expect(disabled).toEqual({ status: "inactive", reason: "PRODUCER_DISABLED", messages: 0 });
    expect(incomplete).toEqual({ status: "inactive", reason: "CONFIGURATION_REJECTED", messages: 0 });
    expect(ports.database).not.toHaveBeenCalled();
  });
});
