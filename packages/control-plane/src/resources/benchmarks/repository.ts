import type { BenchmarkTransport, GateBenchmarkMetric, GateBenchmarkRoute } from "@hyperspace-zone/contracts";
import type { Queryable } from "../../db/queryable.js";
import { freshGateLeaseSqlPredicate } from "../gate-leases/repository.js";

export interface ScheduleGateBenchmarkInput {
  intervalSeconds: number;
  probePort: number;
  probeCount: number;
  probeIntervalMs: number;
  probeTimeoutMs: number;
}

export interface ScheduleGateNtpDiscoveryInput {
  intervalSeconds: number;
  sampleSeconds: number;
  maxCandidates: number;
}

export interface GateBenchmarkReportMetricInput {
  transport: BenchmarkTransport;
  status: "succeeded" | "failed";
  sourceInterface?: string;
  targetEndpoint?: string;
  packetCount?: number;
  packetsReceived?: number;
  lossPercent?: number;
  rttMs?: {
    min?: number;
    p50?: number;
    p95?: number;
    max?: number;
  };
  jitterMs?: number;
  forwardOneWayMs?: {
    p50?: number;
    p95?: number;
  };
  reverseOneWayMs?: {
    p50?: number;
    p95?: number;
  };
  oneWayClockErrorMs?: number;
  samples?: unknown[];
  errorCode?: string;
  errorMessage?: string;
  measuredAt?: string;
}

export interface GateBenchmarkReportInput {
  jobId: string;
  sourceGateId: string;
  targetGateId: string;
  results: GateBenchmarkReportMetricInput[];
}

export async function insertDueGateBenchmarkProbeJobs(
  db: Queryable,
  input: ScheduleGateBenchmarkInput
): Promise<number> {
  const result = await db.query(
    `
      WITH scheduler_lock AS MATERIALIZED (
        SELECT pg_try_advisory_xact_lock(740130191920260818::bigint) AS acquired
      ),
      schedulable_gates AS (
        SELECT
          gates.id,
          gates.name,
          gates.public_ipv4,
          gates.doublezero_interface,
          NULLIF(BTRIM(gate_status.doublezero_status->>'metro'), '') AS doublezero_metro
        FROM gates
        LEFT JOIN gate_status ON gate_status.gate_id = gates.id
        LEFT JOIN gate_leases ON gate_leases.gate_id = gates.id
        LEFT JOIN gate_conditions agent ON agent.gate_id = gates.id AND agent.type = 'AgentConnected'
        LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
        LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
        CROSS JOIN scheduler_lock
        WHERE gates.desired_state = 'Enabled'
          AND scheduler_lock.acquired
          AND COALESCE(agent.status = 'True', false)
          AND COALESCE(ready.status = 'True', false)
          AND COALESCE(schedulable.status = 'True', false)
          AND 'doublezero0:up' = ANY(gate_status.observed_capabilities)
          AND gate_status.doublezero_status->>'tunnelStatus' = 'BGP Session Up'
          AND gate_status.doublezero_status->>'network' = COALESCE(NULLIF(gates.spec->>'doubleZeroEnv', ''), 'testnet')
          AND gate_status.doublezero_status->>'tunnelSrc' = gates.public_ipv4
          AND ${freshGateLeaseSqlPredicate}
      ),
      directed_pairs AS (
        SELECT
          source.id AS source_gate_id,
          source.name AS source_gate_name,
          source.doublezero_interface AS source_doublezero_interface,
          source.doublezero_metro AS source_doublezero_metro,
          target.id AS target_gate_id,
          target.name AS target_gate_name,
          target.public_ipv4 AS target_public_ipv4,
          target.doublezero_metro AS target_doublezero_metro
        FROM schedulable_gates source
        CROSS JOIN schedulable_gates target
        WHERE source.id <> target.id
      ),
      active_pairs AS MATERIALIZED (
        SELECT DISTINCT
          jobs.gate_id AS source_gate_id,
          jobs.payload->>'targetGateId' AS target_gate_id
        FROM jobs
        WHERE jobs.type = 'probe'
          AND jobs.phase IN ('queued', 'leased', 'running', 'retryable_failed')
          AND jobs.payload->>'kind' = 'gate_benchmark_v1'
      ),
      recent_pairs AS MATERIALIZED (
        SELECT DISTINCT
          recent.source_gate_id,
          recent.target_gate_id
        FROM gate_benchmark_results recent
        WHERE recent.measured_at > now() - ($1::int * interval '1 second')
      ),
      due_pairs AS (
        SELECT directed_pairs.*
        FROM directed_pairs
        LEFT JOIN active_pairs
          ON active_pairs.source_gate_id = directed_pairs.source_gate_id
          AND active_pairs.target_gate_id = directed_pairs.target_gate_id::text
        LEFT JOIN recent_pairs
          ON recent_pairs.source_gate_id = directed_pairs.source_gate_id
          AND recent_pairs.target_gate_id = directed_pairs.target_gate_id
        WHERE active_pairs.source_gate_id IS NULL
          AND recent_pairs.source_gate_id IS NULL
      )
      INSERT INTO jobs (type, phase, gate_id, payload, max_retries)
      SELECT
        'probe',
        'queued',
        source_gate_id,
        jsonb_build_object(
          'kind', 'gate_benchmark_v1',
          'sourceGateId', source_gate_id,
          'sourceGateName', source_gate_name,
          'targetGateId', target_gate_id,
          'targetGateName', target_gate_name,
          'targetPublicIpv4', target_public_ipv4,
          'targetProbePort', $2::int,
          'count', $3::int,
          'intervalMs', $4::int,
          'timeoutMs', $5::int,
          'transports', CASE
            WHEN source_doublezero_metro IS NOT NULL
              AND target_doublezero_metro IS NOT NULL
              AND LOWER(source_doublezero_metro) = LOWER(target_doublezero_metro)
            THEN jsonb_build_array(
              jsonb_build_object('name', 'public', 'interface', 'public')
            )
            ELSE jsonb_build_array(
              jsonb_build_object('name', 'public', 'interface', 'public'),
              jsonb_build_object('name', 'doublezero', 'interface', source_doublezero_interface)
            )
          END
        ),
        2
      FROM due_pairs
    `,
    [
      input.intervalSeconds,
      input.probePort,
      input.probeCount,
      input.probeIntervalMs,
      input.probeTimeoutMs
    ]
  );
  return result.rowCount ?? 0;
}

