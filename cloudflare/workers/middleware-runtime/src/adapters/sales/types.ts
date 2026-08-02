import type {
  ProviderSalesDocument,
  SalesClaimSnapshot,
  SalesExecutionPorts,
  SalesLineResolution,
  SalesPlanningPorts,
} from "../../handlers/sales";

export type ExactSalesMapping = SalesLineResolution & {
  providerProductId: string;
  providerProductName: string;
  mappingId: string;
  mappingStatus: "CONFIRMED";
};

export type SalesEventReadback = {
  id: string;
  connectionId: string;
  providerDocumentId: string;
  businessDay: string;
  documentType: string;
  lineCount: number;
  totalAmount: number;
  rawDocument: ProviderSalesDocument | null;
  createdAt: string;
};

export type SalesLineReadback = {
  id: string;
  salesEventId: string;
  providerProductId: string | null;
  name: string;
  format: string | null;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  mapped: boolean;
  winerimProductId: string | null;
  providerSoldAt: string | null;
};

export type SalesDocumentsReadback = {
  events: SalesEventReadback[];
  lines: SalesLineReadback[];
};

export type SalesClaimReadback = SalesClaimSnapshot & {
  orderId: string;
  job: string;
  leaseExpiresAt: string | null;
  updatedAt: string;
  result: Record<string, unknown>;
};

export type SalesReadbackFilter = {
  fromBusinessDay?: string;
  toBusinessDay?: string;
  providerDocumentIds?: string[];
  limit?: number;
};

export type CursorAdvancePlan = {
  kind: "SALES_CURSOR_ADVANCE";
  executable: false;
  connectionId: string;
  throughBusinessDay: string;
  reason: string;
  requiredReadbacks: string[];
  statement: {
    text: string;
    values: readonly [string, string];
  };
};

export type PostgresSalesAdapter = SalesPlanningPorts &
  Pick<
    SalesExecutionPorts,
    "persistDocuments" | "reserveClaim" | "completeClaim" | "releaseClaim"
  > & {
    readExactMappings(providerProductIds: string[]): Promise<ExactSalesMapping[]>;
    readDocuments(filter?: SalesReadbackFilter): Promise<SalesDocumentsReadback>;
    readClaims(claimKeys?: string[]): Promise<SalesClaimReadback[]>;
    planCursorAdvance(input: {
      throughBusinessDay: string;
      reason: string;
      requiredReadbacks?: string[];
    }): CursorAdvancePlan;
  };

export type PostgresSalesAdapterOptions = {
  connectionId: string;
  provider: string;
  claimLeaseSeconds?: number;
};
