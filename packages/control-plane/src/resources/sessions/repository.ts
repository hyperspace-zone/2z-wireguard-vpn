import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";
import { artifactInvalidatedTransition } from "../artifacts/transitions.js";
import {
  deadForProvisioningFailureTransition,
  desiredRevokedTransition,
  provisioningFailureDeadCandidatePhases,
  queuedForCommitTransition
} from "../gate-assignments/transitions.js";
import { deadForSessionFailureTransition, queuedJobTransition, sessionFailureDeadCandidateJobPhases } from "../jobs/transitions.js";
import {
  activeTransition,
  beginRevokingTransition,
  canHideSession,
  failedTransition,
  provisioningTransition,
  requestRevocationTransition,
  requestedSessionInitialTransition,
  revokedTransition,
  type SessionPhase
} from "./transitions.js";
import type { SessionCreateParsed } from "./validation.js";

export interface RequestedSessionRow {
  id: string;
  generation: number;
  mode: string;
  destinationCidrs: string[];
  sourceCidr: string | null;
  clientPublicKey: string | null;
  spec: Record<string, unknown>;
}

export interface PreparedSessionRow {
  id: string;
  generation: number;
  planId: string;
  publicMaterial: Record<string, unknown>;
  routingModel: Record<string, unknown>;
  firewallModel: Record<string, unknown>;
}

export interface SessionAssignmentMaterialRow {
  id: string;
  gateId: string;
  role: "Ingress" | "Egress";
  externalHandle: string;
  gateName: string;
  publicEndpoint: string;
  localMaterial: Record<string, unknown>;
}

export interface SessionGenerationRow {
  id: string;
  generation: number;
}

export interface PendingAssignmentPhaseRow {
  gateName: string;
  role: "Ingress" | "Egress";
  phase: string;
}

export interface RevocableAssignmentRow {
  assignmentId: string;
  gateId: string;
  sessionId: string;
  role: "Ingress" | "Egress";
}

export type SessionConditionStatus = "True" | "False" | "Unknown";

export interface SessionOwner {
  id: string;
  accountId: string;
}