export async function insertDueGateNtpDiscoveryJobs(
  db: Queryable,
  input: ScheduleGateNtpDiscoveryInput
): Promise<number> {
  const result = await db.query(
    `
      WITH schedulable_gates AS (
        SELECT gates.id, gates.name
        FROM gates
        LEFT JOIN gate_status ON gate_status.gate_id = gates.id
        LEFT JOIN gate_leases ON gate_leases.gate_id = gates.id
        LEFT JOIN gate_conditions agent ON agent.gate_id = gates.id AND agent.type = 'AgentConnected'
        LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
        LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
        WHERE gates.desired_state = 'Enabled'
          AND COALESCE(agent.status = 'True', false)
          AND COALESCE(ready.status = 'True', false)
          AND COALESCE(schedulable.status = 'True', false)
          AND COALESCE('chrony:sync' = ANY(gate_status.observed_capabilities), false)
          AND COALESCE('ntp-discovery:enabled' = ANY(gate_status.observed_capabilities), false)
          AND ${freshGateLeaseSqlPredicate}
      ),
      due_gates AS (
        SELECT schedulable_gates.*
        FROM schedulable_gates
        WHERE NOT EXISTS (
          SELECT 1
          FROM jobs
          WHERE jobs.type = 'probe'
            AND jobs.phase IN ('queued', 'leased', 'running', 'retryable_failed')
            AND jobs.gate_id = schedulable_gates.id
            AND jobs.payload->>'kind' = 'gate_ntp_discovery_v1'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM jobs completed
          JOIN job_attempts attempts ON attempts.job_id = completed.id
          WHERE completed.type = 'probe'
            AND completed.phase = 'succeeded'
            AND completed.gate_id = schedulable_gates.id
            AND completed.payload->>'kind' = 'gate_ntp_discovery_v1'
            AND attempts.completed_at > now() - ($1::int * interval '1 second')
        )
      )
      INSERT INTO jobs (type, phase, gate_id, payload, max_retries)
      SELECT
        'probe',
        'queued',
        id,
        jsonb_build_object(
          'kind', 'gate_ntp_discovery_v1',
          'gateId', id,
          'gateName', name,
          'sampleSeconds', $2::int,
          'maxCandidates', $3::int
        ),
        1
      FROM due_gates
    `,
    [
      input.intervalSeconds,
      input.sampleSeconds,
      input.maxCandidates
    ]
  );
  return result.rowCount ?? 0;
}

