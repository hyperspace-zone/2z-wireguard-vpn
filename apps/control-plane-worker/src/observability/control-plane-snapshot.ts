import type { Database } from "@hyperspace-zone/db";
import type { HealthRegistry, RuntimeMetrics } from "@hyperspace-zone/shared";

export async function collectControlPlaneSnapshotMetrics(input: {
  db: Database;
  metrics: RuntimeMetrics;
  health: HealthRegistry;
}): Promise<void> {
  const started = process.hrtime.bigint();
  try {
    await collectGateMetrics(input.db, input.metrics);
    await collectSessionMetrics(input.db, input.metrics);
    await collectJobMetrics(input.db, input.metrics);
    await collectBenchmarkMetrics(input.db, input.metrics);
    input.health.setComponent("database", {
      state: "ready",
      message: "Control-plane database snapshot collected.",
      details: { latencyMs: Number(process.hrtime.bigint() - started) / 1_000_000 }
    });
  } catch (error) {
    input.metrics.counter("worker_snapshot_collection_errors_total", 1, {
      help: "Total worker observability snapshot collection failures."
    });
    input.health.setComponent("database", {
      state: "failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function collectGateMetrics(db: Database, metrics: RuntimeMetrics): Promise<void> {
  const result = await db.query<{
    total: number;
    enabled: number;
    agentConnected: number;
    ready: number;
    schedulable: number;
    doublezeroReady: number;
  }>(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE gates.desired_state = 'Enabled')::int AS enabled,
      COUNT(*) FILTER (
        WHERE COALESCE(agent.status = 'True', false)
          AND COALESCE(gate_leases.lease_expires_at > now(), false)
      )::int AS "agentConnected",
      COUNT(*) FILTER (
        WHERE COALESCE(agent.status = 'True', false)
          AND COALESCE(gate_leases.lease_expires_at > now(), false)
          AND COALESCE(ready.status = 'True', false)
      )::int AS ready,
      COUNT(*) FILTER (
        WHERE gates.desired_state = 'Enabled'
          AND COALESCE(agent.status = 'True', false)
          AND COALESCE(gate_leases.lease_expires_at > now(), false)
          AND COALESCE(schedulable.status = 'True', false)
      )::int AS schedulable,
      COUNT(*) FILTER (
        WHERE 'doublezero0:up' = ANY(gate_status.observed_capabilities)
          AND gate_status.doublezero_status->>'tunnelStatus' = 'BGP Session Up'
          AND gate_status.doublezero_status->>'network' = COALESCE(NULLIF(gates.spec->>'doubleZeroEnv', ''), 'testnet')
          AND gate_status.doublezero_status->>'tunnelSrc' = gates.public_ipv4
      )::int AS "doublezeroReady"
    FROM gates
    LEFT JOIN gate_status ON gate_status.gate_id = gates.id
    LEFT JOIN gate_leases ON gate_leases.gate_id = gates.id
    LEFT JOIN gate_conditions agent ON agent.gate_id = gates.id AND agent.type = 'AgentConnected'
    LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
    LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
  `);
  const row = result.rows[0];
  if (!row) {
    return;
  }
  for (const [state, value] of Object.entries(row)) {
    metrics.gauge("control_plane_gates_total", Number(value), {
      help: "Gate catalog counts by operational state.",
      labels: { state }
    });
  }
}

async function collectSessionMetrics(db: Database, metrics: RuntimeMetrics): Promise<void> {
  const result = await db.query<{ phase: string; mode: string; count: number }>(`
    WITH phases AS (
      SELECT unnest(enum_range(NULL::session_phase)) AS phase
    ),
    modes AS (
      SELECT unnest(enum_range(NULL::session_mode)) AS mode
    )
    SELECT
      phases.phase::text AS phase,
      modes.mode::text AS mode,
      COUNT(sessions.id)::int AS count
    FROM phases
    CROSS JOIN modes
    LEFT JOIN session_status ON session_status.phase = phases.phase
    LEFT JOIN sessions ON sessions.id = session_status.session_id
      AND sessions.mode = modes.mode
      AND sessions.hidden_at IS NULL
    GROUP BY phases.phase, modes.mode
    ORDER BY phases.phase::text, modes.mode::text
  `);
  for (const row of result.rows) {
    metrics.gauge("control_plane_sessions_total", row.count, {
      help: "Visible VPN sessions by phase and mode.",
      labels: { phase: row.phase, mode: row.mode }
    });
  }
}

async function collectJobMetrics(db: Database, metrics: RuntimeMetrics): Promise<void> {
  const result = await db.query<{ type: string; phase: string; count: number }>(`
    WITH types AS (
      SELECT unnest(enum_range(NULL::job_type)) AS type
    ),
    phases AS (
      SELECT unnest(enum_range(NULL::job_phase)) AS phase
    )
    SELECT
      types.type::text AS type,
      phases.phase::text AS phase,
      COUNT(jobs.id)::int AS count
    FROM types
    CROSS JOIN phases
    LEFT JOIN jobs ON jobs.type = types.type AND jobs.phase = phases.phase
    GROUP BY types.type, phases.phase
    ORDER BY types.type::text, phases.phase::text
  `);
  for (const row of result.rows) {
    metrics.gauge("control_plane_jobs_total", row.count, {
      help: "Control-plane jobs by type and phase.",
      labels: { type: row.type, phase: row.phase }
    });
  }
}

async function collectBenchmarkMetrics(db: Database, metrics: RuntimeMetrics): Promise<void> {
  const result = await db.query<{
    transport: string;
    status: string;
    routes: number;
    avgRttP50Ms: number | null;
    avgJitterMs: number | null;
    avgLossPercent: number | null;
    maxAgeSeconds: number | null;
  }>(`
    WITH latest AS (
      SELECT DISTINCT ON (source_gate_id, target_gate_id, transport)
        transport,
        status,
        rtt_p50_ms,
        jitter_ms,
        loss_percent,
        measured_at
      FROM gate_benchmark_results
      ORDER BY source_gate_id, target_gate_id, transport, measured_at DESC
    )
    SELECT
      transport,
      status,
      COUNT(*)::int AS routes,
      AVG(rtt_p50_ms)::float AS "avgRttP50Ms",
      AVG(jitter_ms)::float AS "avgJitterMs",
      AVG(loss_percent)::float AS "avgLossPercent",
      MAX(EXTRACT(EPOCH FROM now() - measured_at))::float AS "maxAgeSeconds"
    FROM latest
    GROUP BY transport, status
    ORDER BY transport, status
  `);
  for (const row of result.rows) {
    const labels = { transport: row.transport, status: row.status };
    metrics.gauge("control_plane_benchmark_routes_total", row.routes, {
      help: "Latest gate benchmark route count by transport and status.",
      labels
    });
    metrics.gauge("control_plane_benchmark_rtt_p50_ms", row.avgRttP50Ms ?? 0, {
      help: "Average latest benchmark RTT p50 in milliseconds.",
      labels
    });
    metrics.gauge("control_plane_benchmark_jitter_ms", row.avgJitterMs ?? 0, {
      help: "Average latest benchmark jitter in milliseconds.",
      labels
    });
    metrics.gauge("control_plane_benchmark_loss_percent", row.avgLossPercent ?? 0, {
      help: "Average latest benchmark packet loss percent.",
      labels
    });
    metrics.gauge("control_plane_benchmark_max_age_seconds", row.maxAgeSeconds ?? 0, {
      help: "Maximum age of latest benchmark samples in seconds.",
      labels
    });
  }
}
