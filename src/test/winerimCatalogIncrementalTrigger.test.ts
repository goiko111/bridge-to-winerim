import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNextCatalogFingerprintRow,
  computeWinerimCatalogFingerprint,
  decideCatalogChange,
} from "../../supabase/functions/_shared/winerimCatalogFingerprint";

const repoRoot = resolve(__dirname, "../..");
const winerimSource = readFileSync(resolve(repoRoot, "supabase/functions/winerim-proxy/index.ts"), "utf8");

type Row = Record<string, unknown>;

const baseRow: Row = {
  name: "Luis Cañas Reserva",
  is_active: true,
  region: "Rioja",
  wine_type: "tinto",
  vintage: "2019",
  serve_by_glass: true,
  bottle_sale_price: 25,
  glass_sale_price: 3.1,
  magnum_sale_price: null,
};

// Simulates one catalog pass: previous DB rows vs payloads about to be written.
function runPass(previousRows: Map<string, Row>, payloads: Map<string, Row>) {
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  for (const [id, payload] of payloads) {
    const previous = previousRows.get(id);
    const pricingReady = [payload.bottle_sale_price, payload.glass_sale_price, payload.magnum_sale_price]
      .some((p) => Number(p) > 0);
    const decision = decideCatalogChange({ previous, payload, pricingReady });
    if (decision.outcome === "new") created.push(id);
    else if (decision.outcome === "changed") updated.push(id);
    else if (decision.outcome === "skipped") skipped.push(id);
    // commit the write so the next pass compares against post-state
    previousRows.set(id, { ...(previous || {}), ...buildNextCatalogFingerprintRow(previous, payload) });
  }
  return { created, updated, skipped, evaluated: created.length + updated.length };
}

function catalog(count: number) {
  const previous = new Map<string, Row>();
  const payloads = new Map<string, Row>();
  for (let i = 0; i < count; i++) {
    const id = String(300000 + i);
    previous.set(id, { ...baseRow, name: `Wine ${i}` });
    payloads.set(id, { ...baseRow, name: `Wine ${i}` });
  }
  return { previous, payloads };
}

