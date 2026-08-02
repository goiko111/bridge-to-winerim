import { buildSalesMutationIdempotencyKey, buildSalesOrderId } from "./identity";
import { planSalesRun } from "./planner";
import type {
  SalesExecutionItem,
  SalesExecutionPorts,
  SalesExecutionResult,
  SalesHandlerInput,
  SalesHandlerPorts,
  SalesHandlerResult,
  SalesImportCommand,
  SalesImportResult,
  SalesMutationIntent,
} from "./types";

const WINERIM_MUTATION_MAX_ATTEMPTS = 3;

export type SalesImportDecision = {
  accepted: boolean;
  retryable: boolean;
  error?: string;
};

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
  if (!requireStockApplied || result.duplicate === true) {
    return { accepted: true, retryable: false };
  }
  const lines = result.lines ?? [];
  if (lines.length > 0 && lines.every((line) => line.stockApplied === true || line.duplicate === true)) {
    return { accepted: true, retryable: false };
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
): Promise<{ ok: true } | { ok: false; retryable: boolean; error: string }> {
  const result = await ports.importSales(command);
  const decision = evaluateSalesImportResult(result, requireStockApplied);
  return decision.accepted
    ? { ok: true }
    : { ok: false, retryable: decision.retryable, error: decision.error ?? `Sales import failed for ${intent.orderId}` };
}

async function executeIntent(
  intent: SalesMutationIntent,
  delta: number,
  orderId: string,
  mutationIdempotencyKey: string,
  ports: SalesExecutionPorts,
): Promise<{ ok: true; usedSalesOnlyFallback: boolean } | { ok: false; retryable: boolean; error: string }> {
  if (intent.action.kind === "SALES_IMPORT") {
    const lines = intent.action.lines.map((line) => ({ ...line, quantity: delta }));
    const result = await executeSalesImport(intent, {
      claimKey: intent.claimKey,
      orderId,
      idempotencyKey: mutationIdempotencyKey,
      connectionId: intent.connectionId,
      businessDay: intent.businessDay,
      live: intent.action.live,
      lines,
    }, intent.action.requireStockApplied, ports);
    return result.ok ? { ok: true, usedSalesOnlyFallback: false } : result;
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
    return { ok: true, usedSalesOnlyFallback: false };
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
    lines: [{ ...intent.action.line, quantity: delta }],
  }, false, ports);
  return fallback.ok ? { ok: true, usedSalesOnlyFallback: true } : fallback;
}

export async function executeSalesPlan(
  plan: SalesHandlerResult["plan"],
  ports: SalesExecutionPorts,
  options: { dryRun?: boolean } = {},
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

  if (ports.persistDocuments) await ports.persistDocuments(plan.documents);
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
    if (reservation.state === "DUPLICATE" || appliedBefore >= intent.desiredQuantity) {
      if (reservation.state === "ACQUIRED") {
        await ports.completeClaim({
          claimKey: intent.claimKey,
          orderId: intent.orderId,
          appliedQuantity: appliedBefore,
        });
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
      if (!result.ok) {
        await ports.releaseClaim({
          claimKey: intent.claimKey,
          orderId,
          retryable: result.retryable,
          error: result.error,
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
        claimKey: intent.claimKey,
        orderId,
        appliedQuantity: intent.desiredQuantity,
      });
      items.push({
        claimKey: intent.claimKey,
        orderId,
        status: "APPLIED",
        desiredQuantity: intent.desiredQuantity,
        appliedBefore,
        appliedDelta: delta,
        usedSalesOnlyFallback: result.usedSalesOnlyFallback,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ports.releaseClaim({
        claimKey: intent.claimKey,
        orderId,
        retryable: true,
        error: message,
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