export async function insertGateBenchmarkReport(
  db: Queryable,
  input: GateBenchmarkReportInput
): Promise<void> {
  for (const result of input.results) {
    await db.query(
      `
        INSERT INTO gate_benchmark_results (
          job_id,
          source_gate_id,
          target_gate_id,
          transport,
          status,
          source_interface,
          target_endpoint,
          packet_count,
          packets_received,
          loss_percent,
          rtt_min_ms,
          rtt_p50_ms,
          rtt_p95_ms,
          rtt_max_ms,
          jitter_ms,
          forward_one_way_p50_ms,
          forward_one_way_p95_ms,
          reverse_one_way_p50_ms,
          reverse_one_way_p95_ms,
          one_way_clock_error_ms,
          samples,
          error_code,
          error_message,
          measured_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17,
          $18,
          $19,
          $20,
          $21::jsonb,
          $22,
          $23,
          COALESCE($24::timestamptz, now())
        )
      `,
      [
        input.jobId,
        input.sourceGateId,
        input.targetGateId,
        result.transport,
        result.status,
        textOrNull(result.sourceInterface),
        textOrNull(result.targetEndpoint),
        nonNegativeInteger(result.packetCount),
        nonNegativeInteger(result.packetsReceived),
        finiteNumberOrNull(result.lossPercent),
        finiteNumberOrNull(result.rttMs?.min),
        finiteNumberOrNull(result.rttMs?.p50),
        finiteNumberOrNull(result.rttMs?.p95),
        finiteNumberOrNull(result.rttMs?.max),
        finiteNumberOrNull(result.jitterMs),
        finiteNumberOrNull(result.forwardOneWayMs?.p50),
        finiteNumberOrNull(result.forwardOneWayMs?.p95),
        finiteNumberOrNull(result.reverseOneWayMs?.p50),
        finiteNumberOrNull(result.reverseOneWayMs?.p95),
        finiteNumberOrNull(result.oneWayClockErrorMs),
        JSON.stringify(Array.isArray(result.samples) ? result.samples.slice(0, 100) : []),
        textOrNull(result.errorCode),
        textOrNull(result.errorMessage),
        textOrNull(result.measuredAt)
      ]
    );
  }
}

export async function listLatestGateBenchmarkRoutes(db: Queryable): Promise<GateBenchmarkRoute[]> {
  const result = await db.query<{
    sourceGateId: string;
    sourceGateName: string;
    targetGateId: string;
    targetGateName: string;
    sameDoubleZeroMetro: boolean;
    doublezeroMetro: string | null;
    publicMetric: GateBenchmarkMetric | null;
    doublezeroMetric: GateBenchmarkMetric | null;
  }>(
    `
      WITH directed_pairs AS (
        SELECT
          source.id AS source_gate_id,
          source.name AS source_gate_name,
          NULLIF(BTRIM(source_status.doublezero_status->>'metro'), '') AS source_doublezero_metro,
          target.id AS target_gate_id,
          target.name AS target_gate_name,
          NULLIF(BTRIM(target_status.doublezero_status->>'metro'), '') AS target_doublezero_metro
        FROM gates source
        CROSS JOIN gates target
        LEFT JOIN gate_status source_status ON source_status.gate_id = source.id
        LEFT JOIN gate_status target_status ON target_status.gate_id = target.id
        WHERE source.id <> target.id
          AND source.desired_state = 'Enabled'
          AND target.desired_state = 'Enabled'
      )
      SELECT
        directed_pairs.source_gate_id AS "sourceGateId",
        directed_pairs.source_gate_name AS "sourceGateName",
        directed_pairs.target_gate_id AS "targetGateId",
        directed_pairs.target_gate_name AS "targetGateName",
        (
          directed_pairs.source_doublezero_metro IS NOT NULL
          AND directed_pairs.target_doublezero_metro IS NOT NULL
          AND LOWER(directed_pairs.source_doublezero_metro) = LOWER(directed_pairs.target_doublezero_metro)
        ) AS "sameDoubleZeroMetro",
        directed_pairs.source_doublezero_metro AS "doublezeroMetro",
        public_latest.metric AS "publicMetric",
        doublezero_latest.metric AS "doublezeroMetric"
      FROM directed_pairs
      LEFT JOIN LATERAL (
        SELECT
          jsonb_strip_nulls(jsonb_build_object(
            'transport', transport,
            'status', status,
            'sourceInterface', source_interface,
            'targetEndpoint', target_endpoint,
            'packetCount', packet_count,
            'packetsReceived', packets_received,
            'lossPercent', loss_percent,
            'rttMs', CASE
              WHEN rtt_p50_ms IS NULL THEN NULL
              ELSE jsonb_strip_nulls(jsonb_build_object(
                'min', rtt_min_ms,
                'p50', rtt_p50_ms,
                'p95', rtt_p95_ms,
                'max', rtt_max_ms
              ))
            END,
            'jitterMs', jitter_ms,
            'forwardOneWayMs', CASE
              WHEN forward_one_way_p50_ms IS NULL THEN NULL
              ELSE jsonb_strip_nulls(jsonb_build_object(
                'p50', forward_one_way_p50_ms,
                'p95', forward_one_way_p95_ms
              ))
            END,
            'oneWayDiagnostics', CASE
              WHEN one_way_clock_error_ms IS NULL THEN NULL
              ELSE jsonb_strip_nulls(jsonb_build_object(
                'clockErrorMs', one_way_clock_error_ms
              )
            )
            END,
            'errorCode', error_code,
            'errorMessage', error_message,
            'measuredAt', measured_at
          )) AS metric
        FROM gate_benchmark_results
        WHERE source_gate_id = directed_pairs.source_gate_id
          AND target_gate_id = directed_pairs.target_gate_id
          AND transport = 'public'
        ORDER BY measured_at DESC
        LIMIT 1
      ) public_latest ON true
      LEFT JOIN LATERAL (
        SELECT
          jsonb_strip_nulls(jsonb_build_object(
            'transport', transport,
            'status', status,
            'sourceInterface', source_interface,
            'targetEndpoint', target_endpoint,
            'packetCount', packet_count,
            'packetsReceived', packets_received,
            'lossPercent', loss_percent,
            'rttMs', CASE
              WHEN rtt_p50_ms IS NULL THEN NULL
              ELSE jsonb_strip_nulls(jsonb_build_object(
                'min', rtt_min_ms,
                'p50', rtt_p50_ms,
                'p95', rtt_p95_ms,
                'max', rtt_max_ms
              ))
            END,
            'jitterMs', jitter_ms,
            'forwardOneWayMs', CASE
              WHEN forward_one_way_p50_ms IS NULL THEN NULL
              ELSE jsonb_strip_nulls(jsonb_build_object(
                'p50', forward_one_way_p50_ms,
                'p95', forward_one_way_p95_ms
              ))
            END,
            'oneWayDiagnostics', CASE
              WHEN one_way_clock_error_ms IS NULL THEN NULL
              ELSE jsonb_strip_nulls(jsonb_build_object(
                'clockErrorMs', one_way_clock_error_ms
              )
            )
            END,
            'errorCode', error_code,
            'errorMessage', error_message,
            'measuredAt', measured_at
          )) AS metric
        FROM gate_benchmark_results
        WHERE source_gate_id = directed_pairs.source_gate_id
          AND target_gate_id = directed_pairs.target_gate_id
          AND transport = 'doublezero'
          AND NOT (
            directed_pairs.source_doublezero_metro IS NOT NULL
            AND directed_pairs.target_doublezero_metro IS NOT NULL
            AND LOWER(directed_pairs.source_doublezero_metro) = LOWER(directed_pairs.target_doublezero_metro)
          )
        ORDER BY measured_at DESC
        LIMIT 1
      ) doublezero_latest ON true
      ORDER BY directed_pairs.source_gate_name, directed_pairs.target_gate_name
    `
  );

  return result.rows.map((row) => {
    const publicMetric = normalizeMetric(row.publicMetric);
    const doublezeroMetric = row.sameDoubleZeroMetro ? null : normalizeMetric(row.doublezeroMetric);
    const route: GateBenchmarkRoute = {
      sourceGateId: row.sourceGateId,
      sourceGateName: row.sourceGateName,
      targetGateId: row.targetGateId,
      targetGateName: row.targetGateName
    };
    if (publicMetric) {
      route.public = publicMetric;
    }
    if (row.sameDoubleZeroMetro && row.doublezeroMetro) {
      route.doublezeroApplicability = {
        status: "not_applicable",
        reason: "same_doublezero_metro",
        metro: row.doublezeroMetro
      };
    } else if (doublezeroMetric) {
      route.doublezero = doublezeroMetric;
    }
    if (publicMetric && doublezeroMetric) {
      route.delta = metricDelta(publicMetric, doublezeroMetric);
    }
    return route;
  });
}

