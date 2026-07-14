import { describe, expect, it } from "vitest";
import { isAgoraTimestampOldEnough } from "../../supabase/functions/_shared/agoraLocalTime";

describe("Agora local timestamps", () => {
  const now = Date.parse("2026-07-14T11:25:46Z");

  it("compares naive Agora timestamps in the restaurant timezone", () => {
    expect(isAgoraTimestampOldEnough("2026-07-14T12:31:09", 2, "Europe/Madrid", now)).toBe(true);
    expect(isAgoraTimestampOldEnough("2026-07-14T13:25:09", 2, "Europe/Madrid", now)).toBe(false);
  });

  it("uses absolute time when Agora includes an explicit timezone", () => {
    expect(isAgoraTimestampOldEnough("2026-07-14T11:20:00Z", 2, "Europe/Madrid", now)).toBe(true);
    expect(isAgoraTimestampOldEnough("2026-07-14T12:31:09Z", 2, "Europe/Madrid", now)).toBe(false);
  });

  it("keeps the previous permissive behavior for missing or unknown timestamps", () => {
    expect(isAgoraTimestampOldEnough(null, 2, "Europe/Madrid", now)).toBe(true);
    expect(isAgoraTimestampOldEnough("not-a-date", 2, "Europe/Madrid", now)).toBe(true);
    expect(isAgoraTimestampOldEnough("2026-07-14T13:25:45", 0, "Europe/Madrid", now)).toBe(true);
  });
});
