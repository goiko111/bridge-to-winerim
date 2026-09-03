import { buildSalesMutationIdempotencyKey, buildSalesOrderId } from "./identity";
import { planSalesRun } from "./planner";
import type {
  SalesExecutionItem,
  SalesExecutionPorts,
  SalesExecutionResult,
  SalesHandlerInput,
  SalesHandlerPorts,
  SalesHandlerResult,
  SalesClaimCompletionEvidence,
  SalesImportCommand,
  SalesImportResult,
  SalesMutationAcceptanceEvidence,
  SalesMutationIntent,
} from "./types";

const WINERIM_MUTATION_MAX_ATTEMPTS = 3;

function executionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error !== "object" || error === null || !("driverCode" in error)) return message;
  const driverCode = String((error as { driverCode?: unknown }).driverCode ?? "").trim();
  return /^[A-Z0-9_]{2,12}$/i.test(driverCode) ? `${message}:${driverCode}` : message;
}

export type SalesImportDecision = {
  accepted: boolean;
  retryable: boolean;
  error?: string;
  evidence?: SalesMutationAcceptanceEvidence;
};

function validAcceptanceEvidence(
  evidence: SalesMutationAcceptanceEvidence | undefined,
  expectedOrderId?: string,
): evidence is SalesMutationAcceptanceEvidence {
  if (
    evidence?.contractVersion !== 1
    || evidence.accepted !== true
    || !evidence.orderId
    || !evidence.reason
  ) return false;
  if (expectedOrderId && evidence.orderId !== expectedOrderId) return false;
  return evidence.acceptedBy === "WINERIM_STOCK_READBACK"
    || evidence.certifiedOrderIds.includes(evidence.orderId);
}

export function evaluateSalesImportResult(
  result: SalesImportResult,
  requireStockApplied: boolean,
): SalesImportDecision {
  const retryable = result.status === 409 || result.retryable === true || result.lines?.some((line) => line.retryable) === true;
  if (!result.ok) {
    return {
      accepted: false,
      retryable,
      error: result.error ?? `sales/import failed${result.status ? ` with HTTP ${result.status}` : ""}`,
    };
  }
  const failedLine = result.lines?.find((line) => line.error || line.retryable);
  if (failedLine) {
    return {
      accepted: false,
      retryable,
      error: failedLine.error ?? "sales/import returned a retryable line",
    };
  }
  if (!validAcceptanceEvidence(result.evidence)) {
    return {
      accepted: false,
      retryable: false,
      error: "sales/import succeeded without structured Winerim acceptance/readback evidence",
    };
  }
  if (!requireStockApplied || result.duplicate === true) {
    return { accepted: true, retryable: false, evidence: result.evidence };
  }
  const lines = result.lines ?? [];
  if (lines.length > 0 && lines.every((line) => line.stockApplied === true || line.duplicate === true)) {
    return { accepted: true, retryable: false, evidence: result.evidence };
  }
  return {
    accepted: false,
    retryable,
    error: "Live glass import did not confirm stockApplied:true or duplicate:true for every line",
  };
}

async function executeSalesImport(
  intent: SalesMutationIntent,
  command: SalesImportCommand,
  requireStockApplied: boolean,
  ports: SalesExecutionPorts,
): Promise<
  { ok: true; evidence: SalesMutationAcceptanceEvidence }
  | { ok: false; retryable: boolean; error: string }
> {
  const result = await ports.importSales(command);
  const decision = evaluateSalesImportResult(result, requireStockApplied);
  if (decision.accepted && !validAcceptanceEvidence(decision.evidence, command.orderId)) {
    return {
      ok: false,
      retryable: false,
      error: "sales/import acceptance evidence does not match the requested orderId",
    };
  }
  if (!decision.accepted || !decision.evidence) {
    return {
      ok: false,
      retryable: decision.retryable,
      error: decision.error ?? `Sales import failed for ${intent.orderId}`,
    };
  }
  return { ok: true, evidence: decision.evidence };
}

async function executeIntent(
  intent: SalesMutationIntent,
  delta: number,
  orderId: string,
  mutationIdempotencyKey: string,
  ports: SalesExecutionPorts,
): Promise<
  { ok: true; usedSalesOnlyFallback: boolean; evidence: SalesMutationAcceptanceEvidence }
  | { ok: false; retryable: boolean; error: string }
