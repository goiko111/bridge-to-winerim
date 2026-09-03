import { sql, type DatabaseAdapter, type DatabaseTransaction } from "../../middleware-api/src/db";
import {
  certifyIntegration,
  parseMonitoringPolicy,
  type IntegrationCertificationState,
  type IntegrationEvidence,
  type RuntimeJobEvidence,
} from "./model";

type Row = Record<string, unknown>;

type ConnectionRow = Row & {
  connection_id: string;
  location_name: string;
  enabled: boolean;
  catalog_sync_enabled: boolean;
  circuit_breaker_paused_until: string | null;
  last_business_day_synced: string | null;
  active_scope_count: number | string;
  active_credential_count: number | string;
  policy: unknown;
};

type JobRow = Row & {
  connection_id: string;
  job: string;
  outcome: string;
  error_class: string | null;
  created_at: string;
  recent_connectivity_failures: number | string;
};

type AggregateRow = Row & { connection_id: string };

type PreviousRow = Row & {
  connection_id: string;
  state: IntegrationCertificationState;
  healthy_cycle_streak: number | string;
};

export type CertificationRefreshSummary = Readonly<{
  observedAt: string;
  connections: number;
  states: Readonly<Record<IntegrationCertificationState, number>>;
}>;

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function indexed<T extends AggregateRow>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [String(row.connection_id), row]));
}

async function loadConnections(transaction: DatabaseTransaction): Promise<readonly ConnectionRow[]> {
  const result = await transaction.query<ConnectionRow>(sql`
    SELECT
      connection.id::text AS connection_id,
      connection.location_name,
      connection.enabled,
      connection.catalog_sync_enabled,
      connection.circuit_breaker_paused_until,
      connection.last_business_day_synced::text,
      count(DISTINCT scope.run_id)::int AS active_scope_count,
      count(DISTINCT credentials.credential_kind)::int AS active_credential_count,
      jsonb_build_object(
        'timezone', coalesce(policy.timezone, 'Europe/Madrid'),
        'weeklySchedule', policy.weekly_schedule,
        'offlineGraceMinutes', coalesce(policy.offline_grace_minutes, 30),
        'p0AfterMinutes', coalesce(policy.p0_after_minutes, 20),
        'healthyCyclesRequired', coalesce(policy.healthy_cycles_required, 2),
        'maxCycleAgeMinutes', coalesce(policy.max_cycle_age_minutes, 12)
      ) AS policy
    FROM public.pos_connections connection
    JOIN public.runtime_canary_connections scope
      ON scope.connection_id = connection.id
     AND scope.status = 'ACTIVE'
     AND scope.active = true
     AND scope.approved_at <= now()
     AND scope.expires_at > now()
    LEFT JOIN public.runtime_connection_credentials credentials
      ON credentials.connection_id = scope.connection_id
     AND credentials.run_id = scope.run_id
     AND credentials.active = true
     AND credentials.retired_at IS NULL
    LEFT JOIN public.integration_monitoring_policies policy
      ON policy.connection_id = connection.id
     AND policy.enabled = true
    WHERE connection.provider = 'agora'
    GROUP BY connection.id, policy.connection_id
    ORDER BY connection.id
  `);
  return result.rows;
}

async function loadLatestJobs(transaction: DatabaseTransaction): Promise<readonly JobRow[]> {
  const result = await transaction.query<JobRow>(sql`
    WITH active_connections AS (
      SELECT DISTINCT connection_id
      FROM public.runtime_canary_connections
      WHERE status = 'ACTIVE' AND active = true
        AND approved_at <= now() AND expires_at > now()
    ), ranked AS (
      SELECT
        log.connection_id,
        log.job,
        log.outcome,
        log.error_class,
        log.created_at,
        row_number() OVER (
          PARTITION BY log.connection_id, log.job
          ORDER BY log.created_at DESC, log.id DESC
        ) AS rank,
        count(*) FILTER (
          WHERE log.outcome IN ('RETRY', 'TERMINAL', 'BLOCKED')
            AND log.created_at >= now() - interval '30 minutes'
        ) OVER (PARTITION BY log.connection_id) AS recent_connectivity_failures
      FROM public.runtime_execution_log log
      JOIN active_connections active ON active.connection_id = log.connection_id
      WHERE log.created_at >= now() - interval '24 hours'
    )
    SELECT connection_id::text, job, outcome, error_class, created_at::text,
      recent_connectivity_failures::int
    FROM ranked
    WHERE rank = 1
    ORDER BY connection_id, job
  `);
  return result.rows;
}

