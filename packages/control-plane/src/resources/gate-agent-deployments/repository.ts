import type { GateAgentDeployment, GateAgentRelease } from "@hyperspace-zone/contracts";
import type { Queryable } from "../../db/queryable.js";

export interface CreateGateAgentReleaseInput {
  version: string;
  revision: string;
  builtAt: string;
  artifactSha256: string;
  createdBy: string;
}

export interface RequestGateAgentDeploymentInput {
  gateId: string;
  releaseId: string;
  requestedBy: string;
}

interface DeploymentRow {
  id: string;
  gateId: string;
  gateName: string;
  releaseId: string;
  releaseVersion: string;
  releaseRevision: string;
  releaseBuiltAt: string;
  releaseArtifactSha256: string;
  releaseCreatedAt: string;
  phase: GateAgentDeployment["phase"];
  previousAgentVersion: string | null;
  previousAgentRevision: string | null;
  previousArtifactSha256: string | null;
  requestedAt: string;
  stagedAt: string | null;
  installedAt: string | null;
  verifiedAt: string | null;
  rollbackRequestedAt: string | null;
  rollbackAttemptCount: number;
  rolledBackAt: string | null;
  failedAt: string | null;
  verificationDeadlineAt: string;
  failureCode: string | null;
  failureMessage: string | null;
  updatedAt: string;
}

export interface DeploymentReconcileRow {
  id: string;
  gateId: string;
  gateName: string;
  phase: string;
  targetArtifactSha256: string;
  previousArtifactSha256: string | null;
  stagedAt: string | null;
  verificationDeadlineAt: string;
  observedArtifactSha256: string | null;
  observedInstalledAt: string | null;
  lastSeenAt: string | null;
  observedCapabilities: string[];
  agentConnected: boolean;
  rollbackAttemptCount: number;
}

export async function insertGateAgentRelease(
  db: Queryable,
  input: CreateGateAgentReleaseInput
): Promise<GateAgentRelease> {
  const inserted = await db.query<GateAgentRelease>(
    `
      INSERT INTO gate_agent_releases (
        version,
        revision,
        built_at,
        artifact_sha256,
        created_by
      )
      VALUES ($1, $2, $3::timestamptz, $4, $5)
      ON CONFLICT (artifact_sha256) DO NOTHING
      RETURNING
        id,
        version,
        revision,
        built_at AS "builtAt",
        artifact_sha256 AS "artifactSha256",
        created_at AS "createdAt"
    `,
    [input.version, input.revision, input.builtAt, input.artifactSha256, input.createdBy]
  );
  if (inserted.rows[0]) {
    return inserted.rows[0];
  }
  const existing = await readGateAgentReleaseBySha(db, input.artifactSha256);
  if (!existing) {
    throw new Error("gate-agent release insert conflicted but existing row was not found");
  }
  if (
    existing.version !== input.version
    || existing.revision !== input.revision
    || new Date(existing.builtAt).toISOString() !== new Date(input.builtAt).toISOString()
  ) {
    throw new Error("artifact SHA-256 is already registered with different immutable metadata");
  }
  return existing;
}

export async function readGateAgentRelease(db: Queryable, releaseId: string): Promise<GateAgentRelease | null> {
  const result = await db.query<GateAgentRelease>(
    `${releaseSelectSql()} WHERE id = $1`,
    [releaseId]
  );
  return result.rows[0] ?? null;
}

export async function readGateAgentReleaseForGate(
  db: Queryable,
  releaseId: string,
  gateId: string
): Promise<GateAgentRelease | null> {
  const result = await db.query<GateAgentRelease>(
    `${releaseSelectSql()}
     WHERE id = $1
       AND EXISTS (
         SELECT 1
         FROM gate_agent_deployments
         WHERE gate_agent_deployments.release_id = gate_agent_releases.id
           AND gate_agent_deployments.gate_id = $2
           AND gate_agent_deployments.phase IN ('queued', 'staging', 'verifying')
       )`,
    [releaseId, gateId]
  );
  return result.rows[0] ?? null;
}

