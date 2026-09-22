export type ReviewDecision = {
  provider_product_id: string;
  sale_format: string;
  status: string;
  selected_winerim_id: string | null;
  selected_winerim_name: string | null;
  selected_format_key: string | null;
  force_ready: boolean | null;
  note: string | null;
  decided_at: string | null;
};

export type QtomasDecision = {
  provider_product_id: string;
  format_type: string;
  decision_status: string;
  selected_winerim_id: string | null;
  selected_winerim_name: string | null;
  note: string | null;
  updated_at: string;
};

export type UnmappedReviewRow = {
  provider_product_id: string;
  provider_product_name: string;
  family: string | null;
  sale_format: string;
  format_key: string;
  units: number | null;
  line_count: number | null;
  last_sale_at: string | null;
  agora_price: number | null;
  decision_status: string;
  selected_winerim_id: string | null;
  selected_winerim_name: string | null;
  selected_format_key: string | null;
  force_ready: boolean;
  note: string | null;
  decided_at: string | null;
  legacy: boolean;
  legacy_state: string | null;
};

export type LegacyReviewRow = {
  provider_product_id: string;
  name: string | null;
  family: string | null;
  sale_format: string;
  format_key: string;
  price: number | null;
  units_recent: number | null;
  last_sale_at: string | null;
  mapping_status: string | null;
  legacy_state: string;
};

const QTOMAS_STATUS: Record<string, string> = {
  PENDING: "DRAFT",
  READY_TO_APPLY: "READY_FOR_APPROVAL",
  DO_NOT_MAP: "NO_MATCH",
  NEEDS_CONFIRMATION: "NEEDS_CONFIRMATION",
};

export function unmappedFilterKey(connectionId: string): string {
  return `review.unmapped.filters.${connectionId}`;
}

function normalizedFormat(value: string | null | undefined): string {
  const format = (value ?? "").trim();
  return format || "SIN_DATO";
}

function rowKey(providerProductId: string, saleFormat: string | null | undefined): string {
  return `${providerProductId}::${normalizedFormat(saleFormat)}`;
}

function decisionFor(
  row: { provider_product_id: string; sale_format: string },
  decisions: Map<string, ReviewDecision>,
  qtomasDecisions: Map<string, QtomasDecision>,
): ReviewDecision | null {
  const exact = decisions.get(rowKey(row.provider_product_id, row.sale_format));
  if (exact) return exact;

  const qtomas = qtomasDecisions.get(row.provider_product_id);
  if (!qtomas) return null;
  return {
    provider_product_id: qtomas.provider_product_id,
    sale_format: qtomas.format_type,
    status: QTOMAS_STATUS[qtomas.decision_status] ?? "DRAFT",
    selected_winerim_id: qtomas.selected_winerim_id,
    selected_winerim_name: qtomas.selected_winerim_name,
    selected_format_key: qtomas.format_type || null,
    force_ready: false,
    note: qtomas.note,
    decided_at: qtomas.updated_at,
  };
}

export function mergeUnmappedReviewRows(input: {
  activity: Omit<UnmappedReviewRow, "legacy" | "legacy_state">[];
  legacy: LegacyReviewRow[];
  decisions?: ReviewDecision[];
  qtomasDecisions?: QtomasDecision[];
}): UnmappedReviewRow[] {
  const decisions = new Map(
    (input.decisions ?? []).map((row) => [rowKey(row.provider_product_id, row.sale_format), row]),
  );
  const qtomasDecisions = new Map(
    (input.qtomasDecisions ?? []).map((row) => [row.provider_product_id, row]),
  );
  const rows = new Map<string, UnmappedReviewRow>();
  const confirmedLegacyIds = new Set(
    input.legacy
      .filter((row) => row.mapping_status === "CONFIRMED")
      .map((row) => row.provider_product_id),
  );

  for (const row of input.activity) {
    if (confirmedLegacyIds.has(row.provider_product_id)) continue;
    const decision = decisionFor(row, decisions, qtomasDecisions);
    rows.set(rowKey(row.provider_product_id, row.sale_format), {
      ...row,
      sale_format: normalizedFormat(row.sale_format),
      decision_status: decision?.status ?? row.decision_status,
      selected_winerim_id: decision?.selected_winerim_id ?? row.selected_winerim_id,
      selected_winerim_name: decision?.selected_winerim_name ?? row.selected_winerim_name,
      selected_format_key: decision?.selected_format_key ?? row.selected_format_key,
      force_ready: decision?.force_ready ?? row.force_ready ?? false,
      note: decision?.note ?? row.note,
      decided_at: decision?.decided_at ?? row.decided_at,
      legacy: false,
      legacy_state: null,
    });
  }

  for (const legacy of input.legacy) {
    if (legacy.mapping_status === "CONFIRMED") continue;

    const saleFormat = normalizedFormat(legacy.sale_format);
    const key = rowKey(legacy.provider_product_id, saleFormat);
    let existing = rows.get(key);
    let existingKey = key;
    if (!existing && saleFormat === "SIN_DATO") {
      const sameProduct = [...rows.entries()].filter(([, row]) => row.provider_product_id === legacy.provider_product_id);
      if (sameProduct.length === 1) {
        [existingKey, existing] = sameProduct[0];
      }
    }
    if (existing) {
      rows.set(existingKey, { ...existing, legacy: true, legacy_state: legacy.legacy_state });
      continue;
    }

    const decision = decisionFor(
      { provider_product_id: legacy.provider_product_id, sale_format: saleFormat },
      decisions,
      qtomasDecisions,
    );
    rows.set(key, {
      provider_product_id: legacy.provider_product_id,
      provider_product_name: legacy.name ?? `Producto ${legacy.provider_product_id}`,
      family: legacy.family,
      sale_format: saleFormat,
      format_key: legacy.format_key || "SIN_DATO",
      units: legacy.units_recent,
      line_count: null,
      last_sale_at: legacy.last_sale_at,
      agora_price: legacy.price,
      decision_status: decision?.status ?? "DRAFT",
      selected_winerim_id: decision?.selected_winerim_id ?? null,
      selected_winerim_name: decision?.selected_winerim_name ?? null,
      selected_format_key: decision?.selected_format_key ?? null,
      force_ready: decision?.force_ready ?? false,
      note: decision?.note ?? null,
      decided_at: decision?.decided_at ?? null,
      legacy: true,
      legacy_state: legacy.legacy_state,
    });
  }

  return [...rows.values()].sort((left, right) => {
    const byUnits = (right.units ?? -1) - (left.units ?? -1);
    if (byUnits !== 0) return byUnits;
    return left.provider_product_name.localeCompare(right.provider_product_name, "es");
  });
}