export async function upsertSessionCondition(
  db: Queryable,
  input: {
    sessionId: string;
    type: string;
    status: SessionConditionStatus;
    reason: string;
    message: string;
    observedGeneration: number;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO session_conditions (
        session_id,
        type,
        status,
        reason,
        message,
        observed_generation,
        last_transition_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (session_id, type) DO UPDATE
      SET status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          message = EXCLUDED.message,
          observed_generation = EXCLUDED.observed_generation,
          last_transition_at = CASE
            WHEN session_conditions.status <> EXCLUDED.status THEN now()
            ELSE session_conditions.last_transition_at
          END
    `,
    [
      input.sessionId,
      input.type,
      input.status,
      input.reason,
      input.message,
      input.observedGeneration
    ]
  );
}

export async function insertRequestedSession(
  db: TransactionalQueryable,
  actor: SessionOwner,
  parsed: SessionCreateParsed
): Promise<string> {
  return db.transaction(async (client) => {
    const session = await client.query<{ id: string }>(
      `
        INSERT INTO sessions (
          account_id,
          mode,
          destination_cidrs,
          source_cidr,
          client_public_key,
          label,
          spec,
          path_policy,
          artifact_policy
        )
        VALUES ($1, $2, $3::cidr[], $4::cidr, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
        RETURNING id
      `,
      [
        actor.accountId,
        parsed.mode,
        parsed.destinationCidrs,
        parsed.sourceCidr ?? null,
        parsed.clientPublicKey ?? null,
        parsed.label ?? null,
        JSON.stringify(parsed.spec),
        JSON.stringify(parsed.spec.pathPolicy ?? {}),
        JSON.stringify(parsed.spec.artifactPolicy ?? {})
      ]
    );
    const sessionId = mustRow(session).id;

    const initialStatus = requestedSessionInitialTransition();
    await client.query(
      `
        INSERT INTO session_status (session_id, phase)
        VALUES ($1, $2::session_phase)
      `,
      [sessionId, initialStatus.phase]
    );
    await client.query(
      `
        INSERT INTO session_conditions (
          session_id,
          type,
          status,
          reason,
          message,
          observed_generation
        )
        VALUES ($1, 'Ready', 'False', 'Requested', 'Session accepted and waiting for reconciliation', 0)
      `,
      [sessionId]
    );
    await client.query(
      `
        INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, session_id, details)
        VALUES ('session_requested', 'user', $1, $2, $3, $4::jsonb)
      `,
      [actor.id, actor.accountId, sessionId, JSON.stringify({ mode: parsed.mode })]
    );
    return sessionId;
  });
}

export async function requestSessionRevocation(
  db: TransactionalQueryable,
  actor: SessionOwner,
  sessionId: string
): Promise<boolean> {
  return db.transaction(async (client) => {
    const session = await client.query<{ id: string; phase: SessionPhase }>(
      `
        SELECT sessions.id, session_status.phase::text AS phase
        FROM sessions
        JOIN session_status ON session_status.session_id = sessions.id
        WHERE sessions.id = $1
          AND sessions.account_id = $2
          AND sessions.hidden_at IS NULL
        FOR UPDATE
      `,
      [sessionId, actor.accountId]
    );
    if (session.rowCount === 0) {
      return false;
    }
    const row = mustRow(session);
    const transition = requestRevocationTransition(row.phase);

    await client.query(
      `
        UPDATE sessions
        SET desired_state = $2::session_desired_state,
            generation = CASE WHEN $3::boolean THEN generation + 1 ELSE generation END,
            updated_at = now()
        WHERE id = $1
      `,
      [sessionId, transition.desiredState, transition.incrementGeneration]
    );
    await client.query(
      `
        UPDATE session_status
        SET phase = $2::session_phase,
            updated_at = now()
        WHERE session_id = $1
      `,
      [sessionId, transition.statusTransition.phase]
    );
    await client.query(
      `
        INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, session_id)
        VALUES ('session_revoke_requested', 'user', $1, $2, $3)
      `,
      [actor.id, actor.accountId, sessionId]
    );
    return true;
  });
}

export async function requestSystemSessionRevocation(
  db: Queryable,
  sessionId: string,
  reason: Record<string, unknown>
): Promise<boolean> {
  const session = await db.query<{ id: string; phase: SessionPhase }>(
    `
      SELECT sessions.id, session_status.phase::text AS phase
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      WHERE sessions.id = $1
        AND sessions.hidden_at IS NULL
      FOR UPDATE
    `,
    [sessionId]
  );
  const row = session.rows[0];
  if (!row) {
    return false;
  }

  const transition = requestRevocationTransition(row.phase);
  await db.query(
    `
      UPDATE sessions
      SET desired_state = $2::session_desired_state,
          generation = CASE WHEN $3::boolean THEN generation + 1 ELSE generation END,
          updated_at = now()
      WHERE id = $1
    `,
    [sessionId, transition.desiredState, transition.incrementGeneration]
  );
  await db.query(
    `
      UPDATE session_status
      SET phase = $2::session_phase,
          updated_at = now()
      WHERE session_id = $1
    `,
    [sessionId, transition.statusTransition.phase]
  );
  await db.query(
    `
      INSERT INTO audit_events (event_type, actor_type, session_id, details)
      VALUES ('session_revoke_requested', 'system', $1, $2::jsonb)
    `,
    [sessionId, JSON.stringify(reason)]
  );
  return true;
}

export async function hideRevokedOrFailedSession(
  db: TransactionalQueryable,
  actor: SessionOwner,
  sessionId: string
): Promise<"deleted" | "not_found" | "not_revoked"> {
  return db.transaction(async (client) => {
    const existing = await client.query<{ id: string; phase: string; hiddenAt: string | null }>(
      `
        SELECT sessions.id, session_status.phase::text AS phase, sessions.hidden_at AS "hiddenAt"
        FROM sessions
        JOIN session_status ON session_status.session_id = sessions.id
        WHERE sessions.id = $1 AND sessions.account_id = $2
      `,
      [sessionId, actor.accountId]
    );
    const row = existing.rows[0];
    if (!row) {
      return "not_found" as const;
    }
    const decision = canHideSession(row.phase as SessionPhase, row.hiddenAt);
    if (decision !== "can_hide") {
      return decision;
    }

    await client.query(
      `
        UPDATE sessions
        SET hidden_at = now(), updated_at = now()
        WHERE id = $1 AND account_id = $2
      `,
      [sessionId, actor.accountId]
    );
    await client.query(
      `
        INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, session_id)
        VALUES ('session_hidden', 'user', $1, $2, $3)
      `,
      [actor.id, actor.accountId, sessionId]
    );
    return "deleted" as const;
  });
}

export async function listRequestedSessionsForUpdate(db: Queryable): Promise<RequestedSessionRow[]> {
  const sessions = await db.query<RequestedSessionRow>(
    `
      SELECT
        sessions.id,
        sessions.generation::int,
        sessions.mode::text AS mode,
        ARRAY(SELECT unnest(sessions.destination_cidrs)::text) AS "destinationCidrs",
        sessions.source_cidr::text AS "sourceCidr",
        sessions.client_public_key AS "clientPublicKey",
        sessions.spec
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      WHERE sessions.desired_state = 'Active'
        AND session_status.phase = 'requested'
      ORDER BY sessions.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 20
    `
  );
  return sessions.rows;
}

export async function markSessionFailed(
  db: Queryable,
  sessionId: string,
  error: { code: string; message: string }
): Promise<void> {
  const transition = failedTransition(error);
  await db.query(
    "UPDATE session_status SET phase = $2::session_phase, last_error = $3::jsonb, updated_at = now() WHERE session_id = $1",
    [sessionId, transition.phase, JSON.stringify(transition.lastError)]
  );
}

export async function upsertRenderedPlan(
  db: Queryable,
  input: {
    sessionId: string;
    generation: number;
    planHash: string;
    publicMaterial: Record<string, unknown>;
    routingModel: Record<string, unknown>;
    firewallModel: Record<string, unknown>;
    secretRefs: Record<string, unknown>;
  }
): Promise<string> {
  const planRow = await db.query<{ id: string }>(
    `
      INSERT INTO rendered_plans (
        session_id,
        generation,
        plan_hash,
        public_material,
        routing_model,
        firewall_model,
        secret_refs
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
      ON CONFLICT (session_id, generation) DO UPDATE
      SET plan_hash = EXCLUDED.plan_hash,
          public_material = EXCLUDED.public_material,
          routing_model = EXCLUDED.routing_model,
          firewall_model = EXCLUDED.firewall_model,
          secret_refs = EXCLUDED.secret_refs
      RETURNING id
    `,
    [
      input.sessionId,
      input.generation,
      input.planHash,
      JSON.stringify(input.publicMaterial),
      JSON.stringify(input.routingModel),
      JSON.stringify(input.firewallModel),
      JSON.stringify(input.secretRefs)
    ]
  );
  const row = planRow.rows[0];
  if (!row) {
    throw new Error("expected rendered plan row");
  }
  return row.id;
}

export async function markSessionProvisioning(
  db: Queryable,
  sessionId: string,
  generation: number,
  selectedPath: Record<string, unknown>
): Promise<void> {
  const transition = provisioningTransition(generation, selectedPath);
  await db.query(
    `
      UPDATE session_status
      SET phase = $2::session_phase,
          selected_path = $3::jsonb,
          observed_generation = $4,
          last_error = $5::jsonb,
          updated_at = now()
      WHERE session_id = $1
    `,
    [
      sessionId,
      transition.phase,
      JSON.stringify(selectedPath),
      transition.observedGeneration ?? 0,
      JSON.stringify(transition.lastError ?? null)
    ]
  );
}

export async function listSessionsReadyForCommit(db: Queryable): Promise<PreparedSessionRow[]> {
  const sessions = await db.query<PreparedSessionRow>(
    `
      SELECT
        sessions.id,
        sessions.generation::int,
        rendered_plans.id AS "planId",
        rendered_plans.public_material AS "publicMaterial",
        rendered_plans.routing_model AS "routingModel",
        rendered_plans.firewall_model AS "firewallModel"
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      JOIN rendered_plans
        ON rendered_plans.session_id = sessions.id
       AND rendered_plans.generation = sessions.generation
      WHERE session_status.phase = 'provisioning'
        AND (
          SELECT COUNT(*)
          FROM gate_assignments
          JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
          WHERE gate_assignments.session_id = sessions.id
            AND gate_assignment_status.phase = 'prepared'
        ) = 2
        AND NOT EXISTS (
          SELECT 1
          FROM jobs
          WHERE jobs.session_id = sessions.id
            AND jobs.type = 'apply_assignment'
            AND jobs.payload->>'operation' = 'commit'
            AND jobs.phase IN ('queued', 'leased', 'running', 'retryable_failed')
        )
      ORDER BY sessions.updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `
  );
  return sessions.rows;
}

export async function listSessionAssignmentMaterials(
  db: Queryable,
  sessionId: string
): Promise<SessionAssignmentMaterialRow[]> {
  const assignments = await db.query<SessionAssignmentMaterialRow>(
    `
      SELECT
        gate_assignments.id,
        gate_assignments.gate_id AS "gateId",
        gate_assignments.role::text AS role,
        gate_assignments.external_handle AS "externalHandle",
        gates.name AS "gateName",
        gates.public_endpoint AS "publicEndpoint",
        gate_assignment_status.local_material AS "localMaterial"
      FROM gate_assignments
      JOIN gates ON gates.id = gate_assignments.gate_id
      JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
      WHERE gate_assignments.session_id = $1
      ORDER BY gate_assignments.role ASC
    `,
    [sessionId]
  );
  return assignments.rows;
}

export async function markPreparedAssignmentsQueued(
  db: Queryable,
  ingressAssignmentId: string,
  egressAssignmentId: string
): Promise<void> {
  const transition = queuedForCommitTransition();
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $3::gate_assignment_phase,
          updated_at = now()
      WHERE assignment_id IN ($1, $2)
        AND phase = 'prepared'
    `,
    [ingressAssignmentId, egressAssignmentId, transition]
  );
}