> {
  if (intent.action.kind === "SALES_IMPORT") {
    const lines = intent.action.lines.map((line) => ({ ...line, quantity: delta }));
    const result = await executeSalesImport(intent, {
      claimKey: intent.claimKey,
      orderId,
      idempotencyKey: mutationIdempotencyKey,
      connectionId: intent.connectionId,
      businessDay: intent.businessDay,
      live: intent.action.live,
      stockDisposition: intent.action.stockDisposition,
      lines,
    }, intent.action.requireStockApplied, ports);
    if (result.ok === false) return result;
    return result.evidence
      ? { ok: true, usedSalesOnlyFallback: false, evidence: result.evidence }
      : { ok: false, retryable: false, error: "sales/import acceptance evidence is missing" };
  }

  const stockResult = await ports.applyStock({
    claimKey: intent.claimKey,
    orderId,
    idempotencyKey: mutationIdempotencyKey,
    connectionId: intent.connectionId,
    stockId: intent.action.stockId,
    winerimWineId: intent.winerimWineId,
    variant: intent.action.variant,
    decrementQuantity: delta,
    desiredQuantity: intent.desiredQuantity,
    businessDay: intent.businessDay,
  });
  if (!stockResult.ok) {
    return {
      ok: false,
      retryable: stockResult.status === 409 || stockResult.retryable === true,
      error: stockResult.error ?? `Stock apply failed${stockResult.status ? ` with HTTP ${stockResult.status}` : ""}`,
    };
  }
  if (stockResult.duplicate === true || stockResult.stockMoved === true) {
    if (!validAcceptanceEvidence(stockResult.evidence, orderId)) {
      return {
        ok: false,
        retryable: false,
        error: "Stock apply succeeded without structured Winerim acceptance/readback evidence",
      };
    }
    return { ok: true, usedSalesOnlyFallback: false, evidence: stockResult.evidence };
  }
  if (stockResult.stockMoved !== false || !intent.action.fallbackToSalesOnlyIfStockDidNotMove) {
    return {
      ok: false,
      retryable: false,
      error: "Stock apply succeeded without an explicit stockMoved/duplicate confirmation",
    };
  }

  const fallbackOrderId = `${orderId}:sales-only`;
  const fallback = await executeSalesImport(intent, {
    claimKey: intent.claimKey,
    orderId: fallbackOrderId,
    idempotencyKey: await buildSalesMutationIdempotencyKey({ orderId: fallbackOrderId, action: "SALES_IMPORT" }),
    connectionId: intent.connectionId,
    businessDay: intent.businessDay,
    live: false,
    stockDisposition: "SALES_ONLY_NO_STOCK",
    lines: [{ ...intent.action.line, quantity: delta }],
  }, false, ports);
  if (fallback.ok === false) return fallback;
  return fallback.evidence
    ? { ok: true, usedSalesOnlyFallback: true, evidence: fallback.evidence }
    : { ok: false, retryable: false, error: "sales-only fallback acceptance evidence is missing" };
}