function normalizeMetric(value: GateBenchmarkMetric | null): GateBenchmarkMetric | null {
  if (!value) {
    return null;
  }
  return value;
}

function metricDelta(
  publicMetric: GateBenchmarkMetric,
  doublezeroMetric: GateBenchmarkMetric
): NonNullable<GateBenchmarkRoute["delta"]> {
  const delta: NonNullable<GateBenchmarkRoute["delta"]> = {};
  assignNumberDelta(delta, "rttP50Ms", publicMetric.rttMs?.p50, doublezeroMetric.rttMs?.p50);
  assignNumberDelta(delta, "jitterMs", publicMetric.jitterMs, doublezeroMetric.jitterMs);
  assignNumberDelta(delta, "lossPercent", publicMetric.lossPercent, doublezeroMetric.lossPercent);
  assignNumberDelta(delta, "forwardOneWayP50Ms", publicMetric.forwardOneWayMs?.p50, doublezeroMetric.forwardOneWayMs?.p50);
  return delta;
}

function assignNumberDelta(
  delta: NonNullable<GateBenchmarkRoute["delta"]>,
  key: keyof NonNullable<GateBenchmarkRoute["delta"]>,
  publicValue: unknown,
  doublezeroValue: unknown
): void {
  if (typeof publicValue !== "number" || typeof doublezeroValue !== "number") {
    return;
  }
  delta[key] = roundMetric(doublezeroValue - publicValue);
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? roundMetric(value) : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
