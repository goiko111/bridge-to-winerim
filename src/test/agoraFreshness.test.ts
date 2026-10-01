import { describe, expect, it } from "vitest";
import { agoraReadAfterClose } from "../../supabase/functions/_shared/reconciliation-v2/agoraFreshness";
const b = { metadata: { timezone: "Europe/Madrid", businessDayCutoffHour: 6 } };
describe("Ágora leído después del cierre", () => {
  it("Albariza: última lectura 23:55 UTC del 30 → incompleto", () => expect(agoraReadAfterClose(b, "2026-09-30", "2026-09-30T23:55:21Z").ok).toBe(false));
  it("Finca Eslava: lectura 05:37 UTC del 1-oct → completo", () => expect(agoraReadAfterClose(b, "2026-09-30", "2026-10-01T05:37:42Z").ok).toBe(true));
  it("justo en el cierre 04:00 UTC cuenta; sin lectura no", () => { expect(agoraReadAfterClose(b, "2026-09-30", "2026-10-01T04:00:00Z").ok).toBe(true); expect(agoraReadAfterClose(b, "2026-09-30", null).ok).toBe(false); });
});
