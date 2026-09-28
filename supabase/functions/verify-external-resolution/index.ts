import { asDryRun, assertPost, json, parseJson, preflight, requirePlatformAdmin, safeError } from "../_shared/reconciliation-v2/edge.ts";
import { compareAuthorizedBatch, evaluateExternalResolution } from "../_shared/reconciliation-v2/engine.ts";
import { AUTHORIZED_EXTERNAL_RESOLUTIONS_19 } from "../_shared/reconciliation-v2/fixtures/authorized-external-resolutions-19.ts";
import { sha256Hex } from "../_shared/reconciliation-v2/hash.ts";
import type { CandidateTarget, ExternalResolutionCase, SaleDeletion, StockMovement } from "../_shared/reconciliation-v2/types.ts";

type Body = { dryRun?: boolean };
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : String(value ?? "").split(/[,\s]+/).filter(Boolean);

Deno.serve(async (request) => {
  const options = preflight(request); if (options) return options;
  try {
    assertPost(request); const { db } = await requirePlatformAdmin(request); const body = await parseJson<Body>(request); const dryRun = asDryRun(body.dryRun);
    const [{ data: audits, error: auditError }, { count: detailBlocked, error: detailError }] = await Promise.all([
      db.from("agora_reversal_audit")
      .select("id,connection_id,case_fingerprint,identity_scope,evidence_classification,keep_sale_ids,candidate_targets,bottles_overdeducted")
      .eq("identity_scope", "SALE").like("evidence_classification", "CONFIRMED_DUPLICATE%"),
      db.from("agora_reversal_audit").select("id", { count: "exact", head: true }).eq("identity_scope", "DETAIL").like("evidence_classification", "CONFIRMED_DUPLICATE%"),
    ]);
    if (auditError || detailError) throw Object.assign(new Error("No se pudo leer la auditoría global autorizada"), { status: 500, code: "REVERSAL_AUDIT_READ_FAILED" });
    const observed = (audits ?? []).map((row) => ({ caseFingerprint: row.case_fingerprint, candidateTargets: row.candidate_targets as CandidateTarget[] }));
    const cardinality = compareAuthorizedBatch(AUTHORIZED_EXTERNAL_RESOLUTIONS_19, observed);
    if (cardinality.state !== "MATCHED" || (audits ?? []).length !== 19 || detailBlocked !== 6) {
      return json(request, { ok: false, mode: "AUDIT_ONLY", verificationScope: "GLOBAL_AUTHORIZED_EXTERNAL_RESOLUTIONS", dryRun, verdict: "CARDINALITY_CONFLICT", authoritativeSaleCases: 19, observedSaleCases: audits?.length ?? 0, expectedDetailCasesBlocked: 6, observedDetailCasesBlocked: detailBlocked ?? 0, extra: cardinality.extra, missing: cardinality.missing }, 409);
    }

    const evidenceByConnection = new Map<string, { live: Record<string, unknown>[]; deletions: Record<string, unknown>[]; movements: Record<string, unknown>[] }>();
    for (const connectionId of [...new Set((audits ?? []).map((row) => String(row.connection_id)))]) {
      const cases = (audits ?? []).filter((row) => row.connection_id === connectionId);
      const candidateTargets = cases.flatMap((row) => row.candidate_targets as CandidateTarget[]);
      const candidateIds = [...new Set(candidateTargets.map((target) => Number(target.saleId)))];
      const keepIds = [...new Set(cases.flatMap((row) => strings(row.keep_sale_ids).map(Number)))];
      const receipts = [...new Set(candidateTargets.map((target) => target.receiptId).filter((value): value is string => Boolean(value)))];
      const [{ data: live, error: liveError }, { data: deletions, error: deletionError }, { data: bySale, error: bySaleError }] = await Promise.all([
        db.from("winerim_sales_records").select("sale_id,status").eq("connection_id", connectionId).in("sale_id", [...candidateIds, ...keepIds]),
        db.from("winerim_sale_deletions").select("sale_id,sale_detail_id,line_id,reason,deleted_at,effective_at,external_order_id").eq("connection_id", connectionId).in("sale_id", candidateIds),
        db.from("winerim_stock_movements").select("*").eq("connection_id", connectionId).in("linked_sale_id", candidateIds),
      ]);
      if (liveError || deletionError || bySaleError) throw Object.assign(new Error("Faltó evidencia local agrupada"), { status: 500, code: "EXTERNAL_EVIDENCE_READ_FAILED" });
      let movementRows = bySale ?? [];
      if (receipts.length) {
        const { data, error } = await db.from("winerim_stock_movements").select("*").eq("connection_id", connectionId).in("receipt_id", receipts);
        if (error) throw Object.assign(new Error("Falló la evidencia agrupada por recibo"), { status: 500, code: "EXTERNAL_RECEIPT_READ_FAILED" });
        movementRows = [...movementRows, ...(data ?? [])];
      }
      const { data: byReference, error: referenceError } = await db.from("winerim_stock_movements").select("*").eq("connection_id", connectionId).eq("reference_type", "sale").in("reference_id", candidateIds.map(String));
      if (referenceError) throw Object.assign(new Error("Falló la evidencia agrupada por referencia"), { status: 500, code: "EXTERNAL_REFERENCE_READ_FAILED" });
      const uniqueMovements = [...new Map([...movementRows, ...(byReference ?? [])].map((row) => [String(row.movement_id), row])).values()];
      evidenceByConnection.set(connectionId, { live: live ?? [], deletions: deletions ?? [], movements: uniqueMovements });
    }

    const evidence = [];
    for (const row of audits ?? []) {
      const authoritative = AUTHORIZED_EXTERNAL_RESOLUTIONS_19.find((item) => item.caseFingerprint === row.case_fingerprint)!;
      const targets = row.candidate_targets as CandidateTarget[]; const saleIds = targets.map((target) => Number(target.saleId)); const keepIds = strings(row.keep_sale_ids).map(Number);
      const grouped = evidenceByConnection.get(row.connection_id)!;
      const mappedMovements: StockMovement[] = grouped.movements.map((movement) => ({ movementId: Number(movement.movement_id), category: String(movement.category), change: movement.quantity_change == null ? null : Number(movement.quantity_change), quantityBefore: movement.quantity_before == null ? null : Number(movement.quantity_before), quantityAfter: movement.quantity_after == null ? null : Number(movement.quantity_after), wine: { wineId: movement.wine_id == null ? null : Number(movement.wine_id) }, variant: { priceId: movement.price_id == null ? null : Number(movement.price_id), stockId: movement.stock_id == null ? null : Number(movement.stock_id), format: movement.format_key == null ? null : String(movement.format_key) }, sale: movement.linked_sale_id == null ? null : { saleId: Number(movement.linked_sale_id), saleDetailIds: Array.isArray(movement.linked_sale_detail_ids) ? movement.linked_sale_detail_ids.map(Number) : [], receiptId: movement.receipt_id == null ? null : String(movement.receipt_id), orderId: movement.order_id == null ? null : String(movement.order_id) }, reference: movement.reference_type == null ? null : { type: String(movement.reference_type), id: String(movement.reference_id) } }));
      const auditCase: ExternalResolutionCase = { id: row.id, connectionId: row.connection_id, caseFingerprint: row.case_fingerprint, identityScope: row.identity_scope, evidenceClassification: row.evidence_classification, keepSaleIds: keepIds.map(String), candidateTargets: targets, expectedRestoredQty: Number(row.bottles_overdeducted) };
      const result = evaluateExternalResolution({ auditCase, authoritativeBatch: AUTHORIZED_EXTERNAL_RESOLUTIONS_19, liveSaleIds: grouped.live.filter((sale) => sale.status !== "rejected").map((sale) => Number(sale.sale_id)), confirmedKeptSaleIds: grouped.live.filter((sale) => sale.status === "confirmed").map((sale) => Number(sale.sale_id)), deletions: grouped.deletions.filter((item) => saleIds.includes(Number(item.sale_id))).map((item) => ({ saleId: Number(item.sale_id), saleDetailId: item.sale_detail_id == null ? null : Number(item.sale_detail_id), lineId: String(item.line_id), reason: item.reason, deletedAt: String(item.deleted_at), effectiveAt: item.effective_at == null ? null : String(item.effective_at), externalOrderId: item.external_order_id == null ? null : String(item.external_order_id) })) as SaleDeletion[], movements: mappedMovements, checkedAt: new Date().toISOString() });
      const evidenceHash = await sha256Hex(result); evidence.push({ ...result, evidenceHash });
      if (!dryRun) {
        const { error } = await db.rpc("reconciliation_v2_record_external_resolution", { p_audit_case_id: row.id, p_connection_id: row.connection_id, p_case_fingerprint: row.case_fingerprint, p_candidate_targets: row.candidate_targets, p_evidence_hash: evidenceHash, p_verdict: result.verdict, p_missing: result.missing, p_evidence: result, p_checked_at: result.checkedAt });
        if (error) throw Object.assign(new Error("No se pudo registrar evidencia externa de forma atómica"), { status: 500, code: "EXTERNAL_EVIDENCE_COMMIT_FAILED" });
      }
      if (authoritative.connectionId !== row.connection_id) throw Object.assign(new Error("El caso cambió de conexión"), { status: 409, code: "CASE_CONNECTION_CONFLICT" });
    }
    return json(request, { ok: true, mode: "AUDIT_ONLY", verificationScope: "GLOBAL_AUTHORIZED_EXTERNAL_RESOLUTIONS", dryRun, authoritativeSaleCases: 19, detailCasesBlocked: detailBlocked ?? 0, evidence });
  } catch (error) { return safeError(request, error); }
});