async function loadCatalog(transaction: DatabaseTransaction): Promise<readonly AggregateRow[]> {
  const result = await transaction.query<AggregateRow>(sql`
    WITH active_connections AS (
      SELECT DISTINCT connection_id
      FROM public.runtime_canary_connections
      WHERE status = 'ACTIVE' AND active = true
        AND approved_at <= now() AND expires_at > now()
    ), expected AS (
      SELECT
        wine.connection_id,
        wine.winerim_id,
        variant.format,
        variant.price
      FROM public.winerim_wines wine
      JOIN active_connections active ON active.connection_id = wine.connection_id
      CROSS JOIN LATERAL (VALUES
        ('BOTTLE', wine.bottle_sale_price),
        ('GLASS', wine.glass_sale_price),
        ('MAGNUM', wine.magnum_sale_price)
      ) variant(format, price)
      WHERE wine.is_active = true AND variant.price > 0
    )
    SELECT
      active.connection_id::text,
      count(expected.*)::int AS expected_catalog_products,
      count(mapping.*) FILTER (
        WHERE mapping.status = 'CONFIRMED' AND product.sync_status = 'SYNCED'
      )::int AS confirmed_catalog_products,
      count(expected.*) FILTER (
        WHERE mapping.id IS NULL OR mapping.status <> 'CONFIRMED'
          OR product.id IS NULL OR product.sync_status <> 'SYNCED'
      )::int AS missing_catalog_products,
      count(expected.*) FILTER (
        WHERE product.id IS NOT NULL
          AND abs(coalesce(product.price, 0) - expected.price) > 0.01
      )::int AS price_divergences,
      max(master.fetched_at)::text AS master_fetched_at
    FROM active_connections active
    LEFT JOIN expected ON expected.connection_id = active.connection_id
    LEFT JOIN public.product_mappings mapping
      ON mapping.connection_id = expected.connection_id
     AND mapping.winerim_wine_id = expected.winerim_id
     AND upper(mapping.format_type) = expected.format
    LEFT JOIN public.provider_products product
      ON product.connection_id = mapping.connection_id
     AND product.provider_product_id = mapping.provider_product_id
    LEFT JOIN public.agora_master_data master
      ON master.connection_id = active.connection_id
    GROUP BY active.connection_id
  `);
  return result.rows;
}

async function loadSales(transaction: DatabaseTransaction): Promise<readonly AggregateRow[]> {
  const result = await transaction.query<AggregateRow>(sql`
    WITH active_connections AS (
      SELECT DISTINCT connection_id
      FROM public.runtime_canary_connections
      WHERE status = 'ACTIVE' AND active = true
        AND approved_at <= now() AND expires_at > now()
    )
    SELECT
      active.connection_id::text,
      count(DISTINCT event.id) FILTER (
        WHERE event.created_at >= now() - interval '24 hours'
      )::int AS recent_sales_events,
      count(line.id) FILTER (
        WHERE line.created_at >= now() - interval '24 hours' AND line.is_wine_candidate
      )::int AS recent_wine_lines,
      count(line.id) FILTER (
        WHERE line.created_at >= now() - interval '24 hours'
          AND line.is_wine_candidate AND NOT line.mapped
      )::int AS recent_unmapped_wine_lines
    FROM active_connections active
    LEFT JOIN public.sales_events event ON event.connection_id = active.connection_id
    LEFT JOIN public.sales_line_items line
      ON line.sales_event_id = event.id AND line.connection_id = active.connection_id
    GROUP BY active.connection_id
  `);
  return result.rows;
}