export async function readGateAgentReleaseBySha(db: Queryable, artifactSha256: string): Promise<GateAgentRelease | null> {
  const result = await db.query<GateAgentRelease>(
    `${releaseSelectSql()} WHERE artifact_sha256 = $1`,
    [artifactSha256]
  );
  return result.rows[0] ?? null;
}

export async function listGateAgentReleases(db: Queryable): Promise<GateAgentRelease[]> {
  const result = await db.query<GateAgentRelease>(`${releaseSelectSql()} ORDER BY created_at DESC`);
  return result.rows;
}

export async function insertGateAgentDeployment(
  db: Queryable,
  input: RequestGateAgentDeploymentInput
): Promise<string | "gate_not_found" | "gate_not_bootstrapped" | "release_not_found" | "deployment_active"> {
  const gate = await db.query<{
    id: string;
    agentVersion: string | null;
    agentRevision: string | null;
    artifactSha256: string | null;
    observedCapabilities: string[];
  }>(
    `
      SELECT
        gates.id,
        gate_status.agent_version AS "agentVersion",
        gate_status.agent_revision AS "agentRevision",
        gate_status.agent_artifact_sha256 AS "artifactSha256",
        COALESCE(gate_status.observed_capabilities, '{}'::text[]) AS "observedCapabilities"
      FROM gates
      LEFT JOIN gate_status ON gate_status.gate_id = gates.id
      WHERE gates.id = $1
      FOR UPDATE OF gates
    `,
    [input.gateId]
  );
  if (!gate.rows[0]) {
    return "gate_not_found";
  }
  if (!gate.rows[0].observedCapabilities.includes("control-plane-agent-rollout:v1")) {
    return "gate_not_bootstrapped";
  }
  const release = await readGateAgentRelease(db, input.releaseId);
  if (!release) {
    return "release_not_found";
  }
  const active = await db.query<{ id: string }>(
    `
      SELECT id
      FROM gate_agent_deployments
      WHERE gate_id = $1
        AND phase IN ('queued', 'staging', 'verifying', 'rollback_requested', 'rolling_back')
      LIMIT 1
    `,
    [input.gateId]
  );
  if (active.rows[0]) {
    return "deployment_active";
  }

  const created = await db.query<{ id: string }>(
    `
      INSERT INTO gate_agent_deployments (
        gate_id,
        release_id,
        previous_agent_version,
        previous_agent_revision,
        previous_artifact_sha256,
        requested_by
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
    [
      input.gateId,
      input.releaseId,
      gate.rows[0].agentVersion,
      gate.rows[0].agentRevision,
      gate.rows[0].artifactSha256,
      input.requestedBy
    ]
  );
  const deploymentId = created.rows[0]?.id;
  if (!deploymentId) {
    throw new Error("expected gate-agent deployment row");
  }
  await insertDeploymentEvent(db, deploymentId, "requested", {
    releaseId: release.id,
    targetArtifactSha256: release.artifactSha256,
    previousArtifactSha256: gate.rows[0].artifactSha256
  });
  await insertAgentDeploymentJob(db, {
    type: "deploy_agent",
    gateId: input.gateId,
    deploymentId,
    release
  });
  return deploymentId;
}

export async function readGateAgentDeployment(db: Queryable, deploymentId: string): Promise<GateAgentDeployment | null> {
  const result = await db.query<DeploymentRow>(
    `${deploymentSelectSql()} WHERE deployments.id = $1`,
    [deploymentId]
  );
  return result.rows[0] ? mapDeployment(result.rows[0]) : null;
}

export async function listGateAgentDeployments(db: Queryable, gateId?: string): Promise<GateAgentDeployment[]> {
  const result = await db.query<DeploymentRow>(
    `${deploymentSelectSql()}
     WHERE ($1::uuid IS NULL OR deployments.gate_id = $1)
     ORDER BY deployments.requested_at DESC`,
    [gateId || null]
  );
  return result.rows.map(mapDeployment);
}

export async function markDeploymentJobReported(
  db: Queryable,
  input: {
    deploymentId: string;
    jobType: "deploy_agent" | "rollback_agent";
    succeeded: boolean;
    terminalFailure: boolean;
    errorCode: string;
    resultSummary: Record<string, unknown>;
  }
): Promise<void> {
  if (!input.succeeded && !input.terminalFailure) {
    await insertDeploymentEvent(db, input.deploymentId, "job_retryable_failed", {
      jobType: input.jobType,
      errorCode: input.errorCode,
      resultSummary: input.resultSummary
    });
    return;
  }
  const phase = input.succeeded
    ? input.jobType === "deploy_agent" ? "verifying" : "rolling_back"
    : "failed";
  await db.query(
    `
      UPDATE gate_agent_deployments
      SET phase = $2,
          staged_at = CASE WHEN $2 = 'verifying' THEN now() ELSE staged_at END,
          failed_at = CASE WHEN $2 = 'failed' THEN now() ELSE failed_at END,
          verification_deadline_at = now() + interval '5 minutes',
          failure_code = CASE WHEN $2 = 'failed' THEN NULLIF($3, '') ELSE NULL END,
          failure_message = CASE WHEN $2 = 'failed' THEN NULLIF($4, '') ELSE NULL END,
          updated_at = now()
      WHERE id = $1
        AND phase NOT IN ('succeeded', 'rolled_back', 'failed')
    `,
    [input.deploymentId, phase, input.errorCode, JSON.stringify(input.resultSummary)]
  );
  await insertDeploymentEvent(db, input.deploymentId, input.succeeded ? "job_staged" : "job_failed", {
    jobType: input.jobType,
    errorCode: input.errorCode,
    resultSummary: input.resultSummary
  });
}

export async function listDeploymentsForReconcile(db: Queryable): Promise<DeploymentReconcileRow[]> {
  const result = await db.query<DeploymentReconcileRow>(
    `
      SELECT
        deployments.id,
        deployments.gate_id AS "gateId",
        gates.name AS "gateName",
        deployments.phase,
        releases.artifact_sha256 AS "targetArtifactSha256",
        deployments.previous_artifact_sha256 AS "previousArtifactSha256",
        deployments.staged_at AS "stagedAt",
        deployments.verification_deadline_at AS "verificationDeadlineAt",
        deployments.rollback_attempt_count AS "rollbackAttemptCount",
        gate_status.agent_artifact_sha256 AS "observedArtifactSha256",
        gate_status.agent_installed_at AS "observedInstalledAt",
        gate_status.last_seen_at AS "lastSeenAt",
        COALESCE(gate_status.observed_capabilities, '{}'::text[]) AS "observedCapabilities",
        COALESCE(agent.status = 'True', false)
          AND gate_leases.lease_expires_at > now() AS "agentConnected"
      FROM gate_agent_deployments deployments
      JOIN gate_agent_releases releases ON releases.id = deployments.release_id
      JOIN gates ON gates.id = deployments.gate_id
      LEFT JOIN gate_status ON gate_status.gate_id = deployments.gate_id
      LEFT JOIN gate_conditions agent
        ON agent.gate_id = deployments.gate_id AND agent.type = 'AgentConnected'
      LEFT JOIN gate_leases ON gate_leases.gate_id = deployments.gate_id
      WHERE deployments.phase IN ('queued', 'staging', 'verifying', 'rollback_requested', 'rolling_back')
      ORDER BY deployments.requested_at
    `
  );
  return result.rows;
}

export async function markDeploymentSucceeded(
  db: Queryable,
  deploymentId: string,
  installedAt: string | null
): Promise<void> {
  await db.query(
    `
      UPDATE gate_agent_deployments
      SET phase = 'succeeded',
          installed_at = COALESCE($2::timestamptz, now()),
          verified_at = now(),
          failure_code = NULL,
          failure_message = NULL,
          updated_at = now()
      WHERE id = $1
        AND phase IN ('staging', 'verifying')
    `,
    [deploymentId, installedAt]
  );
  await insertDeploymentEvent(db, deploymentId, "verified", { installedAt });
}

export async function requestDeploymentRollback(
  db: Queryable,
  deploymentId: string,
  requestedBy: string,
  reason: string
): Promise<"queued" | "not_found" | "no_previous_release" | "not_rollbackable"> {
  const row = await db.query<{ gateId: string; previousArtifactSha256: string | null; phase: string }>(
    `
      SELECT
        gate_id AS "gateId",
        previous_artifact_sha256 AS "previousArtifactSha256",
        phase
      FROM gate_agent_deployments
      WHERE id = $1
      FOR UPDATE
    `,
    [deploymentId]
  );
  if (!row.rows[0]) return "not_found";
  if (!row.rows[0].previousArtifactSha256) return "no_previous_release";
  if (!["succeeded", "staging", "verifying", "failed"].includes(row.rows[0].phase)) return "not_rollbackable";
  const otherActive = await db.query<{ id: string }>(
    `
      SELECT id
      FROM gate_agent_deployments
      WHERE gate_id = $1
        AND id <> $2
        AND phase IN ('queued', 'staging', 'verifying', 'rollback_requested', 'rolling_back')
      LIMIT 1
    `,
    [row.rows[0].gateId, deploymentId]
  );
  if (otherActive.rows[0]) return "not_rollbackable";
  await db.query(
    `
      UPDATE gate_agent_deployments
      SET phase = 'rollback_requested',
          rollback_requested_at = now(),
          rollback_attempt_count = 1,
          verification_deadline_at = now() + interval '5 minutes',
          updated_at = now()
      WHERE id = $1
    `,
    [deploymentId]
  );
  await insertRollbackJob(db, {
    gateId: row.rows[0].gateId,
    deploymentId,
    artifactSha256: row.rows[0].previousArtifactSha256
  });
  await insertDeploymentEvent(db, deploymentId, "rollback_requested", { requestedBy, reason });
  return "queued";
}

export async function retryDeploymentRollback(
  db: Queryable,
  deploymentId: string
): Promise<boolean> {
  const row = await db.query<{ gateId: string; previousArtifactSha256: string }>(
    `
      UPDATE gate_agent_deployments
      SET rollback_attempt_count = rollback_attempt_count + 1,
          verification_deadline_at = now() + interval '5 minutes',
          updated_at = now()
      WHERE id = $1
        AND phase IN ('rollback_requested', 'rolling_back')
        AND previous_artifact_sha256 IS NOT NULL
        AND rollback_attempt_count < 3
      RETURNING
        gate_id AS "gateId",
        previous_artifact_sha256 AS "previousArtifactSha256"
    `,
    [deploymentId]
  );
  const retry = row.rows[0];
  if (!retry) return false;
  await insertRollbackJob(db, {
    gateId: retry.gateId,
    deploymentId,
    artifactSha256: retry.previousArtifactSha256
  });
  await insertDeploymentEvent(db, deploymentId, "rollback_retried", {});
  return true;
}

export async function markDeploymentRolledBack(db: Queryable, deploymentId: string): Promise<void> {
  await db.query(
    `
      UPDATE gate_agent_deployments
      SET phase = 'rolled_back',
          rolled_back_at = now(),
          updated_at = now()
      WHERE id = $1
        AND phase IN ('staging', 'verifying', 'rollback_requested', 'rolling_back')
    `,
    [deploymentId]
  );
  await insertDeploymentEvent(db, deploymentId, "rolled_back", {});
}

export async function markDeploymentFailed(
  db: Queryable,
  deploymentId: string,
  code: string,
  message: string
): Promise<void> {
  await db.query(
    `
      UPDATE gate_agent_deployments
      SET phase = 'failed',
          failed_at = now(),
          failure_code = $2,
          failure_message = $3,
          updated_at = now()
      WHERE id = $1
        AND phase NOT IN ('succeeded', 'rolled_back', 'failed')
    `,
    [deploymentId, code, message]
  );
  await insertDeploymentEvent(db, deploymentId, "failed", { code, message });
}

async function insertAgentDeploymentJob(
  db: Queryable,
  input: { type: "deploy_agent"; gateId: string; deploymentId: string; release: GateAgentRelease }
): Promise<void> {
  await db.query(
    `
      INSERT INTO jobs (type, phase, gate_id, payload, max_retries)
      VALUES ('deploy_agent', 'queued', $1, $2::jsonb, 2)
    `,
    [
      input.gateId,
      JSON.stringify({
        deploymentId: input.deploymentId,
        releaseId: input.release.id,
        version: input.release.version,
        revision: input.release.revision,
        builtAt: input.release.builtAt,
        artifactSha256: input.release.artifactSha256
      })
    ]
  );
}

export async function insertRollbackJob(
  db: Queryable,
  input: { gateId: string; deploymentId: string; artifactSha256: string }
): Promise<void> {
  await db.query(
    `
      INSERT INTO jobs (type, phase, gate_id, payload, max_retries)
      SELECT 'rollback_agent', 'queued', $1, $2::jsonb, 2
      WHERE NOT EXISTS (
        SELECT 1 FROM jobs
        WHERE gate_id = $1
          AND type = 'rollback_agent'
          AND payload->>'deploymentId' = $3
          AND phase IN ('queued', 'leased', 'running', 'retryable_failed')
      )
    `,
    [
      input.gateId,
      JSON.stringify({ deploymentId: input.deploymentId, artifactSha256: input.artifactSha256 }),
      input.deploymentId
    ]
  );
}

export async function insertDeploymentEvent(
  db: Queryable,
  deploymentId: string,
  eventType: string,
  details: Record<string, unknown>
): Promise<void> {
  await db.query(
    `
      INSERT INTO gate_agent_deployment_events (deployment_id, event_type, details)
      VALUES ($1, $2, $3::jsonb)
    `,
    [deploymentId, eventType, JSON.stringify(details)]
  );
}

function releaseSelectSql(): string {
  return `
    SELECT
      id,
      version,
      revision,
      built_at AS "builtAt",
      artifact_sha256 AS "artifactSha256",
      created_at AS "createdAt"
    FROM gate_agent_releases
  `;
}

function deploymentSelectSql(): string {
  return `
    SELECT
      deployments.id,
      deployments.gate_id AS "gateId",
      gates.name AS "gateName",
      releases.id AS "releaseId",
      releases.version AS "releaseVersion",
      releases.revision AS "releaseRevision",
      releases.built_at AS "releaseBuiltAt",
      releases.artifact_sha256 AS "releaseArtifactSha256",
      releases.created_at AS "releaseCreatedAt",
      deployments.phase,
      deployments.previous_agent_version AS "previousAgentVersion",
      deployments.previous_agent_revision AS "previousAgentRevision",
      deployments.previous_artifact_sha256 AS "previousArtifactSha256",
      deployments.requested_at AS "requestedAt",
      deployments.staged_at AS "stagedAt",
      deployments.installed_at AS "installedAt",
      deployments.verified_at AS "verifiedAt",
      deployments.rollback_requested_at AS "rollbackRequestedAt",
      deployments.rollback_attempt_count AS "rollbackAttemptCount",
      deployments.rolled_back_at AS "rolledBackAt",
      deployments.failed_at AS "failedAt",
      deployments.verification_deadline_at AS "verificationDeadlineAt",
      deployments.failure_code AS "failureCode",
      deployments.failure_message AS "failureMessage",
      deployments.updated_at AS "updatedAt"
    FROM gate_agent_deployments deployments
    JOIN gate_agent_releases releases ON releases.id = deployments.release_id
    JOIN gates ON gates.id = deployments.gate_id
  `;
}

function mapDeployment(row: DeploymentRow): GateAgentDeployment {
  return {
    id: row.id,
    gateId: row.gateId,
    gateName: row.gateName,
    release: {
      id: row.releaseId,
      version: row.releaseVersion,
      revision: row.releaseRevision,
      builtAt: row.releaseBuiltAt,
      artifactSha256: row.releaseArtifactSha256,
      createdAt: row.releaseCreatedAt
    },
    phase: row.phase,
    previousAgentVersion: row.previousAgentVersion,
    previousAgentRevision: row.previousAgentRevision,
    previousArtifactSha256: row.previousArtifactSha256,
    requestedAt: row.requestedAt,
    stagedAt: row.stagedAt,
    installedAt: row.installedAt,
    verifiedAt: row.verifiedAt,
    rollbackRequestedAt: row.rollbackRequestedAt,
    rollbackAttemptCount: row.rollbackAttemptCount,
    rolledBackAt: row.rolledBackAt,
    failedAt: row.failedAt,
    verificationDeadlineAt: row.verificationDeadlineAt,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    updatedAt: row.updatedAt
  };
}
