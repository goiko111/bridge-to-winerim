import type {
  OutboundBatchSummary,
  OutboundExecutionContext,
  OutboundExecutionLog,
  OutboundExecutionResult,
  OutboundPorts,
  OutboundTask,
  OutboundTaskDecision,
} from "../../handlers/outbound";

export type PosOutboundTransportRequest = {
  task: Readonly<OutboundTask>;
  context: Readonly<OutboundExecutionContext>;
};

export interface PosOutboundTransport {
  execute(request: PosOutboundTransportRequest): Promise<OutboundExecutionResult>;
}

export type OutboundDryRunJournal = {
  claimedTaskIds: readonly string[];
  transitions: readonly {
    taskId: string;
    decision: OutboundTaskDecision;
  }[];
  logs: readonly OutboundExecutionLog[];
};

export type PostgresOutboundProcessInput = {
  taskTypes: readonly string[];
  limit?: number;
};

export type PostgresOutboundProcessResult = {
  dryRun: boolean;
  lockAcquired: boolean;
  summary: OutboundBatchSummary;
  journal: OutboundDryRunJournal;
};

export type PostgresOutboundAdapterOptions = {
  connectionId: string;
  provider: string;
  dryRun?: boolean;
  lockTtlSeconds?: number;
  clock?: OutboundPorts["clock"];
  limiter: OutboundPorts["limiter"];
  lockTokenFactory?: () => string;
};

export interface PostgresOutboundAdapter {
  process(input: PostgresOutboundProcessInput): Promise<PostgresOutboundProcessResult>;
}