async function loadStock(transaction: DatabaseTransaction): Promise<readonly AggregateRow[]> {
  const result = await transaction.query<AggregateRow>(sql`
    WITH active_connections AS (
      SELECT DISTINCT connection_id
      FROM public.runtime_canary_connections
      WHERE status = 'ACTIVE' AND active = true
        AND approved_at <= now() AND expires_at > now()
    ), boundaries AS (
      SELECT
        active.connection_id,
        coalesce(max(snapshot.observed_at), now()) AS coverage_since
      FROM active_connections active
      LEFT JOIN public.integration_certification_snapshots snapshot
        ON snapshot.connection_id = active.connection_id
      GROUP BY active.connection_id
    ), claims AS (
      SELECT
        claim.connection_id,
        claim.message_id,
        claim.status,
        claim.result,
        upper(claim.result ->> 'variant') AS variant,
        claim.result ->> 'winerimWineId' AS winerim_wine_id,
        boundary.coverage_since
      FROM public.runtime_idempotency claim
      JOIN boundaries boundary ON boundary.connection_id = claim.connection_id
      WHERE claim.job = 'sales.claim'
        AND claim.updated_at > boundary.coverage_since
        AND claim.updated_at <= now()
    ), classified_claims AS (
      SELECT
        claim.*,
        stock_contract.stock_active,
        EXISTS (
          SELECT 1
          FROM public.runtime_idempotency mutation
          WHERE mutation.connection_id = claim.connection_id
            AND mutation.job = 'stock.mutation'
            AND mutation.message_id = claim.message_id
            AND mutation.status = 'SUCCESS'
        ) AS has_stock_success,
        EXISTS (
          SELECT 1
          FROM public.runtime_idempotency mutation
          WHERE mutation.connection_id = claim.connection_id
            AND mutation.job = 'stock.mutation'
            AND mutation.message_id = claim.message_id
            AND mutation.status = 'SUCCESS'
            AND mutation.result ->> 'stockShortfall' = 'true'
        ) AS stock_shortfall
      FROM claims claim
      LEFT JOIN public.winerim_wines wine
        ON wine.connection_id = claim.connection_id
       AND wine.winerim_id = claim.winerim_wine_id
      LEFT JOIN LATERAL (
        SELECT
          bool_and((stock_entry ->> 'stockActive')::boolean) AS stock_active,
          count(*) AS stock_count
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(wine.raw_payload -> 'prices') = 'array' THEN (
              SELECT coalesce(jsonb_agg(price_entry -> 'erpStock'), '[]'::jsonb)
              FROM jsonb_array_elements(wine.raw_payload -> 'prices') price_entry
              WHERE jsonb_typeof(price_entry -> 'erpStock') = 'object'
            )
            WHEN jsonb_typeof(wine.raw_payload -> 'stocks') = 'array' THEN wine.raw_payload -> 'stocks'
            ELSE '[]'::jsonb
          END
        ) stock_entry
        WHERE stock_entry ->> 'id' = (
          CASE claim.variant
            WHEN 'GLASS' THEN wine.glass_stock_id
            WHEN 'MAGNUM' THEN wine.magnum_stock_id
            ELSE wine.bottle_stock_id
          END
        )::text
          AND jsonb_typeof(stock_entry -> 'stockActive') = 'boolean'
      ) stock_contract ON stock_contract.stock_count = 1
    ), duplicates AS (
      SELECT log.connection_id, count(*)::int AS duplicate_stock_applications
      FROM (
        SELECT connection_id, idempotency_key
        FROM public.stock_sync_log
        WHERE status = 'SUCCESS'
          AND idempotency_key IS NOT NULL
          AND created_at >= now() - interval '24 hours'
        GROUP BY connection_id, idempotency_key
        HAVING count(*) > 1
      ) log
      GROUP BY log.connection_id
    ), claim_coverage AS (
      SELECT
        boundary.connection_id,
        boundary.coverage_since,
        count(claim.connection_id) FILTER (
          WHERE claim.status = 'SUCCESS' AND claim.stock_active IS TRUE
        )::int AS stock_required_claims,
        count(claim.connection_id) FILTER (
          WHERE claim.status = 'SUCCESS' AND claim.stock_active IS TRUE
            AND claim.has_stock_success
        )::int AS stock_certified_claims,
        count(claim.connection_id) FILTER (
          WHERE claim.status = 'SUCCESS' AND claim.stock_active IS FALSE
        )::int AS sales_only_claims,
        count(claim.connection_id) FILTER (
          WHERE claim.status = 'SUCCESS' AND claim.stock_active IS TRUE
            AND NOT claim.has_stock_success
        )::int AS missing_stock_certifications,
        count(claim.connection_id) FILTER (
          WHERE claim.status = 'SUCCESS' AND claim.stock_active IS NULL
        )::int AS unknown_stock_policy_claims,
        count(claim.connection_id) FILTER (
          WHERE claim.status = 'SUCCESS' AND claim.stock_shortfall
        )::int AS stock_shortfall_claims
      FROM boundaries boundary
      LEFT JOIN classified_claims claim ON claim.connection_id = boundary.connection_id
      GROUP BY boundary.connection_id, boundary.coverage_since
    )
    SELECT
      active.connection_id::text,
      count(stock.id) FILTER (
        WHERE stock.created_at >= now() - interval '24 hours'
          AND stock.status = 'FAILED'
          AND NOT EXISTS (
            SELECT 1
            FROM public.runtime_idempotency recovered
            WHERE recovered.connection_id = stock.connection_id
              AND recovered.job = 'stock.mutation'
              AND recovered.idempotency_key = stock.idempotency_key
              AND recovered.status = 'SUCCESS'
          )
      )::int AS recent_stock_failures,
      coalesce(max(duplicates.duplicate_stock_applications), 0)::int AS duplicate_stock_applications,
      max(claim_coverage.coverage_since)::text AS stock_coverage_since,
      coalesce(max(claim_coverage.stock_required_claims), 0)::int AS stock_required_claims,
      coalesce(max(claim_coverage.stock_certified_claims), 0)::int AS stock_certified_claims,
      coalesce(max(claim_coverage.sales_only_claims), 0)::int AS sales_only_claims,
      coalesce(max(claim_coverage.missing_stock_certifications), 0)::int AS missing_stock_certifications,
      coalesce(max(claim_coverage.unknown_stock_policy_claims), 0)::int AS unknown_stock_policy_claims,
      coalesce(max(claim_coverage.stock_shortfall_claims), 0)::int AS stock_shortfall_claims
    FROM active_connections active
    LEFT JOIN public.stock_sync_log stock ON stock.connection_id = active.connection_id
    LEFT JOIN duplicates ON duplicates.connection_id = active.connection_id
    LEFT JOIN claim_coverage ON claim_coverage.connection_id = active.connection_id
    GROUP BY active.connection_id
  `);
  return result.rows;
}

