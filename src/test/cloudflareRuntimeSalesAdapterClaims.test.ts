import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
  TransactionOptions,
} from "../../cloudflare/workers/middleware-api/src/db";
import {
  createPostgresSalesAdapter,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/sales";
import type {
  SalesMutationIntent,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/sales";

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

type Route = (statement: SqlStatement) => QueryResult<Record<string, unknown>>;

function fakeDatabase(route: Route) {
  const statements: SqlStatement[] = [];
  const transactionOptions: TransactionOptions[] = [];
  const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
    statements.push(statement);
    return route(statement) as QueryResult<Row>;
  });
  const transaction: DatabaseAdapter["transaction"] = vi.fn(async (work, options = {}) => {
    transactionOptions.push(options);
    return work({ query } as DatabaseTransaction);
  });
  return {
    database: { query, transaction } as DatabaseAdapter,
    statements,
    transactionOptions,
  };
}

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function completionEvidence(orderId: string) {
  return {
    contractVersion: 1 as const,
    sourceObserved: true as const,
    sourcePersisted: true as const,
    action: "SALES_IMPORT" as const,
    winerim: {
      contractVersion: 1 as const,
      orderId,
      accepted: true as const,
      acceptedBy: "WINERIM_MUTATION_RESPONSE" as const,
      reason: "fixture_import_certified",
      responseStatus: 200,
      certifiedOrderIds: [orderId],
      stockDisposition: "HISTORY_ONLY_NO_STOCK" as const,
    },
  };
}

function intent(sourceDocumentId: string): SalesMutationIntent {
  return {
    claimKey: "sales-claim:v1:shared-open-final",
    orderId: "mw:v1:agora:2026-07-29:same:b:t1",
    mutationIdempotencyKey: "sales-mutation:v1:same",
    connectionId: CONNECTION_ID,
    provider: "agora",
    businessDay: "2026-07-29",
    lifecycleId: "ticket-100",
    winerimWineId: "47593",
    variant: "BOTTLE",
    desiredQuantity: 1,
    observedAppliedQuantity: 0,
    sourceDocumentIds: [sourceDocumentId],
    sourceLineIds: ["line-1"],
    sourceDocumentKind: sourceDocumentId.startsWith("open-ticket:")
      ? "OPEN_TICKET"
      : "DEFINITIVE_INVOICE",
    action: {
      kind: "STOCK_APPLY",
      stockId: "stock-47593",
      variant: "BOTTLE",
      fallbackToSalesOnlyIfStockDidNotMove: true,
      line: {
        lineId: "line-1",
        winerimWineId: "47593",
        variant: "BOTTLE",
        quantity: 1,
        providerProductIds: ["547593"],
      },
    },
  };
}

