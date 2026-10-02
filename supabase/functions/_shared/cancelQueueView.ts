// Pure view of a prepared Winerim cancellation for the admin approval screen.
export type CancelView = { wine: string | null; format: "Botella" | "Copa" | "Otro"; units: number | null; saleId: number | null; reason: string | null; businessDay: string | null; orderId: string | null };

type Payload = { cancels?: Array<{ orderId?: string; cancelUpTo?: number; reason?: string }> } | null;
type Elig = Array<{ saleId?: number; businessDay?: string }> | null;

export function describeCancel(payload: Payload, eligibility: Elig): CancelView {
  const c = payload?.cancels?.[0] ?? {};
  const orderId = c.orderId ?? null;
  const reason = c.reason ?? null;
  const wine = reason ? /\(([^)]+)\)\s*$/.exec(reason)?.[1]?.trim() ?? null : null;
  const format = /:bot:/.test(orderId ?? "") ? "Botella" : /:cop:/.test(orderId ?? "") ? "Copa" : "Otro";
  const e = Array.isArray(eligibility) ? eligibility[0] : undefined;
  const day = e?.businessDay ?? /:(\d{4}-\d{2}-\d{2}):/.exec(orderId ?? "")?.[1] ?? null;
  return { wine, format, units: Number.isInteger(c.cancelUpTo) ? c.cancelUpTo! : null, saleId: typeof e?.saleId === "number" ? e.saleId : null, reason, businessDay: day, orderId };
}

/** The approver must be a different person than the preparer. */
export function canApprove(requestedBy: string | null, userId: string, status: string): boolean {
  return status === "PENDING_APPROVAL" && !!requestedBy && requestedBy !== userId;
}
