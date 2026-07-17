import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "scripts/reconcile-agora-catalog.mjs"),
  "utf8",
);

describe("Agora controlled catalog reconciliation", () => {
  it("releases occupied base names before assigning their final owners", () => {
    expect(source).toContain("const transitionPriority = (item) =>");
    expect(source).toContain('expectedName.startsWith(`${actualName} `)');
    expect(source).toContain('actualName.startsWith(`${expectedName} `)');
    expect(source).toContain("transitionPriority(left) - transitionPriority(right)");
  });
});
