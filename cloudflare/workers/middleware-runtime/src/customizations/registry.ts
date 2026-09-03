import {
  CUSTOMIZATION_SCHEMA_VERSION,
  type CustomizationRule,
  type IntegrationCustomization,
  type RegistryValidationResult,
} from "./contracts";

const RUNBOOK = "docs/operations/integration-customization-registry.md";
const TEAM = "middleware-winerim";

function rule(
  id: string,
  kind: CustomizationRule["kind"],
  state: CustomizationRule["state"],
  config: Record<string, unknown>,
  failClosedOn: string[],
): CustomizationRule {
  return {
    id,
    kind,
    state,
    config,
    failClosedOn,
    telemetry: {
      event: "integration.customization.evaluated",
      dimensions: ["connectionId", "profileId", "profileVersion", "ruleId", "outcome"],
    },
  };
}

const donBernardoHierarchy = rule(
  "vinoteca-region-reference-format-v1",
  "CATALOG_HIERARCHY",
  "ACTIVE",
  {
    rootFamilyName: "VINOTECA ABIERTA",
    hierarchy: ["REGION", "REFERENCE", "FORMAT"],
    regionSource: "WINERIM_EXACT",
    dynamicRegions: true,
    formats: "ALL_ACTIVE_WINERIM_VARIANTS",
    parkerMarkers: "DISABLED_PENDING_APPROVAL",
    legacyMutation: "SEPARATE_APPROVAL_GATE",
    productIdentity: "WINERIM_ID_PLUS_FORMAT",
    targetSloMinutes: 5,
  },
  ["missing_region", "missing_format", "missing_price", "ambiguous_identity"],
);

