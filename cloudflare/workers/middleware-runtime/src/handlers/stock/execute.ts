import {
  WINERIM_MUTATION_MAX_ATTEMPTS,
  WINERIM_MUTATION_RETRY_DELAY_MS,
  WinerimMutationAttempt,
  WinerimMutationExecutionResult,
  WinerimMutationHttpRequest,
  WinerimMutationPlan,
  WinerimMutationTransport,
  WinerimStockMutationInput,
} from "./contracts";
import {
  decideWinerimMutationResponse,
  planWinerimStockMutation,
  selectRetryableSalesImportRequest,
} from "./decisions";

function orderIdsForRequest(request: WinerimMutationHttpRequest): string[] {
  return request.kind === "sales-import"
    ? request.body.sales.map((sale) => sale.orderId)
    : [];
}

export async function executeWinerimMutationPlan(
  plan: WinerimMutationPlan,
  transport: WinerimMutationTransport,
): Promise<WinerimMutationExecutionResult> {
  const allOrderIds = orderIdsForRequest(plan.request);
  const certified = new Set<string>();
  const terminal = new Set<string>();
  const attempts: WinerimMutationAttempt[] = [];
  let request = plan.request;

  for (let attemptNumber = 1; attemptNumber <= WINERIM_MUTATION_MAX_ATTEMPTS; attemptNumber++) {
    let response;
    try {
      response = await transport.send(request);
    } catch (error) {
      attempts.push({
        number: attemptNumber,
        request,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        retryable: true,
        plan,
        attempts,
        certifiedOrderIds: [...certified],
        terminalOrderIds: [...terminal],
        pendingOrderIds: orderIdsForRequest(request),
        reason: "transport_failure_deferred_to_queue_retry",
      };
    }

    const decision = decideWinerimMutationResponse({ plan, request, response });
    attempts.push({ number: attemptNumber, request, response, decision });
    decision.certifiedOrderIds.forEach((orderId) => certified.add(orderId));
    decision.terminalOrderIds.forEach((orderId) => terminal.add(orderId));

    if (decision.action === "success") {
      const complete = plan.request.kind === "stock-put" ||
        (allOrderIds.every((orderId) => certified.has(orderId)) && terminal.size === 0);
      return {
        ok: complete,
        retryable: false,
        plan,
        attempts,
        certifiedOrderIds: [...certified],
        terminalOrderIds: [...terminal],
        pendingOrderIds: complete ? [] : allOrderIds.filter((orderId) => !certified.has(orderId)),
        reason: complete ? decision.reason : "mutation_completed_with_uncertified_lines",
      };
    }

    if (decision.action === "terminal") {
      return {
        ok: false,
        retryable: false,
        plan,
        attempts,
        certifiedOrderIds: [...certified],
        terminalOrderIds: [...terminal],
        pendingOrderIds: orderIdsForRequest(request).filter((orderId) => !terminal.has(orderId)),
        reason: decision.reason,
      };
    }

    const exhausted = attemptNumber >= WINERIM_MUTATION_MAX_ATTEMPTS;
    if (exhausted) {
      return {
        ok: false,
        retryable: true,
        plan,
        attempts,
        certifiedOrderIds: [...certified],
        terminalOrderIds: [...terminal],
        pendingOrderIds: decision.retryableOrderIds,
        reason: "winerim_mutation_attempts_exhausted",
      };
    }

    if (decision.action === "retry-lines") {
      if (request.kind !== "sales-import" || decision.retryableOrderIds.length === 0) {
        return {
          ok: false,
          retryable: false,
          plan,
          attempts,
          certifiedOrderIds: [...certified],
          terminalOrderIds: [...terminal],
          pendingOrderIds: [],
          reason: "invalid_line_retry_decision",
        };
      }
      request = selectRetryableSalesImportRequest(request, decision.retryableOrderIds);
    }
    // For retry-full, retain the exact request object and payload reference.
    await transport.sleep(WINERIM_MUTATION_RETRY_DELAY_MS);
  }

  return {
    ok: false,
    retryable: true,
    plan,
    attempts,
    certifiedOrderIds: [...certified],
    terminalOrderIds: [...terminal],
    pendingOrderIds: orderIdsForRequest(request),
    reason: "winerim_mutation_attempts_exhausted",
  };
}

export async function executeWinerimStockMutation(
  input: WinerimStockMutationInput,
  transport: WinerimMutationTransport,
): Promise<WinerimMutationExecutionResult> {
  return executeWinerimMutationPlan(planWinerimStockMutation(input), transport);
}