describe("winerim fetch-catalog incremental auto-push trigger", () => {
  it("evaluates nothing when 100 wines are identical", () => {
    const { previous, payloads } = catalog(100);
    const pass = runPass(previous, payloads);
    expect(pass.evaluated).toBe(0);
    expect(pass.created).toEqual([]);
    expect(pass.updated).toEqual([]);
  });

  it("evaluates only the wine whose bottle price went 25 -> 26", () => {
    const { previous, payloads } = catalog(100);
    payloads.set("300007", { ...baseRow, name: "Wine 7", bottle_sale_price: 26 });
    const pass = runPass(previous, payloads);
    expect(pass.updated).toEqual(["300007"]);
    expect(pass.created).toEqual([]);
  });

  it("evaluates only the new wine with BOTTLE + GLASS as CREATE", () => {
    const { previous, payloads } = catalog(10);
    payloads.set("363449", { ...baseRow, name: "Nuevo Rueda", bottle_sale_price: 26, glass_sale_price: 3.1 });
    const pass = runPass(previous, payloads);
    expect(pass.created).toEqual(["363449"]);
    expect(pass.updated).toEqual([]);
  });

  it("is idempotent: an identical second cycle evaluates nothing", () => {
    const { previous, payloads } = catalog(20);
    payloads.set("300003", { ...baseRow, name: "Wine 3", bottle_sale_price: 26 });
    expect(runPass(previous, payloads).evaluated).toBe(1);
    expect(runPass(previous, payloads).evaluated).toBe(0);
  });

  it("evaluates only the deactivated wine", () => {
    const { previous, payloads } = catalog(30);
    payloads.set("300011", { ...baseRow, name: "Wine 11", is_active: false });
    const pass = runPass(previous, payloads);
    expect(pass.updated).toEqual(["300011"]);
  });

  it("detects a detail-only price change in enrich mode even when list fields are equal", () => {
    const previous = new Map<string, Row>([["363449", { ...baseRow }]]);
    // enrich payload carries no region/vintage, only detail-derived prices
    const enrichPayload: Row = {
      name: baseRow.name,
      is_active: true,
      wine_type: "tinto",
      serve_by_glass: true,
      bottle_sale_price: 26,
      glass_sale_price: 3.1,
      magnum_sale_price: null,
    };
    const pass = runPass(previous, new Map([["363449", enrichPayload]]));
    expect(pass.updated).toEqual(["363449"]);
    // second identical enrich pass ⇒ nothing
    expect(runPass(previous, new Map([["363449", enrichPayload]])).evaluated).toBe(0);
  });

  it("ignores unstable fields (updated_at / raw_payload)", () => {
    const previous: Row = { ...baseRow, updated_at: "2026-08-20T10:00:00Z", raw_payload: { a: 1 } };
    const payload: Row = { ...baseRow, updated_at: "2026-08-21T10:00:00Z", raw_payload: { a: 2 } };
    expect(decideCatalogChange({ previous, payload, pricingReady: true }).outcome).toBe("unchanged");
  });

  it("fails closed when the fingerprint cannot be computed", () => {
    expect(computeWinerimCatalogFingerprint({ name: "" })).toBeNull();
    const decision = decideCatalogChange({
      previous: { ...baseRow },
      payload: { ...baseRow, name: "" },
      pricingReady: true,
    });
    expect(decision.outcome).toBe("skipped");
    expect(decision.reason).toBe("fingerprint_unavailable");
  });

  it("classifies exactly once per cycle, after detail, and drops the bulk backfill", () => {
    expect(winerimSource).toContain('from "../_shared/winerimCatalogFingerprint.ts"');
    // single classification point (post-detail), never after the list upsert
    expect(winerimSource.match(/classifyWineChange\(/g) || []).toHaveLength(2); // definition + 1 call
    expect(winerimSource).toContain("classifyWineChange(winerimId, previous, finalPayload");
    expect(winerimSource).toContain("preUpsertRows");
    expect(winerimSource).not.toContain("existingBeforeList");
    expect(winerimSource).not.toContain("readyProcessedIds");
    expect(winerimSource).not.toContain("hasRelevantCatalogChange");
    expect(winerimSource).toContain('reason: "no_source_changes_detected"');
    // DELETE reconciliation stays untouched
    expect(winerimSource).toContain('winerimWineIds: missingFromWinerim, eventType: "DELETE"');
  });
});

// ── Regression for the live defect: sparse list payload vs full detail row ──
// mode=start writes a list row without prices, then the detail update restores
// them. Classifying twice (or once against the post-list state) made an
// unchanged wine look changed and queued 27 tasks on Ponzano.
describe("sparse-list / full-detail oscillation", () => {
  const enrichedRow: Row = { ...baseRow, name: "Mauro VS", region: "Castilla y León", vintage: "2019" };
  // what the list upsert would persist: no prices, no vintage/type detail
  const sparseListPayload: Row = {
    name: "Mauro VS",
    region: "Castilla y León",
    vintage: "2019",
    is_active: true,
    serve_by_glass: false,
  };
  // what the detail update writes afterwards (authoritative prices)
  const detailPayload: Row = {
    name: "Mauro VS",
    is_active: true,
    serve_by_glass: true,
    wine_type: "tinto",
    bottle_sale_price: 25,
    glass_sale_price: 3.1,
    magnum_sale_price: null,
  };

  // Emulates the fixed cycle: previous = PRE-upsert row, payload = list+detail.
  function fixedStartCycle(previous: Row | undefined) {
    return decideCatalogChange({
      previous,
      payload: { ...sparseListPayload, ...detailPayload },
      pricingReady: true,
    });
  }

  it("would have oscillated with the old post-list classification", () => {
    const listStep = decideCatalogChange({ previous: enrichedRow, payload: sparseListPayload, pricingReady: false });
    expect(listStep.outcome).toBe("changed"); // the live defect
  });

  it("is unchanged once classified against the final list+detail state", () => {
    expect(fixedStartCycle(enrichedRow).outcome).toBe("unchanged");
  });

  it("still detects a real price change on the final state", () => {
    const changed = decideCatalogChange({
      previous: enrichedRow,
      payload: { ...sparseListPayload, ...detailPayload, bottle_sale_price: 26 },
      pricingReady: true,
    });
    expect(changed.outcome).toBe("changed");
  });

  it("treats a brand-new wine as CREATE only with an exportable final state", () => {
    expect(fixedStartCycle(undefined).outcome).toBe("new");
    expect(
      decideCatalogChange({
        previous: undefined,
        payload: { ...sparseListPayload, ...detailPayload, bottle_sale_price: null, glass_sale_price: null },
        pricingReady: false,
      }).outcome,
    ).toBe("skipped");
  });

  it("runs two identical 100-wine start cycles with zero evaluations", () => {
    const stored = new Map<string, Row>();
    for (let i = 0; i < 100; i++) stored.set(String(400000 + i), { ...enrichedRow, name: `Wine ${i}` });

    const runCycle = () => {
      let evaluated = 0;
      for (const [id, previous] of stored) {
        const decision = decideCatalogChange({
          previous,
          payload: { ...sparseListPayload, ...detailPayload, name: `Wine ${id.slice(-2) === "00" ? 0 : Number(id) - 400000}` },
          pricingReady: true,
        });
        if (decision.outcome === "new" || decision.outcome === "changed") evaluated++;
        stored.set(id, {
          ...previous,
          ...buildNextCatalogFingerprintRow(previous, { ...sparseListPayload, ...detailPayload, name: previous.name }),
        });
      }
      return evaluated;
    };

    expect(runCycle()).toBe(0);
    expect(runCycle()).toBe(0);
  });
});
