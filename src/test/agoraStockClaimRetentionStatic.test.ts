import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const agoraProxySource = readFileSync(
  resolve(repoRoot, "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);
const migrationSource = readFileSync(
  resolve(repoRoot, "supabase/migrations/20260716110655_preserve_stock_sync_log_on_sales_line_refresh.sql"),
  "utf8",
);

describe("Agora stock claim retention", () => {
  it("detaches durable claims before refreshing transient sales lines", () => {
    expect(agoraProxySource).toContain("replaceSalesEventLinesPreservingStockClaims");
    expect(agoraProxySource).toContain(".update({ sales_line_item_id: null })");
    expect(agoraProxySource).not.toContain(
      'from("sales_line_items").delete().eq("sales_event_id"',
    );
  });

  it("keeps stock sync logs when a sales line is deleted", () => {
    expect(migrationSource).toContain("ON DELETE SET NULL");
    expect(migrationSource).not.toContain("ON DELETE CASCADE");
  });
});
