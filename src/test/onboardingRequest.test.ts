import { describe, expect, it } from "vitest";
import {
  buildOnboardingRequestPayload,
  canTransitionOnboardingRequestStatus,
  isOnboardingRequestStatus,
  redactKnownSecretValues,
  sanitizeOnboardingGates,
  sanitizeOnboardingInput,
  summarizeOnboardingGates,
} from "@/lib/onboardingRequest";
import type { OnboardingGate } from "@/lib/middlewareOnboarding";

const gates: OnboardingGate[] = [
  { id: "input", label: "Datos", status: "pass", detail: "OK", technicalDetail: "raw detail" },
  { id: "winerim", label: "Winerim", status: "pass", detail: "OK", technicalDetail: "raw detail" },
  { id: "pos", label: "REVO", status: "warn", detail: "HTTP 429", technicalDetail: "raw detail" },
  { id: "write", label: "Escritura", status: "blocked", detail: "No writes" },
];

describe("onboarding request payloads", () => {
  it("sanitizes REVO input without leaking tokens", () => {
    const input = {
      provider: "revo" as const,
      locationName: " Hotel Demo ",
      posApiToken: "secret-access-token",
      revoTenant: " tenant-demo ",
      revoClientToken: "secret-client-token",
      revoWebhookSecret: "secret-webhook",
      winerimApiToken: "secret-winerim-token",
    };

    const sanitized = sanitizeOnboardingInput(input);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toMatchObject({
      provider: "revo",
      locationName: "Hotel Demo",
      posBaseUrl: "https://revoxef.works/api/external",
      revoTenant: "tenant-demo",
      posAuthProvided: true,
      winerimAuthProvided: true,
      revoClientAuthProvided: true,
      revoWebhookConfigured: true,
    });
    expect(serialized).not.toContain("secret-access-token");
    expect(serialized).not.toContain("secret-client-token");
    expect(serialized).not.toContain("secret-webhook");
    expect(serialized).not.toContain("secret-winerim-token");
  });

  it("removes technical details from stored gates", () => {
    const sanitized = sanitizeOnboardingGates(gates);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized[0]).toEqual({ id: "input", label: "Datos", status: "pass", detail: "OK" });
    expect(serialized).not.toContain("raw detail");
    expect(serialized).not.toContain("technicalDetail");
  });

  it("summarizes gate statuses and readiness", () => {
    expect(summarizeOnboardingGates(gates)).toEqual({
      readyForTechnicalReview: true,
      pass: 2,
      warn: 1,
      fail: 0,
      blocked: 1,
    });
  });

  it("builds a request payload without raw secrets", () => {
    const payload = buildOnboardingRequestPayload({
      provider: "agora",
      locationName: "Casa Demo",
      posBaseUrl: "demo.example.test:8984",
      posApiToken: "secret-pos-token",
      winerimApiToken: "secret-winerim-token",
    }, [
      ...gates,
      { id: "pos-secret", label: "POS", status: "warn", detail: "Saw secret-pos-token in upstream body" },
    ]);
    const serialized = JSON.stringify(payload);

    expect(payload.provider).toBe("agora");
    expect(payload.posBaseUrl).toBe("http://demo.example.test:8984");
    expect(payload.testSummary.readyForTechnicalReview).toBe(true);
    expect(serialized).not.toContain("secret-pos-token");
    expect(serialized).not.toContain("secret-winerim-token");
  });

  it("redacts known secret values from request details", () => {
    expect(redactKnownSecretValues("bad secret-client-token value", {
      provider: "revo",
      revoClientToken: "secret-client-token",
    })).toBe("bad [redacted] value");
  });

  it("shares the onboarding request status machine across UI and worker", () => {
    expect(isOnboardingRequestStatus("READY_FOR_TECHNICAL_REVIEW")).toBe(true);
    expect(isOnboardingRequestStatus("AUTO_CREATE_CONNECTION")).toBe(false);

    expect(canTransitionOnboardingRequestStatus("TESTED", "TECHNICAL_REVIEW")).toBe(true);
    expect(canTransitionOnboardingRequestStatus("TESTED", "CONVERTED")).toBe(false);
    expect(canTransitionOnboardingRequestStatus("APPROVED", "CONVERTED")).toBe(true);
    expect(canTransitionOnboardingRequestStatus("CONVERTED", "TECHNICAL_REVIEW")).toBe(false);
  });
});