async function loadQueues(transaction: DatabaseTransaction): Promise<readonly AggregateRow[]> {
  const result = await transaction.query<AggregateRow>(sql`
    WITH active_connections AS (
      SELECT DISTINCT connection_id
      FROM public.runtime_canary_connections
      WHERE status = 'ACTIVE' AND active = true
        AND approved_at <= now() AND expires_at > now()
    )
    SELECT
      active.connection_id::text,
      count(task.id) FILTER (WHERE task.status IN ('QUEUED', 'RUNNING'))::int AS live_queue_tasks,
      count(task.id) FILTER (
        WHERE task.status IN ('FAILED', 'BLOCKED')
          AND task.updated_at >= now() - interval '24 hours'
      )::int AS failed_queue_tasks_recent
    FROM active_connections active
    LEFT JOIN public.outbound_tasks task ON task.connection_id = active.connection_id
    GROUP BY active.connection_id
  `);
  return result.rows;
}

async function loadPrevious(transaction: DatabaseTransaction): Promise<readonly PreviousRow[]> {
  const result = await transaction.query<PreviousRow>(sql`
    SELECT DISTINCT ON (snapshot.connection_id)
      snapshot.connection_id::text,
      snapshot.state,
      snapshot.healthy_cycle_streak
    FROM public.integration_certification_snapshots snapshot
    JOIN public.runtime_canary_connections scope
      ON scope.connection_id = snapshot.connection_id
     AND scope.status = 'ACTIVE' AND scope.active = true
     AND scope.approved_at <= now() AND scope.expires_at > now()
    ORDER BY snapshot.connection_id, snapshot.observed_at DESC, snapshot.id DESC
  `);
  return result.rows;
}

function jobsByConnection(rows: readonly JobRow[]): Map<string, RuntimeJobEvidence[]> {
  const grouped = new Map<string, RuntimeJobEvidence[]>();
  for (const row of rows) {
    const jobs = grouped.get(row.connection_id) ?? [];
    jobs.push({
      job: row.job,
      outcome: row.outcome,
      observedAt: row.created_at,
      errorClass: row.error_class,
    });
    grouped.set(row.connection_id, jobs);
  }
  return grouped;
}

