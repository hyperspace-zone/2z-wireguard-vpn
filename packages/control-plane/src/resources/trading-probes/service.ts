import { randomBytes } from "node:crypto";
import type {
  PublicTradingLatencyResponse,
  TradingProbeJob,
  TradingProbeMetricSummary,
  TradingProbeTarget
} from "@hyperspace-zone/contracts";
import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { sha256Hex } from "../../security/tokens.js";
import type { AuthenticatedTradingProbeNode } from "../../security/trading-probe-auth.js";

export interface TradingProbeHeartbeat {
  bootId: string;
  agentVersion: string;
  agentRevision?: string;
  agentBuiltAt?: string;
  agentArtifactSha256?: string;
  agentInstalledAt?: string;
  observedEndpoint?: string;
  capabilities: string[];
  networkProfiles: string[];
  spoolDepth: number;
  selfTest: Record<string, unknown>;
}

export async function recordTradingProbeHeartbeat(
  db: TransactionalQueryable,
  node: AuthenticatedTradingProbeNode,
  report: TradingProbeHeartbeat
): Promise<void> {
  await db.transaction(async (client) => {
    await client.query(
      `
        INSERT INTO trading_probe_node_status (
          probe_node_id, observed_generation, boot_id, agent_version, agent_revision,
          agent_built_at, agent_artifact_sha256, agent_installed_at, observed_endpoint,
          observed_capabilities, active_network_profiles, spool_depth, last_self_test,
          last_seen_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, '')::timestamptz,
          NULLIF($7, ''), NULLIF($8, '')::timestamptz, NULLIF($9, ''), $10::text[],
          $11::text[], $12, $13::jsonb, now(), now()
        )
        ON CONFLICT (probe_node_id) DO UPDATE SET
          observed_generation = EXCLUDED.observed_generation,
          boot_id = EXCLUDED.boot_id,
          agent_version = EXCLUDED.agent_version,
          agent_revision = EXCLUDED.agent_revision,
          agent_built_at = EXCLUDED.agent_built_at,
          agent_artifact_sha256 = EXCLUDED.agent_artifact_sha256,
          agent_installed_at = EXCLUDED.agent_installed_at,
          observed_endpoint = EXCLUDED.observed_endpoint,
          observed_capabilities = EXCLUDED.observed_capabilities,
          active_network_profiles = EXCLUDED.active_network_profiles,
          spool_depth = EXCLUDED.spool_depth,
          last_self_test = EXCLUDED.last_self_test,
          last_seen_at = now(),
          updated_at = now()
      `,
      [
        node.id,
        node.generation,
        report.bootId,
        report.agentVersion,
        report.agentRevision ?? "",
        report.agentBuiltAt ?? "",
        report.agentArtifactSha256 ?? "",
        report.agentInstalledAt ?? "",
        report.observedEndpoint ?? "",
        report.capabilities,
        report.networkProfiles,
        report.spoolDepth,
        JSON.stringify(report.selfTest)
      ]
    );
    await client.query(
      `
        INSERT INTO trading_probe_leases (
          probe_node_id, lease_owner, lease_expires_at, heartbeat_at
        ) VALUES ($1, $2, now() + interval '60 seconds', now())
        ON CONFLICT (probe_node_id) DO UPDATE SET
          lease_owner = EXCLUDED.lease_owner,
          lease_expires_at = EXCLUDED.lease_expires_at,
          heartbeat_at = now()
      `,
      [node.id, node.name]
    );
  });
}

