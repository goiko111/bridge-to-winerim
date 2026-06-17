import { describe, expect, it } from "vitest";
import {
  buildInitialOnboardingGates,
  DEFAULT_REVO_BASE_URL,
  isReadyForTechnicalReview,
  normalizeOnboardingInput,
  normalizePosBaseUrl,
  validateCommercialOnboardingInput,
  type OnboardingGate,
} from "@/lib/middlewareOnboarding";

describe("middleware commercial onboarding", () => {
  it("adds http:// to POS URLs when commercial users paste host:port", () => {
    expect(normalizePosBaseUrl("eljardiparets.ddns.net:8984/")).toBe("http://eljardiparets.ddns.net:8984");
  });

  it("preserves https URLs and removes trailing slash", () => {
    expect(normalizePosBaseUrl("https://api.revo.works/v2/")).toBe("https://api.revo.works/v2");
  });

  it("defaults to Agora and trims input", () => {
    const normalized = normalizeOnboardingInput({
      locationName: "  Casa Test  ",
      posBaseUrl: " example.com:8984 ",
      posApiToken: " token ",
      revoTenant: " ignored ",
      revoClientToken: " ignored ",
      winerimApiToken: " winerim ",
    });

    expect(normalized.provider).toBe("agora");
    expect(normalized.locationName).toBe("Casa Test");
    expect(normalized.posBaseUrl).toBe("http://example.com:8984");
    expect(normalized.posApiToken).toBe("token");
    expect(normalized.revoTenant).toBe("ignored");
    expect(normalized.revoClientToken).toBe("ignored");
    expect(normalized.winerimApiToken).toBe("winerim");
  });

  it("defaults REVO base URL and trims REVO-specific credentials", () => {
    const normalized = normalizeOnboardingInput({
      provider: "revo",
      locationName: "Hotel Test",
      posApiToken: " access ",
      revoTenant: " tenant ",
      revoClientToken: " client ",
      winerimApiToken: " winerim ",
    });

    expect(normalized.provider).toBe("revo");
    expect(normalized.posBaseUrl).toBe(DEFAULT_REVO_BASE_URL);
    expect(normalized.posApiToken).toBe("access");
    expect(normalized.revoTenant).toBe("tenant");
    expect(normalized.revoClientToken).toBe("client");
  });

  it("returns field errors for missing required values", () => {
    const result = validateCommercialOnboardingInput({});

    expect(result.valid).toBe(false);
    expect(result.errors.locationName).toBeTruthy();
    expect(result.errors.posBaseUrl).toBeTruthy();
    expect(result.errors.posApiToken).toBeTruthy();
    expect(result.errors.winerimApiToken).toBeTruthy();
  });

  it("requires tenant and client-token for REVO onboarding", () => {
    const result = validateCommercialOnboardingInput({
      provider: "revo",
      locationName: "Hotel Test",
      posApiToken: "access",
      winerimApiToken: "winerim",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.revoTenant).toBeTruthy();
    expect(result.errors.revoClientToken).toBeTruthy();
    expect(result.errors.posBaseUrl).toBeFalsy();
  });

  it("builds blocked gates before external tests run", () => {
    const gates = buildInitialOnboardingGates({
      provider: "agora",
      locationName: "Casa Test",
      posBaseUrl: "example.com:8984",
      posApiToken: "pos",
      winerimApiToken: "winerim",
    });

    expect(gates.find((gate) => gate.id === "input")?.status).toBe("pass");
    expect(gates.find((gate) => gate.id === "winerim")?.status).toBe("blocked");
    expect(gates.find((gate) => gate.id === "pos")?.status).toBe("blocked");
    expect(gates.find((gate) => gate.id === "write")?.status).toBe("blocked");
  });

  it("marks a connection ready for technical review only when input, Winerim and POS pass or warn", () => {
    const good: OnboardingGate[] = [
      { id: "input", label: "Datos", status: "pass", detail: "" },
      { id: "winerim", label: "Winerim", status: "pass", detail: "" },
      { id: "pos", label: "Agora", status: "warn", detail: "" },
      { id: "write", label: "Escritura", status: "blocked", detail: "" },
    ];
    const bad: OnboardingGate[] = [
      ...good.slice(0, 2),
      { id: "pos", label: "Agora", status: "fail", detail: "" },
      good[3],
    ];

    expect(isReadyForTechnicalReview(good)).toBe(true);
    expect(isReadyForTechnicalReview(bad)).toBe(false);
  });
});
