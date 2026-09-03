import { Client } from "pg";

import {
  createHyperdrivePostgresAdapter,
  type DatabaseAdapter,
  type DriverQueryConfig,
  type HyperdriveBinding,
  type PostgresClientFactory,
} from "../../middleware-api/src/db";
import { refreshIntegrationCertifications } from "./repository";
import { refreshAgoraFleetReadModel } from "./fleetReadModel";

const MONITOR_ENABLED = "true";

export interface IntegrationCertificationEnv {
  ENVIRONMENT?: string;
  RELEASE?: string;
  MONITOR_ENABLED?: string;
  FLEET_READ_MODEL_ENABLED?: string;
  MIDDLEWARE_DB?: HyperdriveBinding;
}

export interface ScheduledControllerLike {
  readonly scheduledTime: number;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerDependencies {
  database?: (env: IntegrationCertificationEnv) => DatabaseAdapter;
}

function database(env: IntegrationCertificationEnv): DatabaseAdapter {
  if (!env.MIDDLEWARE_DB) throw new Error("CERTIFICATION_DB_BINDING_MISSING");
  const createClient: PostgresClientFactory = (config) => {
    const client = new Client(config);
    return {
      connect: async () => { await client.connect(); },
      query: <Row extends Record<string, unknown>>(query: string | DriverQueryConfig) => (
        client.query<Row>(query as DriverQueryConfig)
      ),
      end: () => client.end(),
    };
  };
  return createHyperdrivePostgresAdapter(env.MIDDLEWARE_DB, {
    createClient,
    applicationName: "winerim-integration-certification",
  });
}

export async function runCertificationScheduled(
  controller: ScheduledControllerLike,
  env: IntegrationCertificationEnv,
  dependencies: WorkerDependencies = {},
) {
  if (env.MONITOR_ENABLED !== MONITOR_ENABLED) {
    return { status: "inactive" as const, reason: "MONITOR_DISABLED" as const };
  }
  const adapter = (dependencies.database ?? database)(env);
  const observedAt = new Date(controller.scheduledTime).toISOString();
  const fleetReadModel = env.FLEET_READ_MODEL_ENABLED === MONITOR_ENABLED
    ? await refreshAgoraFleetReadModel(adapter, observedAt, 2)
    : null;
  return {
    status: "completed" as const,
    ...await refreshIntegrationCertifications(adapter, observedAt),
    fleetReadModel,
  };
}

export function createIntegrationCertificationWorker(dependencies: WorkerDependencies = {}) {
  return {
    fetch(_request: Request, env: IntegrationCertificationEnv): Response {
      return new Response(JSON.stringify({
        ok: true,
        service: "integration-certification",
        environment: env.ENVIRONMENT ?? "unknown",
        release: env.RELEASE ?? "unknown",
        monitorEnabled: env.MONITOR_ENABLED === MONITOR_ENABLED,
        fleetReadModelEnabled: env.FLEET_READ_MODEL_ENABLED === MONITOR_ENABLED,
      }), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    },
    scheduled(controller: ScheduledControllerLike, env: IntegrationCertificationEnv, context: ExecutionContextLike): void {
      context.waitUntil(runCertificationScheduled(controller, env, dependencies));
    },
  };
}

export default createIntegrationCertificationWorker();
