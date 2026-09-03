import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CUSTOMIZATION_REGISTRY,
  customizationForConnection,
  customizationTelemetryContext,
  validateIntegrationCustomizationRegistry,
} from "./registry";

describe("integration customization registry", () => {
  it("validates every registered connection and rule", () => {
    expect(validateIntegrationCustomizationRegistry()).toEqual({ ok: true, errors: [] });
  });

  it("keeps customizations unique by connection", () => {
    const ids = INTEGRATION_CUSTOMIZATION_REGISTRY.map((entry) => entry.connectionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves Don Bernardo without enabling Parker or automatic legacy mutation", () => {
    const profile = customizationForConnection("79280cb8-0fe7-4a57-93a4-04172205ac70");
    expect(profile?.profileId).toBe("don-bernardo-santander-vinoteca");
    expect(profile?.rules[0].config.parkerMarkers).toBe("DISABLED_PENDING_APPROVAL");
    expect(profile?.rules[0].config.legacyMutation).toBe("SEPARATE_APPROVAL_GATE");
  });

  it("keeps Albariza bottle, glass and magnum in the fleet payload contract", () => {
    const profile = customizationForConnection("89fc3241-ed1e-41b6-aee0-7fe8398c476c");
    expect(profile?.rules[0].config.formats).toEqual(["BOTTLE", "GLASS", "MAGNUM"]);
  });

  it("exposes stable telemetry dimensions without credentials", () => {
    const profile = INTEGRATION_CUSTOMIZATION_REGISTRY[0];
    expect(customizationTelemetryContext(profile)).toEqual({
      profileId: profile.profileId,
      profileVersion: profile.version,
      schemaVersion: profile.schemaVersion,
      ownerTeam: "middleware-winerim",
    });
  });
});
