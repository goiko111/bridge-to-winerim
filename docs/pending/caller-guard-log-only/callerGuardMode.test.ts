import { describe, expect, it } from "vitest";
import { applyCallerGuard, buildCallerLog, callerGuardMode } from "./callerGuardMode";

const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });
const CID = "57e8acbe-0000-4000-8000-000000000000";

describe("control de llamante en modo solo registro", () => {
  it("por defecto es log_only; solo 'enforce' bloquea", () => {
    expect(callerGuardMode(undefined)).toBe("log_only");
    expect(callerGuardMode("ENFORCE")).toBe("log_only");
    expect(callerGuardMode("enforce")).toBe("enforce");
  });

  it("log_only: un rechazo se registra como wouldBlock pero deja pasar", () => {
    const lines: string[] = [];
    const e = buildCallerLog("agora-proxy", "sync", CID, { ok: false, status: 401, code: "MISSING_AUTH" }, "log_only", h({ origin: "https://x.lovable.app" }));
    expect(applyCallerGuard(e, (s) => lines.push(s))).toBe(false);
    const j = JSON.parse(lines[0]);
    expect(j).toMatchObject({ tag: "CALLER_GUARD", fn: "agora-proxy", action: "sync", callerKind: "rejected", code: "MISSING_AUTH", wouldBlock: true, blocked: false, origin: "https://x.lovable.app" });
  });

  it("enforce: el mismo rechazo bloquea", () => {
    const e = buildCallerLog("winerim-proxy", "x", CID, { ok: false, status: 403, code: "CONNECTION_FORBIDDEN" }, "enforce", h({}));
    expect(applyCallerGuard(e, () => {})).toBe(true);
  });

  it("llamada interna: se registra el tipo, nunca la clave", () => {
    const lines: string[] = [];
    const secret = "sb_secret_ABC";
    const e = buildCallerLog("agora-proxy", "cron", CID, { ok: true, kind: "internal" }, "enforce", h({ authorization: `Bearer ${secret}` }));
    expect(applyCallerGuard(e, (s) => lines.push(s))).toBe(false);
    expect(lines[0]).not.toContain(secret);
    expect(JSON.parse(lines[0]).callerKind).toBe("internal");
  });
});
