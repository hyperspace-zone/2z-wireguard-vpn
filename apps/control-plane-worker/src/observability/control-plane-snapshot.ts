import type { Database } from "@hyperspace-zone/db";
import type { HealthRegistry, RuntimeMetrics } from "@hyperspace-zone/shared";

export async function collectControlPlaneSnapshotMetrics(input: {
  db: Database;
  metrics: RuntimeMetrics;
  health: HealthRegistry;
}): Promise<boolean> {
  const started = process.hrtime.bigint();
  try {
    await collectGateMetrics(input.db, input.metrics);
    await collectSessionMetrics(input.db, input.metrics);
    await collectAssignmentUsageMetrics(input.db, input.metrics);
    await collectJobMetrics(input.db, input.metrics);
    await collectBenchmarkMetrics(input.db, input.metrics);
    await collectBillingMetrics(input.db, input.metrics);
    input.metrics.gauge("control_plane_snapshot_ready", 1, {
      help: "Whether the worker has collected a complete control-plane business metrics snapshot."
    });
    input.metrics.gauge("control_plane_snapshot_last_success_timestamp_seconds", Date.now() / 1000, {
      help: "Unix timestamp of the last successful control-plane business metrics snapshot."
    });
    input.health.setComponent("database", {
      state: "ready",
      message: "Control-plane database snapshot collected.",
      details: { latencyMs: Number(process.hrtime.bigint() - started) / 1_000_000 }
    });
    return true;
  } catch (error) {
    input.metrics.gauge("control_plane_snapshot_ready", 0, {
      help: "Whether the worker has collected a complete control-plane business metrics snapshot."
    });
    input.metrics.counter("worker_snapshot_collection_errors_total", 1, {
      help: "Total worker observability snapshot collection failures."
    });
    input.health.setComponent("database", {
      state: "failed",
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function collectBillingMetrics(db: Database, metrics: RuntimeMetrics): Promise<void> {
  const stateResult = await db.query<{ state: string; accounts: number; debtMinor: string }>(`
    WITH states AS (
      SELECT unnest(ARRAY['active', 'grace', 'suspended']) AS state
    )
    SELECT
      states.state,
      COUNT(billing_account_states.account_id)::int AS accounts,
      COALESCE(SUM(billing_balance_buckets.debt_minor), 0)::text AS "debtMinor"
    FROM states
    LEFT JOIN billing_account_states ON billing_account_states.state = states.state
    LEFT JOIN billing_balance_buckets ON billing_balance_buckets.account_id = billing_account_states.account_id
    GROUP BY states.state
  `);
  for (const row of stateResult.rows) {
    metrics.gauge("control_plane_billing_accounts", row.accounts, {
      help: "Hyperspace billing accounts by lifecycle state.", labels: { state: row.state }
    });
    metrics.gauge("control_plane_billing_debt_minor", Number(row.debtMinor), {
      help: "Outstanding retail billing debt in currency minor units.", labels: { state: row.state, currency: "USD" }
    });
  }
  const queue = await db.query<{
    pending: number;
    oldestAgeSeconds: number;
    failedWithdrawals: number;
    pendingSweeps: number;
    failedSweeps: number;
    pendingSweepMinor: string;
    oldestSweepAgeSeconds: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::int FROM billing_notification_outbox WHERE status IN ('pending', 'failed')) AS pending,
      COALESCE((SELECT EXTRACT(EPOCH FROM now() - MIN(created_at))::float FROM billing_notification_outbox WHERE status IN ('pending', 'failed')), 0) AS "oldestAgeSeconds",
      (SELECT COUNT(*)::int FROM withdrawal_requests WHERE status = 'failed') AS "failedWithdrawals",
      (SELECT COUNT(*)::int FROM billing_cash_sweep_requests WHERE status IN ('pending', 'processing', 'submitted', 'failed')) AS "pendingSweeps",
      (SELECT COUNT(*)::int FROM billing_cash_sweep_requests WHERE status = 'failed') AS "failedSweeps",
      COALESCE((SELECT SUM(amount_minor)::text FROM billing_cash_sweep_requests WHERE status IN ('pending', 'processing', 'submitted', 'failed')), '0') AS "pendingSweepMinor",
      COALESCE((SELECT EXTRACT(EPOCH FROM now() - MIN(created_at))::float FROM billing_cash_sweep_requests WHERE status IN ('pending', 'processing', 'submitted', 'failed')), 0) AS "oldestSweepAgeSeconds"
  `);
  const row = queue.rows[0];
  if (!row) return;
  metrics.gauge("control_plane_billing_notification_backlog", row.pending, {
    help: "Pending or failed billing notification emails."
  });
  metrics.gauge("control_plane_billing_notification_oldest_age_seconds", row.oldestAgeSeconds, {
    help: "Age in seconds of the oldest pending billing notification."
  });
  metrics.gauge("control_plane_billing_failed_withdrawals", row.failedWithdrawals, {
    help: "Solana withdrawal requests currently requiring retry or operator review."
  });
  metrics.gauge("control_plane_billing_pending_cash_sweeps", row.pendingSweeps, {
    help: "Paid customer balance waiting to be settled into the Solana revenue treasury."
  });
  metrics.gauge("control_plane_billing_failed_cash_sweeps", row.failedSweeps, {
    help: "Solana revenue cash sweeps currently requiring retry or operator review."
  });
  metrics.gauge("control_plane_billing_pending_cash_sweep_minor", Number(row.pendingSweepMinor), {
    help: "Currency minor units waiting to be swept into the Solana revenue treasury.",
    labels: { currency: "USD" }
  });
  metrics.gauge("control_plane_billing_oldest_cash_sweep_age_seconds", row.oldestSweepAgeSeconds, {
    help: "Age in seconds of the oldest unconfirmed Solana revenue cash sweep."
  });
}

async function collectAssignmentUsageMetrics(db: Database, metrics: RuntimeMetrics): Promise<void> {
  const result = await db.query<{
    assignmentId: string;
    gate: string;
    role: string;
    generation: number;
    active: boolean;
    sampledAtAgeSeconds: number;
    forwardedToDestinationBytes: string;
    forwardedFromDestinationBytes: string;
    droppedToDestinationBytes: string;
    droppedFromDestinationBytes: string;
    wireGuardClientReceiveBytes: string;
    wireGuardClientTransmitBytes: string;
    wireGuardTransitReceiveBytes: string;
    wireGuardTransitTransmitBytes: string;
  }>(`
    SELECT DISTINCT ON (samples.assignment_id)
      samples.assignment_id AS "assignmentId",
      gates.name AS gate,
      samples.role,
      samples.generation,
      (gate_assignments.desired_state = 'Applied') AS active,
      EXTRACT(EPOCH FROM now() - samples.sampled_at)::float AS "sampledAtAgeSeconds",
      samples.forwarded_to_destination_bytes::text AS "forwardedToDestinationBytes",
      samples.forwarded_from_destination_bytes::text AS "forwardedFromDestinationBytes",
      samples.dropped_to_destination_bytes::text AS "droppedToDestinationBytes",
      samples.dropped_from_destination_bytes::text AS "droppedFromDestinationBytes",
      samples.wireguard_client_receive_bytes::text AS "wireGuardClientReceiveBytes",
      samples.wireguard_client_transmit_bytes::text AS "wireGuardClientTransmitBytes",
      samples.wireguard_transit_receive_bytes::text AS "wireGuardTransitReceiveBytes",
      samples.wireguard_transit_transmit_bytes::text AS "wireGuardTransitTransmitBytes"
    FROM gate_assignment_counter_samples samples
    JOIN gates ON gates.id = samples.gate_id
    JOIN gate_assignments ON gate_assignments.id = samples.assignment_id
    ORDER BY samples.assignment_id, samples.sampled_at DESC
  `);
  for (const row of result.rows) {
    const labels = {
      assignment_id: row.assignmentId,
      gate: row.gate,
      role: row.role,
      generation: row.generation,
      active: row.active
    };
    metrics.gauge("control_plane_assignment_counter_age_seconds", row.sampledAtAgeSeconds, {
      help: "Age of the latest centrally persisted gate assignment counter sample.",
      labels
    });
    for (const [direction, value] of [
      ["to_destination", row.forwardedToDestinationBytes],
      ["from_destination", row.forwardedFromDestinationBytes]
    ] as const) {
      metrics.gauge("control_plane_assignment_forwarded_bytes_total", Number(value), {
        help: "Latest monotonic forwarded payload byte counter reported by a gate assignment.",
        labels: { ...labels, direction }
      });
    }
    for (const [direction, value] of [
      ["to_destination", row.droppedToDestinationBytes],
      ["from_destination", row.droppedFromDestinationBytes]
    ] as const) {
      metrics.gauge("control_plane_assignment_dropped_bytes_total", Number(value), {
        help: "Latest monotonic policy drop byte counter reported by a gate assignment.",
        labels: { ...labels, direction }
      });
    }
    for (const [interfaceRole, direction, value] of [
      ["client", "receive", row.wireGuardClientReceiveBytes],
      ["client", "transmit", row.wireGuardClientTransmitBytes],
      ["transit", "receive", row.wireGuardTransitReceiveBytes],
      ["transit", "transmit", row.wireGuardTransitTransmitBytes]
    ] as const) {
      metrics.gauge("control_plane_assignment_wireguard_bytes_total", Number(value), {
        help: "Latest monotonic WireGuard byte counter reported by a gate assignment.",
        labels: { ...labels, interface_role: interfaceRole, direction }
      });
    }
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

  const gateResult = await db.query<{
    name: string;
    publicIpv4: string;
    probeUrl: string | null;
    enabled: boolean;
    agentConnected: boolean;
    ready: boolean;
    schedulable: boolean;
    doublezeroReady: boolean;
    lastSeenAgeSeconds: number | null;
    leaseSecondsUntilExpiry: number | null;
  }>(`
    SELECT
      gates.name,
      gates.public_ipv4 AS "publicIpv4",
      gates.spec->>'probeUrl' AS "probeUrl",
      (gates.desired_state = 'Enabled') AS enabled,
      (
        COALESCE(agent.status = 'True', false)
        AND COALESCE(gate_leases.lease_expires_at > now(), false)
      ) AS "agentConnected",
      (
        COALESCE(agent.status = 'True', false)
        AND COALESCE(gate_leases.lease_expires_at > now(), false)
        AND COALESCE(ready.status = 'True', false)
      ) AS ready,
      (
        gates.desired_state = 'Enabled'
        AND COALESCE(agent.status = 'True', false)
        AND COALESCE(gate_leases.lease_expires_at > now(), false)
        AND COALESCE(schedulable.status = 'True', false)
      ) AS schedulable,
      (
        'doublezero0:up' = ANY(gate_status.observed_capabilities)
        AND gate_status.doublezero_status->>'tunnelStatus' = 'BGP Session Up'
        AND gate_status.doublezero_status->>'network' = COALESCE(NULLIF(gates.spec->>'doubleZeroEnv', ''), 'testnet')
        AND gate_status.doublezero_status->>'tunnelSrc' = gates.public_ipv4
      ) AS "doublezeroReady",
      EXTRACT(EPOCH FROM now() - gate_status.last_seen_at)::float AS "lastSeenAgeSeconds",
      EXTRACT(EPOCH FROM gate_leases.lease_expires_at - now())::float AS "leaseSecondsUntilExpiry"
    FROM gates
    LEFT JOIN gate_status ON gate_status.gate_id = gates.id
    LEFT JOIN gate_leases ON gate_leases.gate_id = gates.id
    LEFT JOIN gate_conditions agent ON agent.gate_id = gates.id AND agent.type = 'AgentConnected'
    LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
    LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
    ORDER BY gates.name
  `);
  for (const gate of gateResult.rows) {
    const labels = {
      gate: gate.name,
      enabled: gate.enabled,
      probe_host: gateAlertProbeHost(gate.probeUrl, gate.publicIpv4),
      public_ipv4: gate.publicIpv4
    };
    metrics.gauge("control_plane_gate_agent_connected", gate.agentConnected ? 1 : 0, {
      help: "Per-gate agent connectivity based on condition state and fresh lease.",
      labels
    });
    metrics.gauge("control_plane_gate_ready", gate.ready ? 1 : 0, {
      help: "Per-gate Ready state based on gate lifecycle conditions.",
      labels
    });
    metrics.gauge("control_plane_gate_schedulable", gate.schedulable ? 1 : 0, {
      help: "Per-gate schedulability state.",
      labels
    });
    metrics.gauge("control_plane_gate_doublezero_ready", gate.doublezeroReady ? 1 : 0, {
      help: "Per-gate DoubleZero readiness state.",
      labels
    });
    metrics.gauge("control_plane_gate_last_seen_age_seconds", gate.lastSeenAgeSeconds ?? 1_000_000_000, {
      help: "Age of the last gate-agent heartbeat in seconds. Missing heartbeat is represented as a large value.",
      labels
    });
    metrics.gauge("control_plane_gate_lease_seconds_until_expiry", gate.leaseSecondsUntilExpiry ?? -1_000_000_000, {
      help: "Seconds until the gate-agent heartbeat lease expires. Missing lease is represented as a large negative value.",
      labels
    });
  }
}

export function gateAlertProbeHost(probeUrl: string | null | undefined, publicIpv4: string): string {
  if (!probeUrl) {
    return publicIpv4;
  }
  try {
    const parsed = new URL(probeUrl);
    return parsed.hostname || publicIpv4;
  } catch {
    return publicIpv4;
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
      JOIN gates source ON source.id = gate_benchmark_results.source_gate_id
      JOIN gates target ON target.id = gate_benchmark_results.target_gate_id
      WHERE source.desired_state = 'Enabled'
        AND target.desired_state = 'Enabled'
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

  const routeResult = await db.query<{
    sourceGate: string;
    targetGate: string;
    transport: string;
    status: string;
    rttP50Ms: number | null;
    jitterMs: number | null;
    lossPercent: number | null;
    ageSeconds: number | null;
  }>(`
    WITH latest AS (
      SELECT DISTINCT ON (source_gate_id, target_gate_id, transport)
        source_gate_id,
        target_gate_id,
        transport,
        status,
        rtt_p50_ms,
        jitter_ms,
        loss_percent,
        measured_at
      FROM gate_benchmark_results
      JOIN gates source ON source.id = gate_benchmark_results.source_gate_id
      JOIN gates target ON target.id = gate_benchmark_results.target_gate_id
      WHERE source.desired_state = 'Enabled'
        AND target.desired_state = 'Enabled'
      ORDER BY source_gate_id, target_gate_id, transport, measured_at DESC
    )
    SELECT
      source.name AS "sourceGate",
      target.name AS "targetGate",
      latest.transport,
      latest.status,
      latest.rtt_p50_ms AS "rttP50Ms",
      latest.jitter_ms AS "jitterMs",
      latest.loss_percent AS "lossPercent",
      EXTRACT(EPOCH FROM now() - latest.measured_at)::float AS "ageSeconds"
    FROM latest
    JOIN gates source ON source.id = latest.source_gate_id
    JOIN gates target ON target.id = latest.target_gate_id
    ORDER BY source.name, target.name, latest.transport
  `);
  for (const row of routeResult.rows) {
    const labels = {
      route: `${row.sourceGate} -> ${row.targetGate}`,
      source_gate: row.sourceGate,
      target_gate: row.targetGate,
      transport: row.transport
    };
    metrics.gauge("control_plane_benchmark_route_failed", row.status === "failed" ? 1 : 0, {
      help: "Latest gate benchmark route failure state. One means the latest sample failed.",
      labels
    });
    metrics.gauge("control_plane_benchmark_route_age_seconds", row.ageSeconds ?? 1_000_000_000, {
      help: "Age of the latest gate benchmark route sample in seconds.",
      labels
    });
    metrics.gauge("control_plane_benchmark_route_rtt_p50_ms", row.rttP50Ms ?? 0, {
      help: "Latest gate benchmark route RTT p50 in milliseconds.",
      labels
    });
    metrics.gauge("control_plane_benchmark_route_jitter_ms", row.jitterMs ?? 0, {
      help: "Latest gate benchmark route jitter in milliseconds.",
      labels
    });
    metrics.gauge("control_plane_benchmark_route_loss_percent", row.lossPercent ?? 100, {
      help: "Latest gate benchmark route packet loss percent.",
      labels
    });
  }
}
