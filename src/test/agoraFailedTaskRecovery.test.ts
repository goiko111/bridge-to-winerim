import { describe, expect, it } from "vitest";
import {
  isRecoverableTaskError,
  selectTasksToRequeue,
} from "../../supabase/functions/_shared/agoraFailedTaskRecovery";

describe("isRecoverableTaskError", () => {
  it("recovers infrastructure failures", () => {
    expect(isRecoverableTaskError("[POS_UNREACHABLE] error sending request")).toBe(true);
    expect(isRecoverableTaskError("[POS_OVERLOADED] HTTP 503")).toBe(true);
    expect(isRecoverableTaskError("connect: No route to host (os error 113)")).toBe(true);
    expect(isRecoverableTaskError("HTTP 530: cloudflare tunnel error")).toBe(true);
    expect(isRecoverableTaskError("request timed out after 30000ms")).toBe(true);
  });

  it("never recovers business rejections", () => {
    expect(
      isRecoverableTaskError(
        "[POS_OVERLOADED] HTTP 500: El producto 1663/MACAN CLASICO tiene asociado un formato base que no coincide con el indicado.",
      ),
    ).toBe(false);
    expect(isRecoverableTaskError("[BUSINESS_ERROR] ya existe un producto con ese Id")).toBe(false);
    expect(isRecoverableTaskError("[AUTH_ERROR] HTTP 401 unauthorized")).toBe(false);
    expect(isRecoverableTaskError("variant 'copa' not found for wine 123")).toBe(false);
  });

  it("fails closed on empty or unknown-shaped errors", () => {
    expect(isRecoverableTaskError(null)).toBe(false);
    expect(isRecoverableTaskError("")).toBe(false);
    expect(isRecoverableTaskError("something odd happened")).toBe(false);
  });
});

describe("selectTasksToRequeue", () => {
  const rows = [
    { id: "a", status: "FAILED", last_error: "[POS_UNREACHABLE] error sending request" },
    { id: "b", status: "FAILED", last_error: "[BUSINESS_ERROR] no coincide el formato base" },
    { id: "c", status: "BLOCKED", last_error: "[POS_UNREACHABLE] error sending request" },
    { id: "d", status: "FAILED", last_error: "connection refused" },
    { id: "e", status: "QUEUED", last_error: null },
  ];

  it("picks only recoverable FAILED tasks", () => {
    expect(selectTasksToRequeue(rows)).toEqual(["a", "d"]);
  });

  it("respects the batch limit", () => {
    expect(selectTasksToRequeue(rows, 1)).toEqual(["a"]);
  });
});
