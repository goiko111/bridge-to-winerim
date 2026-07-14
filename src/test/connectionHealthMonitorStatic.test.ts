import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/connection-health-monitor/index.ts"),
  "utf8",
);

describe("connection health alert correlation", () => {
  it("does not emit a breaker alert alongside the primary connectivity outage", () => {
    expect(source).toContain('if (isPaused && probe.status !== "DOWN")');
    expect(source).toContain("breakerOpen: Boolean(isPaused)");
    expect(source).toContain("consecutiveFailures: connection.consecutive_failures || 0");
  });
});
