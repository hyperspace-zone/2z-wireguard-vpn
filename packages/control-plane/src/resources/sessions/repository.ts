import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";
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

export interface SessionGenerationRow {
  id: string;
  generation: number;
}

export interface SessionPhaseRow {
  id: string;
  phase: string;
}

export interface SessionVisibilityRow {
  id: string;
  phase: string;
  hiddenAt: string | null;
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
  parsed: SessionCreateParsed,
  input: {
    initialPhase: string;
  }
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

    await client.query(
      `
        INSERT INTO session_status (session_id, phase)
        VALUES ($1, $2::session_phase)
      `,
      [sessionId, input.initialPhase]
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

export async function findOwnedSessionPhaseForUpdate(
  db: Queryable,
  actor: SessionOwner,
  sessionId: string
): Promise<SessionPhaseRow | null> {
  const session = await db.query<SessionPhaseRow>(
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
  return session.rows[0] ?? null;
}

export async function findSessionPhaseForUpdate(
  db: Queryable,
  sessionId: string
): Promise<SessionPhaseRow | null> {
  const session = await db.query<SessionPhaseRow>(
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
  return session.rows[0] ?? null;
}

export async function updateSessionDesiredState(
  db: Queryable,
  input: {
    sessionId: string;
    desiredState: string;
    incrementGeneration: boolean;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE sessions
      SET desired_state = $2::session_desired_state,
          generation = CASE WHEN $3::boolean THEN generation + 1 ELSE generation END,
          updated_at = now()
      WHERE id = $1
    `,
    [input.sessionId, input.desiredState, input.incrementGeneration]
  );
}

export async function updateSessionStatusPhase(
  db: Queryable,
  input: {
    sessionId: string;
    phase: string;
    observedGeneration?: number | null;
    selectedPath?: Record<string, unknown> | null;
    lastError?: Record<string, unknown> | null;
  }
): Promise<void> {
  const updateLastError = Object.hasOwn(input, "lastError");
  await db.query(
    `
      UPDATE session_status
      SET phase = $2::session_phase,
          observed_generation = COALESCE($3::bigint, observed_generation),
          selected_path = COALESCE($4::jsonb, selected_path),
          last_error = CASE WHEN $5::boolean THEN $6::jsonb ELSE last_error END,
          updated_at = now()
      WHERE session_id = $1
    `,
    [
      input.sessionId,
      input.phase,
      input.observedGeneration ?? null,
      input.selectedPath ? JSON.stringify(input.selectedPath) : null,
      updateLastError,
      JSON.stringify(input.lastError ?? null)
    ]
  );
}

export async function insertUserSessionRevokeRequestedAudit(
  db: Queryable,
  actor: SessionOwner,
  sessionId: string
): Promise<void> {
  await db.query(
    `
      INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, session_id)
      VALUES ('session_revoke_requested', 'user', $1, $2, $3)
    `,
    [actor.id, actor.accountId, sessionId]
  );
}

export async function insertSystemSessionRevokeRequestedAudit(
  db: Queryable,
  sessionId: string,
  reason: Record<string, unknown>
): Promise<void> {
  await db.query(
    `
      INSERT INTO audit_events (event_type, actor_type, session_id, details)
      VALUES ('session_revoke_requested', 'system', $1, $2::jsonb)
    `,
    [sessionId, JSON.stringify(reason)]
  );
}

export async function findOwnedSessionVisibilityForUpdate(
  db: Queryable,
  actor: SessionOwner,
  sessionId: string
): Promise<SessionVisibilityRow | null> {
  const existing = await db.query<SessionVisibilityRow>(
    `
      SELECT sessions.id, session_status.phase::text AS phase, sessions.hidden_at AS "hiddenAt"
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      WHERE sessions.id = $1 AND sessions.account_id = $2
    `,
    [sessionId, actor.accountId]
  );
  return existing.rows[0] ?? null;
}

export async function hideOwnedSession(
  db: Queryable,
  actor: SessionOwner,
  sessionId: string
): Promise<void> {
  await db.query(
    `
      UPDATE sessions
      SET hidden_at = now(), updated_at = now()
      WHERE id = $1 AND account_id = $2
    `,
    [sessionId, actor.accountId]
  );
}

export async function insertSessionHiddenAudit(
  db: Queryable,
  actor: SessionOwner,
  sessionId: string
): Promise<void> {
  await db.query(
    `
      INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, session_id)
      VALUES ('session_hidden', 'user', $1, $2, $3)
    `,
    [actor.id, actor.accountId, sessionId]
  );
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
  transition: {
    phase: string;
    lastError?: Record<string, unknown> | null;
  }
): Promise<void> {
  await db.query(
    "UPDATE session_status SET phase = $2::session_phase, last_error = $3::jsonb, updated_at = now() WHERE session_id = $1",
    [sessionId, transition.phase, JSON.stringify(transition.lastError)]
  );
}

export async function markSessionProvisioning(
  db: Queryable,
  sessionId: string,
  transition: {
    phase: string;
    observedGeneration?: number;
    lastError?: Record<string, unknown> | null;
  },
  selectedPath: Record<string, unknown>
): Promise<void> {
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
            AND jobs.phase IN ('queued', 'leased', 'running', 'retryable_failed', 'succeeded')
        )
      ORDER BY sessions.updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `
  );
  return sessions.rows;
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

export async function markSessionActive(
  db: Queryable,
  sessionId: string,
  transition: {
    phase: string;
    observedGeneration?: number;
    lastError?: Record<string, unknown> | null;
  }
): Promise<void> {
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

export async function listSessionsToBeginRevocation(db: Queryable): Promise<Array<{ id: string; phase: string }>> {
  const sessions = await db.query<{ id: string; phase: string }>(
    `
      SELECT sessions.id, session_status.phase::text AS phase
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

export async function markSessionRevoking(
  db: Queryable,
  sessionId: string,
  transition: {
    phase: string;
  }
): Promise<void> {
  await db.query("UPDATE session_status SET phase = $2::session_phase, updated_at = now() WHERE session_id = $1", [
    sessionId,
    transition.phase
  ]);
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

export async function markSessionRevoked(
  db: Queryable,
  sessionId: string,
  transition: {
    phase: string;
    observedGeneration?: number;
    lastError?: Record<string, unknown> | null;
  }
): Promise<void> {
  await db.query(
    "UPDATE session_status SET phase = $2::session_phase, observed_generation = $3, last_error = $4::jsonb, updated_at = now() WHERE session_id = $1",
    [sessionId, transition.phase, transition.observedGeneration ?? 0, JSON.stringify(transition.lastError ?? null)]
  );
}