export async function scheduleTradingProbeJobs(db: Queryable, enabled: boolean): Promise<number> {
  if (!enabled) return 0;
  await db.query(
    `
      UPDATE trading_probe_jobs
      SET phase = CASE WHEN retry_count >= max_retries THEN 'dead' ELSE 'queued' END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          run_after = CASE
            WHEN retry_count >= max_retries THEN run_after
            ELSE now() + make_interval(secs => LEAST(60, GREATEST(2, retry_count * retry_count * 2)))
          END,
          updated_at = now()
      WHERE phase = 'leased'
        AND lease_expires_at < now()
    `
  );
  const result = await db.query<{ id: string }>(
    `
      INSERT INTO trading_probe_jobs (
        probe_node_id, target_id, target_revision, network_profile, payload
      )
      SELECT
        nodes.id,
        targets.id,
        targets.revision,
        'direct',
        jsonb_build_object('kind', 'trading_latency_v1')
      FROM trading_probe_nodes nodes
      JOIN trading_probe_leases leases ON leases.probe_node_id = nodes.id
      CROSS JOIN trading_probe_targets targets
      LEFT JOIN trading_latency_latest latest
        ON latest.probe_node_id = nodes.id
       AND latest.target_id = targets.id
       AND latest.network_profile = 'direct'
      WHERE nodes.desired_state = 'Enabled'
        AND leases.lease_expires_at > now()
        AND targets.enabled = true
        AND (
          latest.measured_at IS NULL
          OR latest.measured_at < now() - make_interval(secs => targets.interval_seconds)
          OR latest.target_revision <> targets.revision
        )
      ON CONFLICT (probe_node_id, target_id, network_profile)
        WHERE phase IN ('queued', 'leased')
      DO NOTHING
      RETURNING id
    `
  );
  return result.rowCount ?? result.rows.length;
}

export async function claimTradingProbeJob(
  db: TransactionalQueryable,
  node: AuthenticatedTradingProbeNode,
  leaseOwner: string
): Promise<TradingProbeJob | null> {
  if (node.desiredState !== "Enabled") return null;
  return db.transaction(async (client) => {
    const selected = await client.query<TradingProbeJobRow>(
      `
        SELECT
          jobs.id,
          jobs.retry_count + 1 AS "attemptNumber",
          jobs.network_profile AS "networkProfile",
          targets.id AS "targetId",
          targets.target_key AS "targetKey",
          targets.revision AS "targetRevision",
          targets.category,
          targets.display_name AS "displayName",
          targets.product,
          targets.protocol,
          targets.scheme,
          targets.hostname,
          targets.port,
          targets.path,
          targets.request_method AS method,
          targets.request_headers AS headers,
          targets.request_body AS body,
          targets.expected_status AS "expectedStatus",
          targets.expected_body_contains AS "expectedBodyContains",
          targets.response_kind AS "responseKind",
          targets.timeout_ms AS "timeoutMs",
          targets.sample_count AS "sampleCount",
          targets.interval_seconds AS "intervalSeconds",
          targets.metadata
        FROM trading_probe_jobs jobs
        JOIN trading_probe_targets targets ON targets.id = jobs.target_id
        WHERE jobs.probe_node_id = $1
          AND jobs.phase = 'queued'
          AND jobs.run_after <= now()
          AND targets.enabled = true
        -- Claim the oldest queued work before applying catalog presentation
        -- order. Otherwise short-interval, low sort_order targets can enqueue a
        -- second run before the tail of a larger catalog has ever been sampled.
        ORDER BY jobs.created_at, targets.sort_order, jobs.id
        FOR UPDATE OF jobs SKIP LOCKED
        LIMIT 1
      `,
      [node.id]
    );
    const row = selected.rows[0];
    if (!row) return null;
    const leaseExpiresAt = new Date(Date.now() + 45_000).toISOString();
    await client.query(
      `
        UPDATE trading_probe_jobs
        SET phase = 'leased', lease_owner = $2, lease_expires_at = $3,
            retry_count = retry_count + 1, updated_at = now()
        WHERE id = $1
      `,
      [row.id, leaseOwner, leaseExpiresAt]
    );
    await client.query(
      `
        INSERT INTO trading_probe_job_attempts (
          job_id, attempt_number, lease_owner, lease_expires_at
        ) VALUES ($1, $2, $3, $4)
      `,
      [row.id, row.attemptNumber, leaseOwner, leaseExpiresAt]
    );
    return rowToJob(row);
  });
}

