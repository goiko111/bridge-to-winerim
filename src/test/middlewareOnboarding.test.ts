import { describe, expect, it } from "vitest";
import {
  buildTechnicalReviewPacket,
  buildInitialOnboardingGates,
  DEFAULT_REVO_BASE_URL,
  isReadyForTechnicalReview,
  normalizeOnboardingInput,
  normalizePosBaseUrl,
  sanitizeTechnicalReviewPacketPayload,
  validateOnboardingDestination,
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

  it("allows only explicitly configured onboarding destinations", () => {
    expect(validateOnboardingDestination(
      "http://pos.example.com:8984",
      ["pos.example.com"],
    )).toEqual({ allowed: true });
    expect(validateOnboardingDestination(
      "http://other.example.com:8984",
      ["pos.example.com"],
    )).toEqual({ allowed: false, reason: "HOST_NOT_ALLOWED" });
  });

  it("rejects credentials and local/private destinations", () => {
    expect(validateOnboardingDestination(
      "https://user:password@pos.example.com",
      ["pos.example.com"],
    )).toEqual({ allowed: false, reason: "CREDENTIALS_IN_URL" });
    expect(validateOnboardingDestination(
      "http://192.168.1.2:8984",
      ["192.168.1.2"],
    )).toEqual({ allowed: false, reason: "PRIVATE_DESTINATION" });
    expect(validateOnboardingDestination(
      "http://[::1]:8984",
      ["::1"],
    )).toEqual({ allowed: false, reason: "PRIVATE_DESTINATION" });
  });

  it("allows only the reviewed HTTP, HTTPS and Agora ports", () => {
    expect(validateOnboardingDestination(
      "http://pos.example.com:8984",
      ["pos.example.com"],
    )).toEqual({ allowed: true });
    expect(validateOnboardingDestination(
      "https://pos.example.com:9443",
      ["pos.example.com"],
    )).toEqual({ allowed: false, reason: "PORT_NOT_ALLOWED" });
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

  it("builds a technical review packet without leaking credentials", () => {
    const gates: OnboardingGate[] = [
      { id: "input", label: "Datos", status: "pass", detail: "OK" },
      { id: "winerim", label: "Winerim", status: "pass", detail: "OK" },
      { id: "pos", label: "Agora", status: "pass", detail: "OK" },
    ];
    const packet = buildTechnicalReviewPacket({
      provider: "agora",
      locationName: "Casa Test",
      posBaseUrl: "agora.test:8984",
      posApiToken: "secret-pos-token",
      winerimApiToken: "secret-winerim-token",
    }, gates, ["mapped-sale"]);
    const serialized = JSON.stringify(packet);

    expect(packet.readyForTechnicalReview).toBe(true);
    expect(packet.posBaseUrl).toBe("http://agora.test:8984");
    expect(packet.nextRequiredChecklistIds).toEqual(["mapped-sale"]);
    expect(serialized).not.toContain("secret-pos-token");
    expect(serialized).not.toContain("secret-winerim-token");
  });

  it("sanitizes persisted onboarding requests with a whitelist", () => {
    const result = sanitizeTechnicalReviewPacketPayload({
      reviewPacket: {
        provider: "revo",
        locationName: " Hotel Test ",
        posBaseUrl: "https://revo.example.com/v2/",
        revoTenant: " tenant ",
        posApiToken: "must-not-persist",
        winerimApiToken: "must-not-persist-either",
        readyForTechnicalReview: true,
        gateSummary: [
          { id: "pos", label: "REVO", status: "pass", detail: "OK", technicalDetail: "hidden" },
        ],
        nextRequiredChecklistIds: ["mapped-sale"],
      },
    });

    const serialized = JSON.stringify(result.reviewPacket);

    expect(result.valid).toBe(true);
    expect(result.reviewPacket?.provider).toBe("revo");
    expect(result.reviewPacket?.locationName).toBe("Hotel Test");
    expect(result.reviewPacket?.posBaseUrl).toBe("https://revo.example.com/v2");
    expect(result.reviewPacket?.gateSummary[0]).toEqual({ id: "pos", label: "REVO", status: "pass", detail: "OK" });
    expect(serialized).not.toContain("must-not-persist");
    expect(serialized).not.toContain("technicalDetail");
  });

  it("rejects persisted onboarding requests without a valid location or URL", () => {
    const result = sanitizeTechnicalReviewPacketPayload({ provider: "agora", locationName: "", posBaseUrl: "" });

    expect(result.valid).toBe(false);
    expect(result.reviewPacket).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
