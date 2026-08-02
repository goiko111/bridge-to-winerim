import type { DatabaseAdapter } from "../../../../middleware-api/src/db";
import type {
  CatalogFamilyRoutingInput,
  CatalogHandlerPorts,
  CatalogLabelPolicy,
  CatalogProductIdPolicy,
} from "../../handlers/catalog";

export type PostgresCatalogAdapterOptions = {
  familyRouting?: CatalogFamilyRoutingInput;
  productIdPolicy?: CatalogProductIdPolicy;
  labelPolicy?: CatalogLabelPolicy;
};

export type PostgresCatalogAdapter = Required<
  Pick<CatalogHandlerPorts, "loadPlanningContext" | "applyPlan">
>;

export type PostgresCatalogAdapterFactory = (
  database: DatabaseAdapter,
  options?: PostgresCatalogAdapterOptions,
) => PostgresCatalogAdapter;
