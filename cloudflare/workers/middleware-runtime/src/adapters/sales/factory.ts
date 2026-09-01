import { sql } from "../../../../middleware-api/src/db";
import {
  handleSalesRun,
  type ProviderSalesDocument,
  type SalesRunKind,
} from "../../handlers/sales";
import { createPostgresSalesAdapter } from "./postgres";
import type {
  PrepareSalesRunInput,
  PreparedSalesRun,
  SalesConnectionContext,
  SalesCursorPreparation,
  SalesPreparationDependencies,
  SalesPreparationFactory,
} from "./ports";
import type { ExactSalesMapping, PostgresSalesAdapter } from "./types";

type ConnectionRow = {
  id: unknown;
  location_name: unknown;
  provider: unknown;
  enabled: unknown;
  sync_mode: unknown;
  sync_frequency_minutes: unknown;
  last_business_day_synced: unknown;
  provider_config: unknown;
};

const SENSITIVE_CONFIG_KEY = /(token|secret|password|authorization|api[_-]?key|credential)/i;

export class SalesPreparationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SalesPreparationError";
  }
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function boolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes"].includes(text(value).toLowerCase());
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function sanitizeConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeConfig);
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_CONFIG_KEY.test(key)) continue;
    sanitized[key] = sanitizeConfig(child);
  }
  return sanitized;
}

function connectionFromRow(row: ConnectionRow): SalesConnectionContext {
  return {
    id: text(row.id),
    locationName: text(row.location_name),
    provider: text(row.provider),
    enabled: boolean(row.enabled),
    syncMode: text(row.sync_mode),
    syncFrequencyMinutes: number(row.sync_frequency_minutes),
    lastBusinessDaySynced: text(row.last_business_day_synced).slice(0, 10) || null,
    providerConfig: sanitizeConfig(object(row.provider_config)) as Record<string, unknown>,
  };
}

function configFlag(connection: SalesConnectionContext, key: string): boolean {
  return boolean(connection.providerConfig[key]);
}

function assertRunEnabled(connection: SalesConnectionContext, input: PrepareSalesRunInput): void {
  if (input.dryRun) return;
  if (!connection.enabled) throw new SalesPreparationError("SALES_CONNECTION_DISABLED");
  if (input.runKind === "INTRADAY" && !configFlag(connection, "intraday_sales_sync_enabled")) {
    throw new SalesPreparationError("SALES_INTRADAY_SYNC_DISABLED");
  }
  if (input.runKind === "OPEN_TICKET") {
    if (!configFlag(connection, "open_tickets_sync_enabled")) {
      throw new SalesPreparationError("SALES_OPEN_TICKETS_SYNC_DISABLED");
    }
    if (
      input.openTicketPolicy === "PROVISIONAL_STOCK"
      && !configFlag(connection, "open_tickets_stock_sync_enabled")
    ) {
      throw new SalesPreparationError("SALES_OPEN_TICKETS_STOCK_SYNC_DISABLED");
    }
  }
}

function assertSourceScope(
  connection: SalesConnectionContext,
  documents: ProviderSalesDocument[],
): void {
  for (const document of documents) {
    if (document.provider !== connection.provider) {
      throw new SalesPreparationError("SALES_SOURCE_PROVIDER_SCOPE_MISMATCH");
    }
  }
}

function providerProductIds(documents: ProviderSalesDocument[]): string[] {
  return Array.from(new Set(
    documents.flatMap((document) => document.lines.map((line) => line.providerProductId))
      .map(String)
      .filter(Boolean),
  )).sort();
}

function mappingPreparation(
  requestedProviderProductIds: string[],
  exactMappings: ExactSalesMapping[],
) {
  const mapped = new Set(exactMappings.map((mapping) => mapping.providerProductId));
  return {
    requestedProviderProductIds,
    exactMappings,
    mappedProviderProductIds: requestedProviderProductIds.filter((id) => mapped.has(id)),
    unmappedProviderProductIds: requestedProviderProductIds.filter((id) => !mapped.has(id)),
  };
}

