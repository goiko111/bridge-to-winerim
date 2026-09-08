import type { RuntimeEnvelopeV1 } from "../contracts";
import type { CatalogHandlerPorts } from "../handlers/catalog";
import type { OutboundBatchInput, OutboundPorts } from "../handlers/outbound";
import type { SalesHandlerInput, SalesHandlerPorts } from "../handlers/sales";
import type {
  WinerimMutationTransport,
  WinerimStockMutationInput,
} from "../handlers/stock";

export type RuntimeExecutorPreparedInput<T> = Readonly<{
  input: T;
  dryRun?: boolean;
}>;

export type RuntimeExecutorInputPort<T> = Readonly<{
  prepare(
    envelope: RuntimeEnvelopeV1,
  ): RuntimeExecutorPreparedInput<T> | Promise<RuntimeExecutorPreparedInput<T>>;
}>;

export type CatalogRuntimeExecutorPorts = RuntimeExecutorInputPort<unknown> & Readonly<{
  handler: CatalogHandlerPorts;
}>;

export type SalesRuntimeExecutorPorts = RuntimeExecutorInputPort<SalesHandlerInput> & Readonly<{
  handler: SalesHandlerPorts;
}>;

export type StockRuntimeExecutorPorts = RuntimeExecutorInputPort<WinerimStockMutationInput> & Readonly<{
  transport: WinerimMutationTransport;
}>;

export type OutboundRuntimeExecutorPorts = RuntimeExecutorInputPort<OutboundBatchInput> & Readonly<{
  handler: OutboundPorts;
}>;

export type ProviderNeutralRuntimeExecutorPorts = Readonly<{
  catalog?: CatalogRuntimeExecutorPorts;
  sales?: SalesRuntimeExecutorPorts;
  stock?: StockRuntimeExecutorPorts;
  outbound?: OutboundRuntimeExecutorPorts;
}>;
