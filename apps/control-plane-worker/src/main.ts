import { createHash } from "node:crypto";
import { createDatabase } from "@hyperspace-zone/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pollMs = Number(process.env.WORKER_POLL_MS ?? 2000);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

const db = createDatabase({
  connectionString: databaseUrl,
  applicationName: "hyperspace-control-plane-worker"
});

log({ event: "worker_started", workerId, pollMs });

process.on("SIGTERM", () => {
  log({ event: "worker_stopping", workerId });
  void db.close().then(() => process.exit(0));
});

while (true) {
  try {
    await reconcileOnce();
  } catch (error) {
    log({
      event: "worker_reconcile_error",
      workerId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  await sleep(pollMs);
}

async function reconcileOnce(): Promise<void> {
  await markStaleGates();
  await expireSessions();
  await beginRevocation();
  await scheduleRequestedSessions();
  await completeProvisionedSessions();
  await completeRevokedSessions();
  await requeueExpiredJobs();
}

async function markStaleGates(): Promise<void> {
  await db.query(
    `
      INSERT INTO gate_conditions (
        gate_id,
        type,
        status,
        reason,
        message,
        observed_generation,
        last_transition_at
      )
      SELECT
        gates.id,
        'AgentConnected',
        'False',
        'HeartbeatStale',
        'Gate agent heartbeat is stale',
        gates.generation,
        now()
      FROM gates
      LEFT JOIN gate_status ON gate_status.gate_id = gates.id
      WHERE gate_status.last_seen_at IS NULL
         OR gate_status.last_seen_at < now() - interval '45 seconds'
      ON CONFLICT (gate_id, type) DO UPDATE
      SET status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          message = EXCLUDED.message,
          observed_generation = EXCLUDED.observed_generation,
          last_transition_at = CASE
            WHEN gate_conditions.status <> EXCLUDED.status THEN now()
            ELSE gate_conditions.last_transition_at
          END
    `
  );
}

async function expireSessions(): Promise<void> {
  await db.query(
    `
      UPDATE sessions
      SET desired_state = 'Revoked',
          generation = generation + 1,
          updated_at = now()
      FROM session_status
      WHERE session_status.session_id = sessions.id
        AND sessions.desired_state = 'Active'
        AND session_status.phase IN ('active', 'degraded', 'provisioning')
        AND session_status.effective_expiry_at IS NOT NULL
        AND session_status.effective_expiry_at <= now()
    `
  );
  await db.query(
    `
      UPDATE session_status
      SET phase = 'revoking',
          updated_at = now()
      FROM sessions
      WHERE session_status.session_id = sessions.id
        AND sessions.desired_state = 'Revoked'
        AND session_status.phase IN ('active', 'degraded', 'provisioning')
    `
  );
}

async function beginRevocation(): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await client.query<{ id: string }>(
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

    for (const session of sessions.rows) {
      await client.query(
        "UPDATE session_status SET phase = 'revoking', updated_at = now() WHERE session_id = $1",
        [session.id]
      );
    }

    const assignments = await client.query<{
      assignmentId: string;
      gateId: string;
      sessionId: string;
    }>(
      `
        SELECT
          gate_assignments.id AS "assignmentId",
          gate_assignments.gate_id AS "gateId",
          gate_assignments.session_id AS "sessionId"
        FROM gate_assignments
        JOIN sessions ON sessions.id = gate_assignments.session_id
        JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
        WHERE sessions.desired_state = 'Revoked'
          AND gate_assignments.desired_state <> 'Revoked'
        FOR UPDATE SKIP LOCKED
        LIMIT 100
      `
    );

    for (const assignment of assignments.rows) {
      await client.query(
        `
          UPDATE gate_assignments
          SET desired_state = 'Revoked',
              generation = generation + 1,
              updated_at = now()
          WHERE id = $1
        `,
        [assignment.assignmentId]
      );
      await client.query(
        `
          UPDATE gate_assignment_status
          SET phase = 'revoking',
              updated_at = now()
          WHERE assignment_id = $1
            AND phase <> 'revoked'
        `,
        [assignment.assignmentId]
      );
      await client.query(
        `
          INSERT INTO jobs (type, phase, gate_id, session_id, assignment_id, payload)
          VALUES ('revoke_assignment', 'queued', $1, $2, $3, $4::jsonb)
        `,
        [
          assignment.gateId,
          assignment.sessionId,
          assignment.assignmentId,
          JSON.stringify({ assignmentId: assignment.assignmentId })
        ]
      );
    }
  });
}

async function scheduleRequestedSessions(): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await client.query<{
      id: string;
      generation: number;
      mode: string;
      destinationCidrs: string[];
      sourceCidr: string | null;
      clientPublicKey: string | null;
      spec: Record<string, unknown>;
    }>(
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

    for (const session of sessions.rows) {
      const path = await choosePath(client, session.spec);
      if (!path) {
        await setSessionCondition(
          client,
          session.id,
          "Ready",
          "False",
          "NoSchedulablePath",
          "No ready ingress/egress gate pair is currently schedulable",
          session.generation
        );
        await client.query(
          "UPDATE session_status SET phase = 'scheduling', updated_at = now() WHERE session_id = $1",
          [session.id]
        );
        continue;
      }

      const plan = renderPlan(session, path);
      const planRow = await client.query<{ id: string }>(
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
          SET plan_hash = EXCLUDED.plan_hash
          RETURNING id
        `,
        [
          session.id,
          session.generation,
          plan.planHash,
          JSON.stringify(plan.publicMaterial),
          JSON.stringify(plan.routingModel),
          JSON.stringify(plan.firewallModel),
          JSON.stringify(plan.secretRefs)
        ]
      );
      const planId = mustRow(planRow).id;

      const ingressAssignment = await createAssignment(client, {
        sessionId: session.id,
        gateId: path.ingressGateId,
        role: "Ingress",
        planId
      });
      const egressAssignment = await createAssignment(client, {
        sessionId: session.id,
        gateId: path.egressGateId,
        role: "Egress",
        planId
      });

      await enqueueApplyJob(client, ingressAssignment, path.ingressGateId, session.id, plan);
      await enqueueApplyJob(client, egressAssignment, path.egressGateId, session.id, plan);
      await client.query(
        `
          UPDATE session_status
          SET phase = 'provisioning',
              selected_path = $2::jsonb,
              observed_generation = $3,
              updated_at = now()
          WHERE session_id = $1
        `,
        [
          session.id,
          JSON.stringify({
            ingressGateId: path.ingressGateId,
            ingressGateName: path.ingressGateName,
            egressGateId: path.egressGateId,
            egressGateName: path.egressGateName
          }),
          session.generation
        ]
      );
      await setSessionCondition(
        client,
        session.id,
        "Ready",
        "False",
        "Provisioning",
        "Ingress and egress gate assignments are being applied",
        session.generation
      );
    }
  });
}

async function completeProvisionedSessions(): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await client.query<{ id: string; generation: number }>(
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

    for (const session of sessions.rows) {
      const existingArtifact = await client.query(
        "SELECT 1 FROM artifacts WHERE session_id = $1 AND artifact_type = 'client_config' AND invalidated_at IS NULL",
        [session.id]
      );
      if (existingArtifact.rowCount === 0) {
        await client.query(
          `
            INSERT INTO artifacts (
              session_id,
              artifact_type,
              phase,
              public_payload,
              policy,
              created_at
            )
            VALUES ($1, 'client_config', 'prepared', $2::jsonb, $3::jsonb, now())
          `,
          [
            session.id,
            JSON.stringify({
              status: "prepared",
              message: "Client configuration material will be attached by the assignment apply reports."
            }),
            JSON.stringify({ oneTime: false })
          ]
        );
      }

      await client.query(
        `
          UPDATE session_status
          SET phase = 'active',
              observed_generation = $2,
              updated_at = now()
          WHERE session_id = $1
        `,
        [session.id, session.generation]
      );
      await setSessionCondition(client, session.id, "Ready", "True", "AssignmentsApplied", "Session is active", session.generation);
      await client.query(
        `
          INSERT INTO audit_events (event_type, actor_type, session_id, details)
          VALUES ('session_active', 'system', $1, '{}'::jsonb)
        `,
        [session.id]
      );
    }
  });
}

async function completeRevokedSessions(): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await client.query<{ id: string; generation: number }>(
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

    for (const session of sessions.rows) {
      await client.query(
        "UPDATE artifacts SET invalidated_at = now(), phase = 'invalidated' WHERE session_id = $1 AND invalidated_at IS NULL",
        [session.id]
      );
      await client.query(
        "UPDATE session_status SET phase = 'revoked', observed_generation = $2, updated_at = now() WHERE session_id = $1",
        [session.id, session.generation]
      );
      await setSessionCondition(client, session.id, "Ready", "False", "Revoked", "Session has been revoked", session.generation);
      await client.query(
        `
          INSERT INTO audit_events (event_type, actor_type, session_id, details)
          VALUES ('session_revoked', 'system', $1, '{}'::jsonb)
        `,
        [session.id]
      );
    }
  });
}

async function requeueExpiredJobs(): Promise<void> {
  await db.query(
    `
      UPDATE jobs
      SET phase = 'queued',
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE phase IN ('leased', 'running')
        AND lease_expires_at < now()
    `
  );
}

interface PathChoice {
  ingressGateId: string;
  ingressGateName: string;
  egressGateId: string;
  egressGateName: string;
}

async function choosePath(
  client: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  spec: Record<string, unknown>
): Promise<PathChoice | null> {
  const ingressGateId = readOptionalString(spec, "ingressGateId");
  const egressGateId = readOptionalString(spec, "egressGateId");
  const ingressGateName = readOptionalString(spec, "ingressGateName");
  const egressGateName = readOptionalString(spec, "egressGateName");
  const gates = await client.query(
    `
      SELECT gates.id, gates.name
      FROM gates
      LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
      LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
      WHERE gates.desired_state = 'Enabled'
        AND COALESCE(ready.status = 'True', false)
        AND COALESCE(schedulable.status = 'True', false)
        AND ($1::uuid IS NULL OR gates.id = $1::uuid)
        AND ($2::text IS NULL OR gates.name = $2)
      ORDER BY gates.scheduling_weight DESC, gates.name ASC
      LIMIT 1
    `,
    [ingressGateId || null, ingressGateName || null]
  );
  const ingress = gates.rows[0] as { id: string; name: string } | undefined;
  if (!ingress) {
    return null;
  }

  const egressGates = await client.query(
    `
      SELECT gates.id, gates.name
      FROM gates
      LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
      LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
      WHERE gates.desired_state = 'Enabled'
        AND gates.id <> $1
        AND COALESCE(ready.status = 'True', false)
        AND COALESCE(schedulable.status = 'True', false)
        AND ($2::uuid IS NULL OR gates.id = $2::uuid)
        AND ($3::text IS NULL OR gates.name = $3)
      ORDER BY gates.scheduling_weight DESC, gates.name ASC
      LIMIT 1
    `,
    [ingress.id, egressGateId || null, egressGateName || null]
  );
  const egress = egressGates.rows[0] as { id: string; name: string } | undefined;
  if (!egress) {
    return null;
  }

  return {
    ingressGateId: ingress.id,
    ingressGateName: ingress.name,
    egressGateId: egress.id,
    egressGateName: egress.name
  };
}

function renderPlan(
  session: {
    id: string;
    generation: number;
    mode: string;
    destinationCidrs: string[];
    sourceCidr: string | null;
    clientPublicKey: string | null;
  },
  path: PathChoice
): {
  planHash: string;
  publicMaterial: Record<string, unknown>;
  routingModel: Record<string, unknown>;
  firewallModel: Record<string, unknown>;
  secretRefs: Record<string, unknown>;
} {
  const model = {
    sessionId: session.id,
    generation: session.generation,
    mode: session.mode,
    destinationCidrs: session.destinationCidrs,
    sourceCidr: session.sourceCidr,
    clientPublicKey: session.clientPublicKey,
    path
  };
  return {
    planHash: createHash("sha256").update(JSON.stringify(model)).digest("hex"),
    publicMaterial: {
      mode: session.mode,
      destinationCidrs: session.destinationCidrs,
      clientPublicKey: session.clientPublicKey
    },
    routingModel: {
      transitInterface: "doublezero0",
      destinationCidrs: session.destinationCidrs,
      sourceCidr: session.sourceCidr,
      path
    },
    firewallModel: {
      sourceCidr: session.sourceCidr,
      destinationCidrs: session.destinationCidrs
    },
    secretRefs: {}
  };
}

async function createAssignment(
  client: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Array<{ id: string }> }> },
  input: {
    sessionId: string;
    gateId: string;
    role: "Ingress" | "Egress";
    planId: string;
  }
): Promise<string> {
  const inserted = await client.query(
    `
      WITH generated AS (
        SELECT gen_random_uuid() AS id
      )
      INSERT INTO gate_assignments (
        id,
        session_id,
        gate_id,
        role,
        desired_state,
        external_handle,
        plan_id
      )
      SELECT
        generated.id,
        $1,
        $2,
        $3::gate_assignment_role,
        'Applied',
        'hs-assignment-' || generated.id::text,
        $4
      FROM generated
      ON CONFLICT (session_id, role) DO UPDATE
      SET desired_state = 'Applied',
          gate_id = EXCLUDED.gate_id,
          plan_id = EXCLUDED.plan_id,
          updated_at = now()
      RETURNING id
    `,
    [input.sessionId, input.gateId, input.role, input.planId]
  );
  const assignmentId = mustRow(inserted).id;
  await client.query(
    `
      INSERT INTO gate_assignment_status (assignment_id, phase)
      VALUES ($1, 'queued')
      ON CONFLICT (assignment_id) DO UPDATE
      SET phase = CASE
            WHEN gate_assignment_status.phase = 'applied' THEN gate_assignment_status.phase
            ELSE 'queued'
          END,
          updated_at = now()
    `,
    [assignmentId]
  );
  return assignmentId;
}

async function enqueueApplyJob(
  client: { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> },
  assignmentId: string,
  gateId: string,
  sessionId: string,
  plan: Record<string, unknown>
): Promise<void> {
  await client.query(
    `
      INSERT INTO jobs (type, phase, gate_id, session_id, assignment_id, payload)
      VALUES ('apply_assignment', 'queued', $1, $2, $3, $4::jsonb)
      ON CONFLICT DO NOTHING
    `,
    [gateId, sessionId, assignmentId, JSON.stringify({ assignmentId, plan })]
  );
}

async function setSessionCondition(
  client: { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> },
  sessionId: string,
  type: string,
  status: "True" | "False" | "Unknown",
  reason: string,
  message: string,
  observedGeneration: number
): Promise<void> {
  await client.query(
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
    [sessionId, type, status, reason, message, observedGeneration]
  );
}

function readOptionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function mustRow<T>(result: { rows: T[] }): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error("expected database row");
  }
  return row;
}

function log(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ...payload, now: new Date().toISOString() })}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