export async function touchSessionStatus(db: Queryable, sessionId: string): Promise<void> {
  await db.query("UPDATE session_status SET updated_at = now() WHERE session_id = $1", [sessionId]);
}

export async function listProvisionedSessionsForActivation(db: Queryable): Promise<SessionGenerationRow[]> {
  const sessions = await db.query<SessionGenerationRow>(
    `
      SELECT sessions.id, sessions.generation::int
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      WHERE session_status.phase = 'provisioning'
        AND (
          SELECT COUNT(*)
          FROM gate_assignments
          JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
          WHERE gate_assignments.session_id = sessions.id
            AND gate_assignment_status.phase = 'applied'
        ) = 2
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `
  );
  return sessions.rows;
}

export async function hasActiveClientConfigArtifact(db: Queryable, sessionId: string): Promise<boolean> {
  const existingArtifact = await db.query(
    "SELECT 1 FROM artifacts WHERE session_id = $1 AND artifact_type = 'client_config' AND invalidated_at IS NULL",
    [sessionId]
  );
  return (existingArtifact.rowCount ?? 0) > 0;
}

export async function markSessionActive(db: Queryable, sessionId: string, generation: number): Promise<void> {
  const transition = activeTransition(generation);
  await db.query(
    `
      UPDATE session_status
      SET phase = $2::session_phase,
          observed_generation = $3,
          last_error = $4::jsonb,
          updated_at = now()
      WHERE session_id = $1
    `,
    [sessionId, transition.phase, transition.observedGeneration ?? 0, JSON.stringify(transition.lastError ?? null)]
  );
}