describe("PostgreSQL sales adapter claims", () => {
  it("prevents OpenTicket to definitive-invoice double application with one durable claim", async () => {
    let state: "NONE" | "RUNNING" | "SUCCESS" = "NONE";
    let appliedQuantity = 0;
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FOR UPDATE")) {
        if (state === "NONE") return result();
        return result([{
          idempotency_key: "sales-claim:v1:shared-open-final",
          message_id: "mw:v1:agora:2026-07-29:same:b:t1",
          job: "sales.claim",
          status: state,
          applied_quantity: appliedQuantity,
          lease_expired: false,
          result: {
            appliedQuantity,
            lifecycleId: "ticket-100",
            winerimWineId: "47593",
            variant: "BOTTLE",
          },
          updated_at: "2026-07-29T13:05:00Z",
        }]);
      }
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) {
        if (state !== "NONE") return result();
        state = "RUNNING";
        return result([{
          idempotency_key: "sales-claim:v1:shared-open-final",
          status: state,
          applied_quantity: 0,
          result: { appliedQuantity: 0 },
        }]);
      }
      if (statement.text.includes("status = 'SUCCESS'")) {
        state = "SUCCESS";
        appliedQuantity = 1;
        return result([{ idempotency_key: "sales-claim:v1:shared-open-final" }]);
      }
      return result();
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
      claimLeaseSeconds: 60,
    });

    const openTicket = intent("open-ticket:ticket-100");
    const reservation = await adapter.reserveClaim(openTicket);
    expect(reservation).toMatchObject({
      state: "ACQUIRED",
      appliedQuantity: 0,
      claimKey: openTicket.claimKey,
      payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      leaseToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    if (reservation.state !== "ACQUIRED") throw new Error("expected acquired sales claim");
    await adapter.completeClaim({
      claimKey: reservation.claimKey,
      orderId: openTicket.orderId,
      appliedQuantity: 1,
      payloadSha256: reservation.payloadSha256,
      leaseToken: reservation.leaseToken,
      evidence: completionEvidence(openTicket.orderId),
    });

    const definitive = intent("invoice:invoice-100");
    expect(await adapter.reserveClaim(definitive)).toEqual({ state: "DUPLICATE", appliedQuantity: 1 });

    expect(fake.statements.some((statement) => statement.text.includes("FOR UPDATE"))).toBe(true);
    expect(fake.statements.filter((statement) => statement.text.includes("INSERT INTO public.runtime_idempotency")))
      .toHaveLength(1);
    expect(fake.transactionOptions).toEqual([
      { isolationLevel: "serializable", readOnly: false },
      { isolationLevel: "serializable", readOnly: false },
    ]);
  });

  it("reacquires a completed OpenTicket claim only for a larger definitive total", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result();
      if (statement.text.includes("FOR UPDATE")) {
        return result([{
          idempotency_key: "sales-claim:v1:shared-open-final",
          message_id: "open-order-t1",
          job: "sales.claim",
          status: "SUCCESS",
          applied_quantity: 1,
          lease_expired: true,
          result: {
            appliedQuantity: 1,
            lifecycleId: "ticket-100",
            winerimWineId: "47593",
            variant: "BOTTLE",
          },
          updated_at: "2026-07-29T13:05:00Z",
        }]);
      }
      if (statement.text.includes("SET\n          message_id")) {
        return result([{
          idempotency_key: "sales-claim:v1:shared-open-final",
          status: "RUNNING",
          applied_quantity: 1,
          result: { appliedQuantity: 1 },
        }]);
      }
      return result();
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });
    const definitive = {
      ...intent("invoice:invoice-100"),
      orderId: "final-order-t2",
      desiredQuantity: 2,
      observedAppliedQuantity: 1,
    };

    await expect(adapter.reserveClaim(definitive)).resolves.toEqual({
      state: "ACQUIRED",
      appliedQuantity: 1,
      claimKey: "sales-claim:v1:shared-open-final",
      payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      leaseToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    const reacquire = fake.statements.find((statement) =>
      statement.text.includes("UPDATE public.runtime_idempotency")
      && statement.text.includes("attempt = attempt + 1")
    );
    expect(reacquire?.values).toEqual(expect.arrayContaining([
      "final-order-t2",
      "sales-claim:v1:shared-open-final",
      CONNECTION_ID,
    ]));
  });

  it("loads claim quantities and maps database states without mutating them", async () => {
    const fake = fakeDatabase((statement) => {
      expect(statement.text).toContain("FROM public.runtime_idempotency");
      expect(statement.text).toContain("job =");
      return result([
        {
          idempotency_key: "claim-complete",
          message_id: "order-1",
          job: "sales.claim",
          status: "SUCCESS",
          applied_quantity: "2",
          lease_expires_at: null,
          result: { appliedQuantity: 2 },
          updated_at: "2026-07-29T13:05:00Z",
        },
        {
          idempotency_key: "claim-running",
          message_id: "order-2",
          job: "sales.claim",
          status: "RUNNING",
          applied_quantity: "1",
          lease_expires_at: "2026-07-29T13:07:00Z",
          result: { appliedQuantity: 1 },
          updated_at: "2026-07-29T13:05:00Z",
        },
        {
          idempotency_key: "claim-false-success",
          message_id: "order-3",
          job: "sales.claim",
          status: "SUCCESS",
          applied_quantity: "1",
          lease_expires_at: null,
          result: { appliedQuantity: 1, lastError: "transport_failure", retryable: true },
          updated_at: "2026-07-29T13:05:00Z",
        },
        {
          idempotency_key: "claim-terminal",
          message_id: "order-4",
          job: "sales.claim",
          status: "TERMINAL",
          applied_quantity: "0",
          lease_expires_at: null,
          result: { appliedQuantity: 0, lastError: "identity_rejected" },
          updated_at: "2026-07-29T13:05:00Z",
        },
      ]);
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await expect(adapter.loadClaims?.(["claim-running", "claim-complete"]))
      .resolves.toEqual([
        { claimKey: "claim-complete", state: "COMPLETE", appliedQuantity: 2 },
        { claimKey: "claim-running", state: "PENDING", appliedQuantity: 1 },
        { claimKey: "claim-false-success", state: "QUARANTINED", appliedQuantity: 1 },
        { claimKey: "claim-terminal", state: "QUARANTINED", appliedQuantity: 0 },
      ]);
    expect(fake.transactionOptions).toEqual([{ isolationLevel: "repeatable-read", readOnly: true }]);
    expect(fake.statements[0].values).toEqual([
      CONNECTION_ID,
      "sales.claim",
      ["claim-complete", "claim-running"],
      ["claim-complete", "claim-running"],
    ]);
  });

  it("loads lifecycle and missing-ticket claims for explicit reconciliation", async () => {
    const fake = fakeDatabase((statement) => {
      expect(statement.text).toContain("jsonb_array_elements_text");
      expect(statement.text).toContain("definitive_event.doc_type = 'BasicInvoice'");
      return result([{
        idempotency_key: "sales-claim:v1:removed",
        message_id: "legacy-order",
        job: "sales.claim",
        status: "SUCCESS",
        applied_quantity: "2",
        lease_expires_at: null,
        result: {
          appliedQuantity: 2,
          lifecycleId: "ticket-removed",
          winerimWineId: "47593",
          variant: "BOTTLE",
          sourceDocumentIds: ["open-ticket:removed"],
          sourceLineIds: ["line-removed"],
          sourceDocumentKind: "OPEN_TICKET",
        },
        updated_at: "2026-07-29T13:05:00Z",
      }]);
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await expect(adapter.loadReconciliationClaims?.({
      lifecycleIds: ["ticket-current"],
      includeMissingOpenTickets: true,
    })).resolves.toEqual([{
      claimKey: "sales-claim:v1:removed",
      state: "COMPLETE",
      appliedQuantity: 2,
      lifecycleId: "ticket-removed",
      winerimWineId: "47593",
      variant: "BOTTLE",
      sourceDocumentIds: ["open-ticket:removed"],
      sourceLineIds: ["line-removed"],
      sourceDocumentKind: "OPEN_TICKET",
    }]);
    expect(fake.statements[0].values).toEqual([
      CONNECTION_ID,
      "sales.claim",
      ["ticket-current"],
      true,
    ]);
  });

  it("parameterizes failure details when releasing a claim", async () => {
    const secretLikeError = "upstream failed for token-do-not-inline";
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("UPDATE public.runtime_idempotency")) {
        return result([{ idempotency_key: "claim-1" }]);
      }
      return result();
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await adapter.releaseClaim({
      claimKey: "claim-1",
      orderId: "order-1",
      retryable: true,
      error: secretLikeError,
      payloadSha256: "a".repeat(64),
      leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(fake.statements[0].text).not.toContain(secretLikeError);
    expect(JSON.stringify(fake.statements[0].values)).toContain(secretLikeError);
    expect(fake.statements[0].values).toContain("RETRY");
    expect(fake.statements[0].text).toContain("payload_sha256 =");
    expect(fake.statements[0].text).toContain("lease_token =");
    expect(fake.statements[0].values).toContain("a".repeat(64));
    expect(fake.statements[0].values).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("rejects completion from a stale lease owner", async () => {
    const fake = fakeDatabase(() => result());
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await expect(adapter.completeClaim({
      claimKey: "claim-1",
      orderId: "order-1",
      appliedQuantity: 1,
      payloadSha256: "c".repeat(64),
      leaseToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      evidence: completionEvidence("order-1"),
    })).rejects.toMatchObject({ code: "SALES_CLAIM_COMPLETE_NOT_OWNED" });
    expect(fake.statements[0].text).toContain("payload_sha256 =");
    expect(fake.statements[0].text).toContain("lease_token =");
  });

  it("quarantines terminal and false-success claims instead of reporting transient busy", async () => {
    for (const row of [
      {
        status: "TERMINAL",
        result: {
          appliedQuantity: 0,
          lifecycleId: "ticket-100",
          winerimWineId: "47593",
          variant: "BOTTLE",
          lastError: "identity_rejected",
        },
        expectedError: "SALES_CLAIM_TERMINAL_QUARANTINED",
      },
      {
        status: "SUCCESS",
        result: {
          appliedQuantity: 1,
          lifecycleId: "ticket-100",
          winerimWineId: "47593",
          variant: "BOTTLE",
          lastError: "transport_failure",
          retryable: true,
        },
        expectedError: "SALES_CLAIM_SUCCESS_WITHOUT_EVIDENCE_QUARANTINED",
      },
    ]) {
      const fake = fakeDatabase((statement) => {
        if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result();
        if (statement.text.includes("FOR UPDATE")) {
          return result([{
            idempotency_key: "sales-claim:v1:shared-open-final",
            message_id: "order-1",
            job: "sales.claim",
            status: row.status,
            applied_quantity: row.result.appliedQuantity,
            lease_expired: true,
            result: row.result,
            updated_at: "2026-07-29T13:05:00Z",
          }]);
        }
        return result();
      });
      const adapter = createPostgresSalesAdapter(fake.database, {
        connectionId: CONNECTION_ID,
        provider: "agora",
      });

      await expect(adapter.reserveClaim(intent("invoice:invoice-100"))).resolves.toEqual({
        state: "QUARANTINED",
        appliedQuantity: row.result.appliedQuantity,
        error: row.expectedError,
      });
      expect(fake.statements.some((statement) => statement.text.includes("attempt = attempt + 1"))).toBe(false);
    }
  });
});