export async function recordTradingProbeJobReport(
  db: TransactionalQueryable,
  node: AuthenticatedTradingProbeNode,
  jobId: string,
  attemptNumber: number,
  result: TradingProbeMetricSummary
): Promise<boolean> {
  return db.transaction(async (client) => {
    const job = await client.query<{ targetId: string; targetRevision: number; networkProfile: string }>(
      `
        SELECT target_id AS "targetId", target_revision AS "targetRevision",
               network_profile AS "networkProfile"
        FROM trading_probe_jobs
        WHERE id = $1 AND probe_node_id = $2 AND phase = 'leased'
        FOR UPDATE
      `,
      [jobId, node.id]
    );
    const row = job.rows[0];
    if (!row) return false;
    const status = result.status === "succeeded" ? "succeeded" : "failed";
    const attempt = await client.query(
      `
        UPDATE trading_probe_job_attempts
        SET completed_at = now(), status = $3, error_code = NULLIF($4, ''),
            result_summary = $5::jsonb
        WHERE job_id = $1 AND attempt_number = $2 AND completed_at IS NULL
      `,
      [jobId, attemptNumber, status, result.errorCode ?? "", JSON.stringify(result)]
    );
    if ((attempt.rowCount ?? 0) === 0) return false;
    await client.query(
      `UPDATE trading_probe_jobs SET phase = $2, lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [jobId, status]
    );
    const metrics = metricValues(result);
    await client.query(
      `
        INSERT INTO trading_latency_latest (
          probe_node_id, target_id, network_profile, target_revision, status,
          measured_at, dns_ms, tcp_ms, tls_ms, ttfb_ms, total_p50_ms,
          total_p95_ms, total_min_ms, total_max_ms, jitter_ms, sample_count,
          failure_count, http_status, response_class, resolved_ip, error_code,
          error_message, agent_version, agent_revision, updated_at
        )
        SELECT $1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18, NULLIF($19, ''),
               NULLIF($20, ''), NULLIF($21, ''), NULLIF($22, ''),
               status.agent_version, status.agent_revision, now()
        FROM trading_probe_node_status status
        WHERE status.probe_node_id = $1
        ON CONFLICT (probe_node_id, target_id, network_profile) DO UPDATE SET
          target_revision = EXCLUDED.target_revision,
          status = EXCLUDED.status,
          measured_at = EXCLUDED.measured_at,
          dns_ms = EXCLUDED.dns_ms, tcp_ms = EXCLUDED.tcp_ms,
          tls_ms = EXCLUDED.tls_ms, ttfb_ms = EXCLUDED.ttfb_ms,
          total_p50_ms = EXCLUDED.total_p50_ms, total_p95_ms = EXCLUDED.total_p95_ms,
          total_min_ms = EXCLUDED.total_min_ms, total_max_ms = EXCLUDED.total_max_ms,
          jitter_ms = EXCLUDED.jitter_ms, sample_count = EXCLUDED.sample_count,
          failure_count = EXCLUDED.failure_count, http_status = EXCLUDED.http_status,
          response_class = EXCLUDED.response_class, resolved_ip = EXCLUDED.resolved_ip,
          error_code = EXCLUDED.error_code, error_message = EXCLUDED.error_message,
          agent_version = EXCLUDED.agent_version, agent_revision = EXCLUDED.agent_revision,
          updated_at = now()
      `,
      [
        node.id,
        row.targetId,
        row.networkProfile,
        row.targetRevision,
        status,
        result.measuredAt,
        ...metrics
      ]
    );
    const measuredAt = new Date(result.measuredAt);
    const bucketStart = new Date(Math.floor(measuredAt.getTime() / 300_000) * 300_000).toISOString();
    const bucketEnd = new Date(new Date(bucketStart).getTime() + 300_000).toISOString();
    await client.query(
      `
        INSERT INTO trading_latency_rollups (
          probe_node_id, target_id, network_profile, target_revision,
          bucket_start, bucket_end, status, total_min_ms, total_p50_ms,
          total_p95_ms, total_max_ms, jitter_ms, sample_count, failure_count,
          error_code
        ) VALUES (
          $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7,
          $8, $9, $10, $11, $12, $13, $14, NULLIF($15, '')
        )
        ON CONFLICT (probe_node_id, target_id, network_profile, bucket_start)
        DO UPDATE SET
          status = EXCLUDED.status, total_min_ms = EXCLUDED.total_min_ms,
          total_p50_ms = EXCLUDED.total_p50_ms, total_p95_ms = EXCLUDED.total_p95_ms,
          total_max_ms = EXCLUDED.total_max_ms, jitter_ms = EXCLUDED.jitter_ms,
          sample_count = EXCLUDED.sample_count, failure_count = EXCLUDED.failure_count,
          error_code = EXCLUDED.error_code
      `,
      [
        node.id, row.targetId, row.networkProfile, row.targetRevision,
        bucketStart, bucketEnd, status,
        finiteOrNull(result.totalMinMs), finiteOrNull(result.totalP50Ms),
        finiteOrNull(result.totalP95Ms), finiteOrNull(result.totalMaxMs),
        finiteOrNull(result.jitterMs), result.sampleCount, result.failureCount,
        result.errorCode ?? ""
      ]
    );
    await client.query(
      `UPDATE trading_probe_node_status SET last_report_at = now(), updated_at = now() WHERE probe_node_id = $1`,
      [node.id]
    );
    return true;
  });
}

export async function readPublicTradingLatency(db: Queryable): Promise<PublicTradingLatencyResponse> {
  const [nodes, targets, measurements] = await Promise.all([
    db.query<PublicTradingLatencyResponse["nodes"][number]>(
      `
        SELECT nodes.id, nodes.name, nodes.city, nodes.country,
               nodes.latitude::float AS latitude, nodes.longitude::float AS longitude,
               nodes.provider, nodes.region_code AS "regionCode",
               COALESCE(status.last_seen_at > now() - interval '90 seconds', false) AS fresh,
               status.last_seen_at AS "lastSeenAt"
        FROM trading_probe_nodes nodes
        LEFT JOIN trading_probe_node_status status ON status.probe_node_id = nodes.id
        WHERE nodes.desired_state <> 'Disabled'
        ORDER BY nodes.name
      `
    ),
    db.query<PublicTradingLatencyResponse["targets"][number]>(
      `
        SELECT id, target_key AS key, category, display_name AS "displayName", product,
               protocol, COALESCE(metadata->>'measurement', protocol) AS measurement,
               sort_order AS "sortOrder"
        FROM trading_probe_targets
        WHERE enabled = true
        ORDER BY sort_order, target_key
      `
    ),
    db.query<PublicTradingLatencyResponse["measurements"][number]>(
      `
        SELECT probe_node_id AS "nodeId", target_id AS "targetId",
               network_profile AS "networkProfile", status, measured_at AS "measuredAt",
               dns_ms AS "dnsMs", tcp_ms AS "tcpMs", tls_ms AS "tlsMs",
               ttfb_ms AS "ttfbMs", total_p50_ms AS "totalP50Ms",
               total_p95_ms AS "totalP95Ms", jitter_ms AS "jitterMs",
               sample_count AS "sampleCount", failure_count AS "failureCount",
               error_code AS "errorCode"
        FROM trading_latency_latest
        ORDER BY target_id, total_p50_ms NULLS LAST
      `
    )
  ]);
  return {
    generatedAt: new Date().toISOString(),
    nodes: nodes.rows.map(stripUndefined),
    targets: targets.rows,
    measurements: measurements.rows.map(stripUndefined)
  } as PublicTradingLatencyResponse;
}

export async function createTradingProbeNode(
  db: TransactionalQueryable,
  input: {
    name: string;
    desiredState: "Enabled" | "Maintenance" | "Disabled";
    placementKind: "gate_host" | "testnode" | "dedicated";
    gateName?: string;
    city: string;
    country: string;
    latitude: number;
    longitude: number;
    provider: string;
    regionCode: string;
  }
): Promise<{ id: string; name: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  return db.transaction(async (client) => {
    const node = await client.query<{ id: string; name: string }>(
      `
        INSERT INTO trading_probe_nodes (
          name, desired_state, placement_kind, gate_id, city, country,
          latitude, longitude, provider, region_code
        ) VALUES (
          $1, $2, $3, (SELECT id FROM gates WHERE name = NULLIF($4, '')),
          $5, $6, $7, $8, $9, $10
        )
        ON CONFLICT (name) DO UPDATE SET
          desired_state = EXCLUDED.desired_state,
          placement_kind = EXCLUDED.placement_kind,
          gate_id = EXCLUDED.gate_id,
          city = EXCLUDED.city, country = EXCLUDED.country,
          latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
          provider = EXCLUDED.provider, region_code = EXCLUDED.region_code,
          generation = trading_probe_nodes.generation + 1,
          updated_at = now()
        RETURNING id, name
      `,
      [
        input.name, input.desiredState, input.placementKind, input.gateName ?? "",
        input.city, input.country, input.latitude, input.longitude,
        input.provider, input.regionCode
      ]
    );
    const created = node.rows[0];
    if (!created) throw new Error("trading probe node was not created");
    await client.query(
      `UPDATE trading_probe_auth_tokens SET revoked_at = now() WHERE probe_node_id = $1 AND revoked_at IS NULL`,
      [created.id]
    );
    await client.query(
      `INSERT INTO trading_probe_auth_tokens (probe_node_id, token_hash) VALUES ($1, $2)`,
      [created.id, sha256Hex(token)]
    );
    return { ...created, token };
  });
}

export async function cleanupTradingProbeHistory(db: Queryable): Promise<{
  jobsDeleted: number;
  rollupsDeleted: number;
}> {
  const jobs = await db.query<{ id: string }>(
    `
      DELETE FROM trading_probe_jobs
      WHERE phase IN ('succeeded', 'failed', 'dead')
        AND updated_at < now() - interval '7 days'
      RETURNING id
    `
  );
  const rollups = await db.query<{ id: string }>(
    `
      DELETE FROM trading_latency_rollups
      WHERE bucket_start < now() - interval '90 days'
      RETURNING id
    `
  );
  return {
    jobsDeleted: jobs.rowCount ?? jobs.rows.length,
    rollupsDeleted: rollups.rowCount ?? rollups.rows.length
  };
}

interface TradingProbeJobRow {
  id: string;
  attemptNumber: number;
  networkProfile: string;
  targetId: string;
  targetKey: string;
  targetRevision: number;
  category: string;
  displayName: string;
  product: string;
  protocol: TradingProbeTarget["protocol"];
  scheme: TradingProbeTarget["scheme"];
  hostname: string;
  port: number;
  path: string;
  method: TradingProbeTarget["method"];
  headers: Record<string, string>;
  body: unknown;
  expectedStatus: number;
  expectedBodyContains: string | null;
  responseKind: TradingProbeTarget["responseKind"];
  timeoutMs: number;
  sampleCount: number;
  intervalSeconds: number;
  metadata: Record<string, unknown>;
}

function rowToJob(row: TradingProbeJobRow): TradingProbeJob {
  return {
    id: row.id,
    attemptNumber: Number(row.attemptNumber),
    networkProfile: row.networkProfile,
    target: {
      id: row.targetId,
      key: row.targetKey,
      revision: Number(row.targetRevision),
      category: row.category,
      displayName: row.displayName,
      product: row.product,
      protocol: row.protocol,
      scheme: row.scheme,
      hostname: row.hostname,
      port: Number(row.port),
      path: row.path,
      method: row.method,
      headers: row.headers ?? {},
      ...(row.body === null ? {} : { body: row.body }),
      expectedStatus: Number(row.expectedStatus),
      ...(row.expectedBodyContains ? { expectedBodyContains: row.expectedBodyContains } : {}),
      responseKind: row.responseKind,
      timeoutMs: Number(row.timeoutMs),
      sampleCount: Number(row.sampleCount),
      intervalSeconds: Number(row.intervalSeconds),
      metadata: row.metadata ?? {}
    }
  };
}

function metricValues(result: TradingProbeMetricSummary): unknown[] {
  return [
    finiteOrNull(result.dnsMs), finiteOrNull(result.tcpMs), finiteOrNull(result.tlsMs),
    finiteOrNull(result.ttfbMs), finiteOrNull(result.totalP50Ms), finiteOrNull(result.totalP95Ms),
    finiteOrNull(result.totalMinMs), finiteOrNull(result.totalMaxMs), finiteOrNull(result.jitterMs),
    result.sampleCount, result.failureCount, result.httpStatus ?? null,
    result.responseClass ?? "", result.resolvedIp ?? "", result.errorCode ?? "",
    result.errorMessage ?? ""
  ];
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined)) as T;
}