export async function insertSessionAuditEvent(
  db: Queryable,
  eventType: "session_active" | "session_failed" | "session_revoked",
  sessionId: string,
  details: Record<string, unknown>
): Promise<void> {
  await db.query(
    `
      INSERT INTO audit_events (event_type, actor_type, session_id, details)
      VALUES ($1, 'system', $2, $3::jsonb)
    `,
    [eventType, sessionId, JSON.stringify(details)]
  );
}

export async function listTimedOutProvisioningSessions(
  db: Queryable,
  provisioningTimeoutSeconds: number
): Promise<SessionGenerationRow[]> {
  const sessions = await db.query<SessionGenerationRow>(
    `
      SELECT sessions.id, sessions.generation::int
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      WHERE sessions.desired_state = 'Active'
        AND session_status.phase = 'provisioning'
        AND session_status.updated_at < now() - ($1::int * interval '1 second')
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `,
    [provisioningTimeoutSeconds]
  );
  return sessions.rows;
}

export async function listAssignmentPhasesForSession(
  db: Queryable,
  sessionId: string
): Promise<PendingAssignmentPhaseRow[]> {
  const assignments = await db.query<PendingAssignmentPhaseRow>(
    `
      SELECT
        gates.name AS "gateName",
        gate_assignments.role::text AS role,
        gate_assignment_status.phase::text AS phase
      FROM gate_assignments
      JOIN gates ON gates.id = gate_assignments.gate_id
      JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
      WHERE gate_assignments.session_id = $1
      ORDER BY gate_assignments.role ASC
    `,
    [sessionId]
  );
  return assignments.rows;
}

export async function markApplyJobsDeadForSession(db: Queryable, sessionId: string): Promise<void> {
  const transition = deadForSessionFailureTransition("queued");
  await db.query(
    `
      UPDATE jobs
      SET phase = $2::job_phase,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE session_id = $1
        AND type = 'apply_assignment'
        AND phase = ANY($3::job_phase[])
    `,
    [sessionId, transition, sessionFailureDeadCandidateJobPhases]
  );
}