function cursorPreparation(
  adapter: PostgresSalesAdapter,
  runKind: SalesRunKind,
  documents: ProviderSalesDocument[],
): SalesCursorPreparation {
  if (runKind === "HISTORICAL") {
    return {
      executable: false,
      reason: "Historical sales-only runs never advance the operational cursor",
      plan: null,
    };
  }
  if (runKind === "OPEN_TICKET") {
    return {
      executable: false,
      reason: "Open tickets are provisional and never advance the definitive-sales cursor",
      plan: null,
    };
  }
  const throughBusinessDay = documents
    .filter((document) => document.kind === "DEFINITIVE_INVOICE")
    .map((document) => document.businessDay)
    .sort()
    .at(-1);
  if (!throughBusinessDay) {
    return {
      executable: false,
      reason: "No definitive invoice business day is available for a cursor proposal",
      plan: null,
    };
  }
  return {
    executable: false,
    reason: "Prepared for explicit review only; this factory never mutates cursors",
    plan: adapter.planCursorAdvance({
      throughBusinessDay,
      reason: "definitive sales preparation completed",
    }),
  };
}

export function createSalesPreparationFactory(
  dependencies: SalesPreparationDependencies,
): SalesPreparationFactory {
  const loadConnection = async (connectionId: string): Promise<SalesConnectionContext> => {
    const result = await dependencies.database.query<ConnectionRow>(sql`
      SELECT
        id,
        location_name,
        provider,
        enabled,
        sync_mode,
        sync_frequency_minutes,
        last_business_day_synced,
        COALESCE(provider_config, '{}'::jsonb) AS provider_config
      FROM public.pos_connections
      WHERE id = ${connectionId}::uuid
      LIMIT 2
    `);
    if (result.rowCount === 0) throw new SalesPreparationError("SALES_CONNECTION_NOT_FOUND");
    if (result.rowCount !== 1) throw new SalesPreparationError("SALES_CONNECTION_NOT_UNIQUE");
    return connectionFromRow(result.rows[0]);
  };

  const prepare = async (input: PrepareSalesRunInput): Promise<PreparedSalesRun> => {
    const connection = await loadConnection(input.connectionId);
    assertRunEnabled(connection, input);
    if (!input.dryRun && !dependencies.mutations) {
      throw new SalesPreparationError("SALES_MUTATION_PORTS_REQUIRED");
    }

    const documents = await dependencies.documents.loadDocuments({
      connection,
      runKind: input.runKind,
      fromBusinessDay: input.fromBusinessDay,
      toBusinessDay: input.toBusinessDay,
    });
    assertSourceScope(connection, documents);

    const adapter = (dependencies.adapterFactory ?? ((factoryInput) => createPostgresSalesAdapter(
      factoryInput.database,
      {
        connectionId: factoryInput.connection.id,
        provider: factoryInput.connection.provider,
      },
    )))({ database: dependencies.database, connection });
    const requestedProviderProductIds = providerProductIds(documents);
    const exactMappings = await adapter.readExactMappings(requestedProviderProductIds);
    const mappingById = new Map(exactMappings.map((mapping) => [mapping.providerProductId, mapping]));

    const mutationPorts = dependencies.mutations ?? {
      applyStock: async () => {
        throw new SalesPreparationError("SALES_DRY_RUN_ATTEMPTED_STOCK_MUTATION");
      },
      importSales: async () => {
        throw new SalesPreparationError("SALES_DRY_RUN_ATTEMPTED_SALES_IMPORT");
      },
    };
    const handler = await handleSalesRun({
      connectionId: connection.id,
      provider: connection.provider,
      runKind: input.runKind,
      openTicketPolicy: input.openTicketPolicy,
      documents,
      dryRun: input.dryRun,
    }, {
      resolveLine: async ({ line }) => mappingById.get(line.providerProductId) ?? null,
      loadClaims: adapter.loadClaims,
      loadReconciliationClaims: adapter.loadReconciliationClaims,
      persistDocuments: adapter.persistDocuments,
      reserveClaim: adapter.reserveClaim,
      completeClaim: adapter.completeClaim,
      releaseClaim: adapter.releaseClaim,
      applyStock: mutationPorts.applyStock,
      importSales: mutationPorts.importSales,
    });

    return {
      connection,
      documents,
      mappings: mappingPreparation(requestedProviderProductIds, exactMappings),
      handler,
      cursor: cursorPreparation(adapter, input.runKind, documents),
    };
  };

  return { loadConnection, prepare };
}
