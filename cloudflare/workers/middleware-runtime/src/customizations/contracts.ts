export const CUSTOMIZATION_SCHEMA_VERSION = "1.0.0" as const;

export type CustomizationState = "ACTIVE" | "DOCUMENTED" | "PENDING_APPROVAL";
export type CustomizationRuleKind =
  | "CATALOG_HIERARCHY"
  | "PRESENTATION"
  | "VARIANT_SCHEDULER"
  | "VINTAGE_NAMING"
  | "ACTIVATION_GUARD";

export interface CustomizationRule {
  id: string;
  kind: CustomizationRuleKind;
  state: CustomizationState;
  config: Record<string, unknown>;
  failClosedOn: string[];
  telemetry: {
    event: string;
    dimensions: string[];
  };
}

export interface IntegrationCustomization {
  schemaVersion: typeof CUSTOMIZATION_SCHEMA_VERSION;
  profileId: string;
  version: string;
  connectionId: string;
  locationName: string;
  provider: string;
  owner: {
    team: string;
    runbook: string;
  };
  rules: CustomizationRule[];
}

export interface RegistryValidationResult {
  ok: boolean;
  errors: string[];
}