function cursorLagDays(observedAt: string, lastBusinessDay: string | null): number | null {
  if (!lastBusinessDay) return null;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(observedAt));
  const current = Date.parse(`${today}T00:00:00.000Z`);
  const cursor = Date.parse(`${lastBusinessDay.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(current) && Number.isFinite(cursor)
    ? Math.max(0, Math.round((current - cursor) / 86_400_000))
    : null;
}

async function persistSnapshot(
  transaction: DatabaseTransaction,
  connectionId: string,
  observedAt: string,
  result: ReturnType<typeof certifyIntegration>,
  evidence: IntegrationEvidence,
): Promise<void> {
  await transaction.query(sql`
    INSERT INTO public.integration_certification_snapshots (
      connection_id, state, service_window_state, healthy_cycle_streak,
      writer_ok, connectivity_ok, catalog_ok, sales_ok, stock_ok, queue_ok, cursor_ok,
      reasons, evidence, observed_at
    ) VALUES (
      ${connectionId}::uuid, ${result.state}, ${result.serviceWindowState}, ${result.healthyCycleStreak},
      ${result.checklist.writerOk}, ${result.checklist.connectivityOk}, ${result.checklist.catalogOk},
      ${result.checklist.salesOk}, ${result.checklist.stockOk}, ${result.checklist.queueOk},
      ${result.checklist.cursorOk}, ${result.reasons}, ${JSON.stringify(evidence)}::jsonb,
      ${observedAt}::timestamptz
    )
    ON CONFLICT (connection_id, observed_at) DO NOTHING
  `);
}

export async function refreshIntegrationCertifications(
  database: DatabaseAdapter,
  observedAt = new Date().toISOString(),
): Promise<CertificationRefreshSummary> {
  return database.transaction(async (transaction) => {
    const connections = await loadConnections(transaction);
    const jobs = await loadLatestJobs(transaction);
    const catalog = indexed(await loadCatalog(transaction));
    const sales = indexed(await loadSales(transaction));
    const stock = indexed(await loadStock(transaction));
    const queues = indexed(await loadQueues(transaction));
    const previous = indexed(await loadPrevious(transaction));
    const jobsById = jobsByConnection(jobs);
    const failureCounts = new Map<string, number>();
    for (const row of jobs) {
      failureCounts.set(row.connection_id, Math.max(
        failureCounts.get(row.connection_id) ?? 0,
        count(row.recent_connectivity_failures),
      ));
    }

    const states: Record<IntegrationCertificationState, number> = {
      ONLINE_OK: 0,
      OFFLINE_EXPECTED: 0,
      CATCHUP_PENDING: 0,
      DEGRADED: 0,
      P0: 0,
    };
    for (const connection of connections) {
      const id = connection.connection_id;
      const catalogRow = catalog.get(id) ?? { connection_id: id };
      const salesRow = sales.get(id) ?? { connection_id: id };
      const stockRow = stock.get(id) ?? { connection_id: id };
      const queueRow = queues.get(id) ?? { connection_id: id };
      const previousRow = previous.get(id) as PreviousRow | undefined;
      const evidence: IntegrationEvidence = {
        observedAt,
        enabled: connection.enabled,
        catalogSyncEnabled: connection.catalog_sync_enabled,
        activeScopeCount: count(connection.active_scope_count),
        activeCredentialCount: count(connection.active_credential_count),
        breakerPausedUntil: connection.circuit_breaker_paused_until,
        latestJobs: jobsById.get(id) ?? [],
        recentConnectivityFailures: failureCounts.get(id) ?? 0,
        expectedCatalogProducts: count(catalogRow.expected_catalog_products),
        confirmedCatalogProducts: count(catalogRow.confirmed_catalog_products),
        missingCatalogProducts: count(catalogRow.missing_catalog_products),
        priceDivergences: count(catalogRow.price_divergences),
        masterFetchedAt: String(catalogRow.master_fetched_at ?? "") || null,
        recentSalesEvents: count(salesRow.recent_sales_events),
        recentWineLines: count(salesRow.recent_wine_lines),
        recentUnmappedWineLines: count(salesRow.recent_unmapped_wine_lines),
        recentStockFailures: count(stockRow.recent_stock_failures),
        duplicateStockApplications: count(stockRow.duplicate_stock_applications),
        stockCoverageSince: String(stockRow.stock_coverage_since ?? "") || null,
        stockRequiredClaims: count(stockRow.stock_required_claims),
        stockCertifiedClaims: count(stockRow.stock_certified_claims),
        salesOnlyClaims: count(stockRow.sales_only_claims),
        missingStockCertifications: count(stockRow.missing_stock_certifications),
        unknownStockPolicyClaims: count(stockRow.unknown_stock_policy_claims),
        stockShortfallClaims: count(stockRow.stock_shortfall_claims),
        liveQueueTasks: count(queueRow.live_queue_tasks),
        failedQueueTasksRecent: count(queueRow.failed_queue_tasks_recent),
        cursorLagDays: cursorLagDays(observedAt, connection.last_business_day_synced),
        previousState: previousRow?.state ?? null,
        previousHealthyCycleStreak: count(previousRow?.healthy_cycle_streak),
      };
      const result = certifyIntegration(evidence, parseMonitoringPolicy(connection.policy));
      await persistSnapshot(transaction, id, observedAt, result, evidence);
      states[result.state] += 1;
    }
    return Object.freeze({ observedAt, connections: connections.length, states: Object.freeze(states) });
  }, { isolationLevel: "read-committed" });
}