export async function markPendingAssignmentsDeadForSession(
  db: Queryable,
  sessionId: string,
  error: Record<string, unknown>
): Promise<void> {
  const transition = deadForProvisioningFailureTransition("queued");
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $2::gate_assignment_phase,
          last_error = $3::jsonb,
          updated_at = now()
      FROM gate_assignments
      WHERE gate_assignment_status.assignment_id = gate_assignments.id
        AND gate_assignments.session_id = $1
        AND gate_assignment_status.phase = ANY($4::gate_assignment_phase[])
    `,
    [sessionId, transition, JSON.stringify(error), provisioningFailureDeadCandidatePhases]
  );
}

export async function invalidateSessionArtifacts(db: Queryable, sessionId: string): Promise<void> {
  const transition = artifactInvalidatedTransition();
  await db.query(
    `
      UPDATE artifacts
      SET invalidated_at = now(),
          phase = $2
      WHERE session_id = $1
        AND invalidated_at IS NULL
    `,
    [sessionId, transition]
  );
}

export async function listSessionsToBeginRevocation(db: Queryable): Promise<Array<{ id: string }>> {
  const sessions = await db.query<{ id: string }>(
    `
      SELECT sessions.id
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      WHERE sessions.desired_state = 'Revoked'
        AND session_status.phase NOT IN ('revoking', 'revoked', 'failed')
      ORDER BY sessions.updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `
  );
  return sessions.rows;
}

export async function markSessionRevoking(db: Queryable, sessionId: string): Promise<void> {
  const current = await db.query<{ phase: SessionPhase }>(
    "SELECT phase::text AS phase FROM session_status WHERE session_id = $1 FOR UPDATE",
    [sessionId]
  );
  const row = current.rows[0];
  if (!row) {
    return;
  }
  const transition = beginRevokingTransition(row.phase);
  if (!transition) {
    return;
  }
  await db.query("UPDATE session_status SET phase = $2::session_phase, updated_at = now() WHERE session_id = $1", [
    sessionId,
    transition.phase
  ]);
}

export async function listAssignmentsToRevoke(db: Queryable): Promise<RevocableAssignmentRow[]> {
  const assignments = await db.query<RevocableAssignmentRow>(
    `
      SELECT
        gate_assignments.id AS "assignmentId",
        gate_assignments.gate_id AS "gateId",
        gate_assignments.session_id AS "sessionId",
        gate_assignments.role::text AS role
      FROM gate_assignments
      JOIN sessions ON sessions.id = gate_assignments.session_id
      JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
      WHERE sessions.desired_state = 'Revoked'
        AND gate_assignments.desired_state <> 'Revoked'
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    `
  );
  return assignments.rows;
}

export async function markAssignmentDesiredRevoked(db: Queryable, assignmentId: string): Promise<void> {
  const transition = desiredRevokedTransition();
  await db.query(
    `
      UPDATE gate_assignments
      SET desired_state = $2::gate_assignment_desired_state,
          generation = CASE WHEN $3::boolean THEN generation + 1 ELSE generation END,
          updated_at = now()
      WHERE id = $1
    `,
    [assignmentId, transition.desiredState, transition.incrementGeneration]
  );
}

export async function markAssignmentRevoking(db: Queryable, assignmentId: string): Promise<void> {
  const transition = desiredRevokedTransition();
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $2::gate_assignment_phase,
          updated_at = now()
      WHERE assignment_id = $1
        AND phase <> 'revoked'
    `,
    [assignmentId, transition.statusPhase]
  );
}

export async function enqueueRevokeAssignmentJob(db: Queryable, assignment: RevocableAssignmentRow): Promise<void> {
  const initialPhase = queuedJobTransition();
  await db.query(
    `
      INSERT INTO jobs (type, phase, gate_id, session_id, assignment_id, payload)
      VALUES ('revoke_assignment', $5::job_phase, $1, $2, $3, $4::jsonb)
    `,
    [
      assignment.gateId,
      assignment.sessionId,
      assignment.assignmentId,
      JSON.stringify({ assignmentId: assignment.assignmentId, role: assignment.role }),
      initialPhase
    ]
  );
}

export async function listSessionsReadyToMarkRevoked(db: Queryable): Promise<SessionGenerationRow[]> {
  const sessions = await db.query<SessionGenerationRow>(
    `
      SELECT sessions.id, sessions.generation::int
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      WHERE session_status.phase = 'revoking'
        AND NOT EXISTS (
          SELECT 1
          FROM gate_assignments
          JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
          WHERE gate_assignments.session_id = sessions.id
            AND gate_assignment_status.phase <> 'revoked'
        )
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `
  );
  return sessions.rows;
}

export async function markSessionRevoked(db: Queryable, sessionId: string, generation: number): Promise<void> {
  const transition = revokedTransition(generation);
  await db.query(
    "UPDATE session_status SET phase = $2::session_phase, observed_generation = $3, last_error = $4::jsonb, updated_at = now() WHERE session_id = $1",
    [sessionId, transition.phase, transition.observedGeneration ?? 0, JSON.stringify(transition.lastError ?? null)]
  );
}
