import {
  CatalogApplyPortResult,
  CatalogApplyReceipt,
  CatalogContextPortResult,
  CatalogHandlerErrorCode,
  CatalogHandlerPorts,
  CatalogHandlerResult,
} from "./contracts";
import { buildCatalogPlan } from "./planning";
import { validateCatalogRequest } from "./validation";

const ERROR_STATUS: Partial<Record<CatalogHandlerErrorCode, 404 | 409 | 422 | 503>> = {
  CONTEXT_NOT_FOUND: 404,
  CONTEXT_UNAVAILABLE: 503,
  CONTEXT_INVALID: 422,
  CATALOG_PLAN_BLOCKED: 422,
  APPLY_PORT_NOT_CONFIGURED: 503,
  APPLY_REJECTED: 422,
  APPLY_UNAVAILABLE: 503,
  APPLY_CONFLICT: 409,
};

function failure(code: CatalogHandlerErrorCode, message: string): Extract<CatalogHandlerResult, { ok: false }> {
  return {
    ok: false,
    status: ERROR_STATUS[code] || 400,
    error: { code, message },
  };
}

function sanitizedReceipt(
  receipt: CatalogApplyReceipt,
  plannedProductIds: ReadonlySet<string>,
): CatalogApplyReceipt {
  const appliedProductIds = [...new Set(receipt.appliedProductIds.map(String))]
    .filter((productId) => plannedProductIds.has(productId))
    .sort((left, right) => Number(left) - Number(right));
  const providerRequestId = String(receipt.providerRequestId || "").trim();
  return {
    status: receipt.status === "duplicate" ? "duplicate" : "applied",
    appliedProductIds,
    ...(providerRequestId && /^[A-Za-z0-9_.:-]{1,128}$/.test(providerRequestId)
      ? { providerRequestId }
      : {}),
  };
}

export async function handleCatalogRequest(
  input: unknown,
  ports: CatalogHandlerPorts,
): Promise<CatalogHandlerResult> {
  const validation = validateCatalogRequest(input);
  if (validation.ok === false) return validation.result;
  const request = validation.request;

  let contextResult: CatalogContextPortResult;
  try {
    contextResult = await ports.loadPlanningContext(request);
  } catch {
    return failure("CONTEXT_UNAVAILABLE", "Catalog planning context is unavailable.");
  }
  if (contextResult.ok === false) {
    return failure(contextResult.code, "Catalog planning context could not be loaded.");
  }

  const plan = await buildCatalogPlan(request, contextResult.context);
  if (request.dryRun || request.canonicalAction === "preview") {
    return { ok: true, status: 200, mode: "preview", plan };
  }
  if (!plan.readyToApply) {
    return failure("CATALOG_PLAN_BLOCKED", "Catalog plan contains blocking validation issues.");
  }
  if (!ports.applyPlan) {
    return failure("APPLY_PORT_NOT_CONFIGURED", "Catalog apply port is not configured.");
  }

  let applyResult: CatalogApplyPortResult;
  try {
    applyResult = await ports.applyPlan({ request, plan, idempotency: plan.idempotency });
  } catch {
    return failure("APPLY_UNAVAILABLE", "Catalog apply port is unavailable.");
  }
  if (applyResult.ok === false) {
    return failure(applyResult.code, "Catalog plan was not applied.");
  }

  const plannedProductIds = new Set(plan.operations.map((operation) => operation.desired.productId));
  const receipt = sanitizedReceipt(applyResult.receipt, plannedProductIds);
  return {
    ok: true,
    status: 200,
    mode: receipt.status,
    plan,
    receipt,
  };
}
