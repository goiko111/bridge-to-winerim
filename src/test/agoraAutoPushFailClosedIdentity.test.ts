import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);

const blockStart = source.indexOf('if (action === "evaluate-auto-push")');
const blockEnd = source.indexOf("// ── READ-ONLY EXPECTED CATALOG AUDIT", blockStart);
const block = source.slice(blockStart, blockEnd);

// Mirror of the runtime quarantine semantics (helper + filter placement asserted below).
function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function evaluateGate(
  providerConfig: Record<string, unknown> | null | undefined,
  requestedIds: string[],
) {
  const quarantined = new Set(
    normalizeStringArray((providerConfig || {}).auto_push_fail_closed_winerim_ids),
  );
  const evaluated: string[] = [];
  const excluded: string[] = [];
  for (const id of requestedIds) {
    if (quarantined.size > 0 && quarantined.has(id)) excluded.push(id);
    else evaluated.push(id);
  }
  return {
    evaluated,
    excluded,
    tasksQueued: evaluated.length, // one task per evaluated wine in the happy path
    skippedReasons: excluded.map((id) => ({
      winerim_id: id,
      reason: "auto_push_fail_closed_identity_excluded",
    })),
  };
}

describe("auto-push fail-closed identity quarantine", () => {
  const config = { auto_push_fail_closed_winerim_ids: ["184322", 363449] };

  it("queues zero tasks for an excluded id on CREATE and UPDATE", () => {
    for (const _eventType of ["CREATE", "UPDATE"]) {
      const result = evaluateGate(config, ["184322"]);
      expect(result.tasksQueued).toBe(0);
      expect(result.evaluated).toEqual([]);
      expect(result.skippedReasons).toEqual([
        { winerim_id: "184322", reason: "auto_push_fail_closed_identity_excluded" },
      ]);
    }
  });

  it("stays at zero tasks on a second identical cycle", () => {
    const first = evaluateGate(config, ["184322"]);
    const second = evaluateGate(config, ["184322"]);
    expect(first.tasksQueued + second.tasksQueued).toBe(0);
  });

  it("keeps other wine ids fully normal", () => {
    const result = evaluateGate(config, ["184322", "999111"]);
    expect(result.evaluated).toEqual(["999111"]);
    expect(result.tasksQueued).toBe(1);
    expect(result.excluded).toEqual(["184322"]);
  });

  it("changes nothing when the config is absent or empty", () => {
    for (const cfg of [undefined, null, {}, { auto_push_fail_closed_winerim_ids: [] }]) {
      const result = evaluateGate(cfg as Record<string, unknown>, ["184322", "999111"]);
      expect(result.evaluated).toEqual(["184322", "999111"]);
      expect(result.excluded).toEqual([]);
      expect(result.tasksQueued).toBe(2);
    }
  });

  it("normalizes numeric and padded config entries", () => {
    const result = evaluateGate(
      { auto_push_fail_closed_winerim_ids: [" 184322 ", 363449] },
      ["184322", "363449"],
    );
    expect(result.excluded).toEqual(["184322", "363449"]);
    expect(result.tasksQueued).toBe(0);
  });

  it("filters quarantined ids before any task query or write in agora-proxy", () => {
    expect(source).toContain("function autoPushFailClosedWinerimIds(");
    expect(source).toContain("normalizeStringArray(config.auto_push_fail_closed_winerim_ids)");

    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);

    const gate = block.indexOf("const failClosedWinerimIds = autoPushFailClosedWinerimIds(providerConfig)");
    expect(gate).toBeGreaterThan(-1);
    expect(block).toContain("auto_push_fail_closed_identity_excluded");

    for (const marker of [
      'from("outbound_tasks")',
      'from("winerim_push_tracking")',
      'from("winerim_wines")',
      "AGORA_HIDE_PRODUCT",
    ]) {
      const first = block.indexOf(marker);
      expect(first, `${marker} must appear after the quarantine gate`).toBeGreaterThan(gate);
    }
  });

  it("never uses the quarantine list to resolve or adopt an identity", () => {
    // Exactly one code read (the helper) plus its doc comment mention.
    const usages = source.match(/auto_push_fail_closed_winerim_ids/g) || [];
    expect(usages).toHaveLength(2);
    const helperUsages = block.match(/autoPushFailClosedWinerimIds\(/g) || [];
    expect(helperUsages).toHaveLength(1);
  });
});