export const INTEGRATION_CUSTOMIZATION_REGISTRY: readonly IntegrationCustomization[] = [
  {
    schemaVersion: CUSTOMIZATION_SCHEMA_VERSION,
    profileId: "don-bernardo-ponzano-vinoteca",
    version: "1.0.0",
    connectionId: "a700d425-9194-4758-95ff-7fee86419e14",
    locationName: "Don Bernardo Ponzano",
    provider: "agora",
    owner: { team: TEAM, runbook: RUNBOOK },
    rules: [donBernardoHierarchy],
  },
  {
    schemaVersion: CUSTOMIZATION_SCHEMA_VERSION,
    profileId: "don-bernardo-santander-vinoteca",
    version: "1.0.0",
    connectionId: "79280cb8-0fe7-4a57-93a4-04172205ac70",
    locationName: "Don Bernardo Santander",
    provider: "agora",
    owner: { team: TEAM, runbook: RUNBOOK },
    rules: [donBernardoHierarchy],
  },
  {
    schemaVersion: CUSTOMIZATION_SCHEMA_VERSION,
    profileId: "el-porton-presentation",
    version: "1.0.0",
    connectionId: "a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2",
    locationName: "El Porton de Sorni",
    provider: "agora",
    owner: { team: TEAM, runbook: RUNBOOK },
    rules: [
      rule(
        "wine-type-geography-colors-v1",
        "PRESENTATION",
        "ACTIVE",
        {
          familyStructureMode: "WINE_TYPE_SPAIN_DO_FOREIGN_COUNTRY",
          sortMode: "ALPHABETICAL_WINE_NAME",
          buttonTextMode: "WINE_NAME_WITH_FORMAT_SUFFIX",
          colors: {
            tinto: "#800040",
            blanco: "#FFFFFF",
            rosado: "#DC82EF",
            espumoso: "#FF8080",
            dulce: "#F5A623",
            fortificado: "#F1C097",
          },
          legacyMutation: "PRESERVE",
        },
        ["missing_wine_type", "missing_geography", "unverified_ownership"],
      ),
    ],
  },
  {
    schemaVersion: CUSTOMIZATION_SCHEMA_VERSION,
    profileId: "katsu-glass-color-blocks",
    version: "1.0.0",
    connectionId: "982f1e63-5f15-48b8-b35f-037eafd4593e",
    locationName: "Katsu Izakaya",
    provider: "agora",
    owner: { team: TEAM, runbook: RUNBOOK },
    rules: [
      rule(
        "glass-color-blocks-v1",
        "PRESENTATION",
        "ACTIVE",
        {
          familyId: "901954",
          familyName: "COPAS WINERIM",
          preserveExistingOrder: true,
          colorBlockOrder: ["blanco", "rosado", "tinto", "espumoso", "fortificado", "dulce"],
          colors: {
            tinto: "#800040",
            blanco: "#FFFFFF",
            rosado: "#DC82EF",
            espumoso: "#FF8080",
            dulce: "#F5A623",
            fortificado: "#F1C097",
          },
        },
        ["missing_wine_type", "product_outside_verified_glass_scope"],
      ),
    ],
  },
  {
    schemaVersion: CUSTOMIZATION_SCHEMA_VERSION,
    profileId: "purosushi-vintage-labels",
    version: "1.0.0",
    connectionId: "e14e2264-e51d-490b-a895-7dc70a36b8cc",
    locationName: "PurOsushi",
    provider: "agora",
    owner: { team: TEAM, runbook: RUNBOOK },
    rules: [
      rule(
        "vintage-label-allowlist-v1",
        "VINTAGE_NAMING",
        "ACTIVE",
        {
          mode: "VISIBLE_VINTAGE_ON_COLLISION",
          productIdAllowlist: ["710280", "713744", "713873", "713874"],
          fallback: "STABLE_TECHNICAL_ID_SUFFIX",
          mappingIdentity: "WINERIM_ID_PLUS_FORMAT",
        },
        ["missing_vintage", "duplicate_visible_label", "product_not_allowlisted"],
      ),
    ],
  },
  {
    schemaVersion: CUSTOMIZATION_SCHEMA_VERSION,
    profileId: "albariza-all-active-formats",
    version: "1.0.0",
    connectionId: "89fc3241-ed1e-41b6-aee0-7fe8398c476c",
    locationName: "Albariza",
    provider: "agora",
    owner: { team: TEAM, runbook: RUNBOOK },
    rules: [
      rule(
        "fleet-all-active-formats-v1",
        "VARIANT_SCHEDULER",
        "ACTIVE",
        {
          producer: "fleet",
          formats: ["BOTTLE", "GLASS", "MAGNUM"],
          includeOnlyPositivePrice: true,
          targetSloMinutes: 5,
          secondCycleMustBeIdempotent: true,
        },
        ["missing_price", "unsupported_format", "provider_readback_missing"],
      ),
    ],
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER = /^\d+\.\d+\.\d+$/;
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateIntegrationCustomizationRegistry(
  entries: readonly IntegrationCustomization[] = INTEGRATION_CUSTOMIZATION_REGISTRY,
): RegistryValidationResult {
  const errors: string[] = [];
  const connections = new Set<string>();
  const profiles = new Set<string>();

  for (const entry of entries) {
    const label = entry.profileId || entry.connectionId || "unknown-profile";
    if (entry.schemaVersion !== CUSTOMIZATION_SCHEMA_VERSION) errors.push(`${label}: unsupported schemaVersion`);
    if (!IDENTIFIER.test(entry.profileId)) errors.push(`${label}: invalid profileId`);
    if (!SEMVER.test(entry.version)) errors.push(`${label}: invalid version`);
    if (!UUID.test(entry.connectionId)) errors.push(`${label}: invalid connectionId`);
    if (!entry.locationName.trim()) errors.push(`${label}: locationName is required`);
    if (!entry.owner.team.trim() || !entry.owner.runbook.trim()) errors.push(`${label}: owner is incomplete`);
    if (connections.has(entry.connectionId)) errors.push(`${label}: duplicate connectionId`);
    if (profiles.has(entry.profileId)) errors.push(`${label}: duplicate profileId`);
    connections.add(entry.connectionId);
    profiles.add(entry.profileId);

    const ruleIds = new Set<string>();
    for (const item of entry.rules) {
      if (!IDENTIFIER.test(item.id)) errors.push(`${label}/${item.id}: invalid rule id`);
      if (ruleIds.has(item.id)) errors.push(`${label}/${item.id}: duplicate rule id`);
      if (item.failClosedOn.length === 0) errors.push(`${label}/${item.id}: failClosedOn must not be empty`);
      if (!item.telemetry.event || item.telemetry.dimensions.length === 0) {
        errors.push(`${label}/${item.id}: telemetry contract is incomplete`);
      }
      if (item.kind === "CATALOG_HIERARCHY") {
        if (item.config.rootFamilyName !== "VINOTECA ABIERTA") {
          errors.push(`${label}/${item.id}: catalog hierarchy root must be VINOTECA ABIERTA`);
        }
        if (!Array.isArray(item.config.hierarchy)) errors.push(`${label}/${item.id}: hierarchy must be an array`);
      }
      if (item.kind === "VARIANT_SCHEDULER" && !Array.isArray(item.config.formats)) {
        errors.push(`${label}/${item.id}: formats must be an array`);
      }
      if (item.kind === "VINTAGE_NAMING" && !Array.isArray(item.config.productIdAllowlist)) {
        errors.push(`${label}/${item.id}: productIdAllowlist must be an array`);
      }
      ruleIds.add(item.id);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function customizationForConnection(connectionId: string): IntegrationCustomization | null {
  return INTEGRATION_CUSTOMIZATION_REGISTRY.find((entry) => entry.connectionId === connectionId) ?? null;
}

export function customizationTelemetryContext(entry: IntegrationCustomization): Record<string, string> {
  return {
    profileId: entry.profileId,
    profileVersion: entry.version,
    schemaVersion: entry.schemaVersion,
    ownerTeam: entry.owner.team,
  };
}
