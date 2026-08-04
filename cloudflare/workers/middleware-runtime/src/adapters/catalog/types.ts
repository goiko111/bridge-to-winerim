import type { DatabaseAdapter } from "../../../../middleware-api/src/db";
import type {
  CatalogApplyPortResult,
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
> & Readonly<{
  preflightApplyPlan(
    input: Parameters<NonNullable<CatalogHandlerPorts["applyPlan"]>>[0],
  ): Promise<CatalogApplyPortResult>;
}>;

export type PostgresCatalogAdapterFactory = (
  database: DatabaseAdapter,
  options?: PostgresCatalogAdapterOptions,
) => PostgresCatalogAdapter;