export async function executeSalesPlan(
  plan: SalesHandlerResult["plan"],
  ports: SalesExecutionPorts,
  options: { dryRun?: boolean; sourcePersisted?: boolean } = {},
): Promise<SalesExecutionResult> {
  const dryRun = options.dryRun === true;
  const items: SalesExecutionItem[] = [];
  if (dryRun) {
    for (const intent of plan.intents) {
      items.push({
        claimKey: intent.claimKey,
        orderId: intent.orderId,
        status: "DRY_RUN",
        desiredQuantity: intent.desiredQuantity,
        appliedBefore: intent.observedAppliedQuantity,
        appliedDelta: Math.max(0, intent.desiredQuantity - intent.observedAppliedQuantity),
      });
    }
    return { dryRun, items };
  }

  let sourcePersisted = options.sourcePersisted === true;
  if (ports.persistDocuments) {
    await ports.persistDocuments(plan.documents);
    sourcePersisted = true;
  }
  if (!sourcePersisted) {
    return {
      dryRun,
      items: plan.intents.map((intent) => ({
        claimKey: intent.claimKey,
        orderId: intent.orderId,
        status: "FAILED",
        desiredQuantity: intent.desiredQuantity,
        appliedBefore: intent.observedAppliedQuantity,
        appliedDelta: 0,
        retryable: true,
        retryMaxAttempts: WINERIM_MUTATION_MAX_ATTEMPTS,
        error: "SALES_SOURCE_PERSISTENCE_UNCONFIRMED",
      })),
    };
  }
  for (const intent of plan.intents) {
    const reservation = await ports.reserveClaim(intent);
    const appliedBefore = Math.max(0, reservation.appliedQuantity);
    if (reservation.state === "BUSY") {
      items.push({
        claimKey: intent.claimKey,
        orderId: intent.orderId,
        status: "BUSY",
        desiredQuantity: intent.desiredQuantity,
        appliedBefore,
        appliedDelta: 0,
      });
      continue;
    }
    if (reservation.state === "QUARANTINED") {
      items.push({
        claimKey: intent.claimKey,
        orderId: intent.orderId,
        status: "QUARANTINED",
        desiredQuantity: intent.desiredQuantity,
        appliedBefore,
        appliedDelta: 0,
        error: reservation.error,
      });
      continue;
    }
    if (reservation.state === "DUPLICATE" || appliedBefore >= intent.desiredQuantity) {
      if (reservation.state === "ACQUIRED") {
        await ports.releaseClaim({
          claimKey: reservation.claimKey,
          orderId: intent.orderId,
          retryable: false,
          error: "SALES_CLAIM_APPLIED_WITHOUT_CERTIFICATION",
          payloadSha256: reservation.payloadSha256,
          leaseToken: reservation.leaseToken,
        });
        items.push({
          claimKey: intent.claimKey,
          orderId: intent.orderId,
          status: "QUARANTINED",
          desiredQuantity: intent.desiredQuantity,
          appliedBefore,
          appliedDelta: 0,
          error: "SALES_CLAIM_APPLIED_WITHOUT_CERTIFICATION",
        });
        continue;
      }
      items.push({
        claimKey: intent.claimKey,
        orderId: intent.orderId,
        status: "ALREADY_APPLIED",
        desiredQuantity: intent.desiredQuantity,
        appliedBefore,
        appliedDelta: 0,
      });
      continue;
    }

    const delta = intent.desiredQuantity - appliedBefore;
    const orderId = await buildSalesOrderId({
      provider: intent.provider,
      claimKey: intent.claimKey,
      businessDay: intent.businessDay,
      variant: intent.variant,
      desiredQuantity: intent.desiredQuantity,
    });
    const mutationIdempotencyKey = await buildSalesMutationIdempotencyKey({
      orderId,
      action: intent.action.kind,
    });
    try {
      const result = await executeIntent(intent, delta, orderId, mutationIdempotencyKey, ports);
      if (result.ok === false) {
        await ports.releaseClaim({
          claimKey: reservation.claimKey,
          orderId,
          retryable: result.retryable,
          error: result.error,
          payloadSha256: reservation.payloadSha256,
          leaseToken: reservation.leaseToken,
        });
        items.push({
          claimKey: intent.claimKey,
          orderId,
          status: "FAILED",
          desiredQuantity: intent.desiredQuantity,
          appliedBefore,
          appliedDelta: 0,
          retryable: result.retryable,
          retryMaxAttempts: result.retryable ? WINERIM_MUTATION_MAX_ATTEMPTS : undefined,
          error: result.error,
        });
        continue;
      }
      await ports.completeClaim({
        claimKey: reservation.claimKey,
        orderId,
        appliedQuantity: intent.desiredQuantity,
        payloadSha256: reservation.payloadSha256,
        leaseToken: reservation.leaseToken,
        evidence: {
          contractVersion: 1,
          sourceObserved: true,
          sourcePersisted: true,
          action: intent.action.kind,
          winerim: result.evidence,
        } satisfies SalesClaimCompletionEvidence,
      });
      items.push({
        claimKey: intent.claimKey,
        orderId,
        status: "APPLIED",
        desiredQuantity: intent.desiredQuantity,
        appliedBefore,
        appliedDelta: delta,
        usedSalesOnlyFallback: result.usedSalesOnlyFallback,
        completionEvidence: {
          contractVersion: 1,
          sourceObserved: true,
          sourcePersisted: true,
          action: intent.action.kind,
          winerim: result.evidence,
        },
      });
    } catch (error) {
      const message = executionErrorMessage(error);
      await ports.releaseClaim({
        claimKey: reservation.claimKey,
        orderId,
        retryable: true,
        error: message,
        payloadSha256: reservation.payloadSha256,
        leaseToken: reservation.leaseToken,
      });
      items.push({
        claimKey: intent.claimKey,
        orderId,
        status: "FAILED",
        desiredQuantity: intent.desiredQuantity,
        appliedBefore,
        appliedDelta: 0,
        retryable: true,
        retryMaxAttempts: WINERIM_MUTATION_MAX_ATTEMPTS,
        error: message,
      });
    }
  }
  return { dryRun, items };
}

export async function handleSalesRun(
  input: SalesHandlerInput,
  ports: SalesHandlerPorts,
): Promise<SalesHandlerResult> {
  const plan = await planSalesRun(input, ports);
  const execution = await executeSalesPlan(plan, ports, { dryRun: input.dryRun });
  return { plan, execution };
}
