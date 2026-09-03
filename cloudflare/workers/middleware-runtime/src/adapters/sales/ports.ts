import type { DatabaseAdapter } from "../../../../middleware-api/src/db";
import type {
  OpenTicketPolicy,
  ProviderSalesDocument,
  SalesExecutionPorts,
  SalesHandlerResult,
  SalesRunKind,
} from "../../handlers/sales";
import type {
  CursorAdvancePlan,
  ExactSalesMapping,
  PostgresSalesAdapter,
} from "./types";

export type SalesConnectionContext = {
  id: string;
  locationName: string;
  provider: string;
  enabled: boolean;
  syncMode: string;
  syncFrequencyMinutes: number;
  lastBusinessDaySynced: string | null;
  providerConfig: Record<string, unknown>;
};

export type PosSalesDocumentRequest = {
  connection: SalesConnectionContext;
  runKind: SalesRunKind;
  fromBusinessDay?: string;
  toBusinessDay?: string;
};

export interface PosSalesDocumentPort {
  loadDocuments(input: PosSalesDocumentRequest): Promise<ProviderSalesDocument[]>;
}

export type SalesMutationPort = Pick<SalesExecutionPorts, "applyStock" | "importSales">;

export type SalesAdapterFactory = (input: {
  database: DatabaseAdapter;
  connection: SalesConnectionContext;
}) => PostgresSalesAdapter;

export type SalesPreparationDependencies = {
  database: DatabaseAdapter;
  documents: PosSalesDocumentPort;
  mutations?: SalesMutationPort;
  adapterFactory?: SalesAdapterFactory;
};

export type PrepareSalesRunInput = {
  connectionId: string;
  runKind: SalesRunKind;
  dryRun: boolean;
  openTicketPolicy?: OpenTicketPolicy;
  fromBusinessDay?: string;
  toBusinessDay?: string;
};

export type SalesMappingPreparation = {
  requestedProviderProductIds: string[];
  exactMappings: ExactSalesMapping[];
  mappedProviderProductIds: string[];
  unmappedProviderProductIds: string[];
};

export type SalesCursorPreparation = {
  executable: false;
  reason: string;
  plan: CursorAdvancePlan | null;
};

export type PreparedSalesRun = {
  connection: SalesConnectionContext;
  documents: ProviderSalesDocument[];
  mappings: SalesMappingPreparation;
  handler: SalesHandlerResult;
  cursor: SalesCursorPreparation;
};

export interface SalesPreparationFactory {
  loadConnection(connectionId: string): Promise<SalesConnectionContext>;
  prepare(input: PrepareSalesRunInput): Promise<PreparedSalesRun>;
}
