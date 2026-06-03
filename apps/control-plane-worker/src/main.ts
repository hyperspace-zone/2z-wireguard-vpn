import { createHash } from "node:crypto";
import { createDatabase } from "@hyperspace-zone/db";
import {
  decryptJsonPayload,
  encryptJsonPayload,
  generateWireGuardKeyPair,
  parseAes256GcmKey,
  type EncryptedJsonPayload
} from "@hyperspace-zone/shared";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
const artifactEncryptionKeyRaw = process.env.ARTIFACT_ENCRYPTION_KEY;
if (!artifactEncryptionKeyRaw) {
  throw new Error("ARTIFACT_ENCRYPTION_KEY is required");
}

const pollMs = Number(process.env.WORKER_POLL_MS ?? 2000);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const artifactEncryptionKey = parseAes256GcmKey(artifactEncryptionKeyRaw);

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
  await enqueueCommitJobsForPreparedAssignments();
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
      role: "Ingress" | "Egress";
    }>(
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
          JSON.stringify({ assignmentId: assignment.assignmentId, role: assignment.role })
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
      if (plan.secretPayload) {
        await writeRenderedPlanSecret(client, planId, plan.secretPayload);
      }

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

      await enqueueApplyJob(client, {
        assignmentId: ingressAssignment,
        gateId: path.ingressGateId,
        sessionId: session.id,
        operation: "prepare",
        role: "Ingress",
        plan: toGatePreparePlan(planId, plan)
      });
      await enqueueApplyJob(client, {
        assignmentId: egressAssignment,
        gateId: path.egressGateId,
        sessionId: session.id,
        operation: "prepare",
        role: "Egress",
        plan: toGatePreparePlan(planId, plan)
      });
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
            ingressPublicEndpoint: path.ingressPublicEndpoint,
            egressGateId: path.egressGateId,
            egressGateName: path.egressGateName,
            egressPublicEndpoint: path.egressPublicEndpoint
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

async function enqueueCommitJobsForPreparedAssignments(): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await client.query<{
      id: string;
      generation: number;
      planId: string;
      publicMaterial: Record<string, unknown>;
      routingModel: Record<string, unknown>;
      firewallModel: Record<string, unknown>;
    }>(
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

    for (const session of sessions.rows) {
      const assignments = await client.query<{
        id: string;
        gateId: string;
        role: "Ingress" | "Egress";
        externalHandle: string;
        gateName: string;
        publicEndpoint: string;
        localMaterial: Record<string, unknown>;
      }>(
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
        [session.id]
      );
      const ingress = assignments.rows.find((assignment) => assignment.role === "Ingress");
      const egress = assignments.rows.find((assignment) => assignment.role === "Egress");
      if (!ingress || !egress) {
        continue;
      }

      const networkPlan = {
        planId: session.planId,
        sessionId: session.id,
        generation: session.generation,
        publicMaterial: session.publicMaterial,
        routingModel: session.routingModel,
        firewallModel: session.firewallModel,
        ingress: assignmentNetworkMaterial(ingress),
        egress: assignmentNetworkMaterial(egress)
      };

      await enqueueApplyJob(client, {
        assignmentId: ingress.id,
        gateId: ingress.gateId,
        sessionId: session.id,
        operation: "commit",
        role: "Ingress",
        networkPlan
      });
      await enqueueApplyJob(client, {
        assignmentId: egress.id,
        gateId: egress.gateId,
        sessionId: session.id,
        operation: "commit",
        role: "Egress",
        networkPlan
      });
      await client.query(
        `
          UPDATE gate_assignment_status
          SET phase = 'queued',
              updated_at = now()
          WHERE assignment_id IN ($1, $2)
            AND phase = 'prepared'
        `,
        [ingress.id, egress.id]
      );
      await setSessionCondition(
        client,
        session.id,
        "Ready",
        "False",
        "ApplyingNetworkPlan",
        "Both gates prepared local key material; network plan commit is queued",
        session.generation
      );
    }
  });
}

function assignmentNetworkMaterial(input: {
  id: string;
  role: "Ingress" | "Egress";
  externalHandle: string;
  gateName: string;
  publicEndpoint: string;
  localMaterial: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    assignmentId: input.id,
    role: input.role,
    handle: input.externalHandle,
    gateName: input.gateName,
    publicEndpoint: input.publicEndpoint,
    localMaterial: input.localMaterial
  };
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
        await createClientConfigArtifact(client, session.id, session.generation);
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

async function createClientConfigArtifact(
  client: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> },
  sessionId: string,
  generation: number
): Promise<void> {
  const planResult = await client.query(
    `
      SELECT
        id,
        public_material AS "publicMaterial"
      FROM rendered_plans
      WHERE session_id = $1
        AND generation = $2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [sessionId, generation]
  );
  const plan = planResult.rows[0];
  if (!plan) {
    throw new Error(`missing rendered plan for session ${sessionId}`);
  }

  const assignments = await client.query(
    `
      SELECT
        gate_assignments.role::text AS role,
        gates.name AS "gateName",
        gates.public_endpoint AS "publicEndpoint",
        gate_assignment_status.local_material AS "localMaterial"
      FROM gate_assignments
      JOIN gates ON gates.id = gate_assignments.gate_id
      JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
      WHERE gate_assignments.session_id = $1
    `,
    [sessionId]
  );
  const ingress = assignments.rows.find((assignment) => assignment.role === "Ingress");
  const egress = assignments.rows.find((assignment) => assignment.role === "Egress");
  if (!ingress || !egress) {
    throw new Error(`missing applied assignment material for session ${sessionId}`);
  }

  const publicMaterial = asRecord(plan.publicMaterial);
  const destinationCidrs = readStringList(publicMaterial, "destinationCidrs");
  const clientAddress = readRequiredString(publicMaterial, "clientAddress");
  const mode = readRequiredString(publicMaterial, "mode");
  const clientKeyMode = readRequiredString(publicMaterial, "clientKeyMode");
  const ingressMaterial = asRecord(ingress.localMaterial);
  const ingressWireGuard = asRecord(ingressMaterial.wireGuard);
  const serverPublicKey = readRequiredString(ingressWireGuard, "clientPublicKey");
  const listenPort = readRequiredNumber(ingressWireGuard, "clientListenPort");

  const planSecret = await client.query(
    `
      SELECT
        encryption_method AS "encryptionMethod",
        nonce,
        ciphertext,
        auth_tag AS "authTag",
        aad,
        key_fingerprint AS "keyFingerprint"
      FROM rendered_plan_secrets
      WHERE plan_id = $1
    `,
    [String(plan.id)]
  );
  const secretPayload = planSecret.rows[0]
    ? decryptJsonPayload<Record<string, unknown>>(planSecret.rows[0] as unknown as EncryptedJsonPayload, artifactEncryptionKey)
    : {};
  const clientPrivateKey = typeof secretPayload.clientPrivateKey === "string"
    ? secretPayload.clientPrivateKey
    : "<client-private-key>";

  const fileName = `hyperspace-${sessionId.slice(0, 8)}.conf`;
  const configText = renderClientConfig({
    privateKey: clientPrivateKey,
    address: clientAddress,
    serverPublicKey,
    endpoint: `${String(ingress.publicEndpoint)}:${listenPort}`,
    allowedIps: destinationCidrs,
    persistentKeepaliveSeconds: 25
  });
  const encryptedArtifact = encryptJsonPayload(
    {
      fileName,
      configText,
      mode,
      clientKeyMode,
      clientAddress,
      destinationCidrs,
      ingressGateName: String(ingress.gateName),
      egressGateName: String(egress.gateName)
    },
    artifactEncryptionKey,
    `artifact:${sessionId}:${generation}`
  );

  const artifact = await client.query(
    `
      INSERT INTO artifacts (
        session_id,
        artifact_type,
        phase,
        public_payload,
        key_fingerprints,
        policy,
        created_at
      )
      VALUES ($1, 'client_config', 'prepared', $2::jsonb, $3::text[], $4::jsonb, now())
      RETURNING id
    `,
    [
      sessionId,
      JSON.stringify({
        status: "prepared",
        fileName,
        mode,
        clientKeyMode,
        clientAddress,
        destinationCidrs,
        ingressGateName: String(ingress.gateName),
        egressGateName: String(egress.gateName)
      }),
      [serverPublicKey],
      JSON.stringify({ oneTime: false })
    ]
  );
  const artifactId = String(mustRow(artifact).id);
  await client.query(
    `
      INSERT INTO artifact_payloads (
        artifact_id,
        payload_type,
        encryption_method,
        nonce,
        ciphertext,
        auth_tag,
        aad,
        key_fingerprint
      )
      VALUES ($1, 'wireguard_client_config', $2, $3, $4, $5, $6, $7)
    `,
    [
      artifactId,
      encryptedArtifact.encryptionMethod,
      encryptedArtifact.nonce,
      encryptedArtifact.ciphertext,
      encryptedArtifact.authTag,
      encryptedArtifact.aad,
      encryptedArtifact.keyFingerprint
    ]
  );
  await client.query(
    "UPDATE session_status SET artifact_id = $2, updated_at = now() WHERE session_id = $1",
    [sessionId, artifactId]
  );
}

function renderClientConfig(input: {
  privateKey: string;
  address: string;
  serverPublicKey: string;
  endpoint: string;
  allowedIps: string[];
  persistentKeepaliveSeconds: number;
}): string {
  return [
    "[Interface]",
    `PrivateKey = ${input.privateKey}`,
    `Address = ${input.address}`,
    "DNS = 1.1.1.1",
    "",
    "[Peer]",
    `PublicKey = ${input.serverPublicKey}`,
    `Endpoint = ${input.endpoint}`,
    `AllowedIPs = ${input.allowedIps.join(", ")}`,
    `PersistentKeepalive = ${input.persistentKeepaliveSeconds}`,
    ""
  ].join("\n");
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
  ingressPublicEndpoint: string;
  egressGateId: string;
  egressGateName: string;
  egressPublicEndpoint: string;
}

interface WireGuardRenderedPlan {
  planHash: string;
  publicMaterial: Record<string, unknown>;
  routingModel: Record<string, unknown>;
  firewallModel: Record<string, unknown>;
  secretRefs: Record<string, unknown>;
  secretPayload: EncryptedJsonPayload | null;
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
      SELECT gates.id, gates.name, gates.public_endpoint AS "publicEndpoint"
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
  const ingress = gates.rows[0] as { id: string; name: string; publicEndpoint: string } | undefined;
  if (!ingress) {
    return null;
  }

  const egressGates = await client.query(
    `
      SELECT gates.id, gates.name, gates.public_endpoint AS "publicEndpoint"
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
  const egress = egressGates.rows[0] as { id: string; name: string; publicEndpoint: string } | undefined;
  if (!egress) {
    return null;
  }

  return {
    ingressGateId: ingress.id,
    ingressGateName: ingress.name,
    ingressPublicEndpoint: ingress.publicEndpoint,
    egressGateId: egress.id,
    egressGateName: egress.name,
    egressPublicEndpoint: egress.publicEndpoint
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
): WireGuardRenderedPlan {
  const generatedClientKey = session.clientPublicKey ? null : generateWireGuardKeyPair();
  const clientPublicKey = session.clientPublicKey ?? generatedClientKey?.publicKey;
  if (!clientPublicKey) {
    throw new Error(`missing client public key for session ${session.id}`);
  }
  const clientAddress = allocateClientAddress(session.id);
  const model = {
    sessionId: session.id,
    generation: session.generation,
    mode: session.mode,
    destinationCidrs: session.destinationCidrs,
    sourceCidr: session.sourceCidr,
    clientAddress,
    clientPublicKey,
    clientKeyMode: generatedClientKey ? "ServerGenerated" : "BringYourOwnPublicKey",
    path
  };
  const secretPayload = generatedClientKey
    ? encryptJsonPayload(
        {
          clientPrivateKey: generatedClientKey.privateKey,
          clientPublicKey: generatedClientKey.publicKey
        },
        artifactEncryptionKey,
        `rendered-plan:${session.id}:${session.generation}`
      )
    : null;

  return {
    planHash: createHash("sha256").update(JSON.stringify(model)).digest("hex"),
    publicMaterial: {
      sessionId: session.id,
      generation: session.generation,
      mode: session.mode,
      destinationCidrs: session.destinationCidrs,
      clientAddress,
      clientPublicKey,
      clientKeyMode: generatedClientKey ? "ServerGenerated" : "BringYourOwnPublicKey",
      persistentKeepaliveSeconds: 25,
      mtu: 1420,
      path
    },
    routingModel: {
      transitInterface: "doublezero0",
      destinationCidrs: session.destinationCidrs,
      sourceCidr: session.sourceCidr,
      clientAddress,
      path
    },
    firewallModel: {
      mode: session.mode,
      sourceCidr: session.sourceCidr,
      destinationCidrs: session.destinationCidrs,
      clientAddress
    },
    secretRefs: generatedClientKey ? { clientPrivateKey: "rendered_plan_secrets" } : {},
    secretPayload
  };
}

function allocateClientAddress(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest();
  const third = digest[0] ?? 0;
  const fourth = ((digest[1] ?? 0) % 253) + 2;
  return `10.77.${third}.${fourth}/32`;
}

function toGatePreparePlan(planId: string, plan: WireGuardRenderedPlan): Record<string, unknown> {
  return {
    planId,
    publicMaterial: plan.publicMaterial,
    routingModel: plan.routingModel,
    firewallModel: plan.firewallModel
  };
}

async function writeRenderedPlanSecret(
  client: { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> },
  planId: string,
  payload: EncryptedJsonPayload
): Promise<void> {
  await client.query(
    `
      INSERT INTO rendered_plan_secrets (
        plan_id,
        encryption_method,
        nonce,
        ciphertext,
        auth_tag,
        aad,
        key_fingerprint
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (plan_id) DO NOTHING
    `,
    [
      planId,
      payload.encryptionMethod,
      payload.nonce,
      payload.ciphertext,
      payload.authTag,
      payload.aad,
      payload.keyFingerprint
    ]
  );
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
  input: {
    assignmentId: string;
    gateId: string;
    sessionId: string;
    operation: "prepare" | "commit";
    role: "Ingress" | "Egress";
    plan?: Record<string, unknown>;
    networkPlan?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO jobs (type, phase, gate_id, session_id, assignment_id, payload)
      VALUES ('apply_assignment', 'queued', $1, $2, $3, $4::jsonb)
      ON CONFLICT DO NOTHING
    `,
    [
      input.gateId,
      input.sessionId,
      input.assignmentId,
      JSON.stringify({
        assignmentId: input.assignmentId,
        operation: input.operation,
        role: input.role,
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.networkPlan ? { networkPlan: input.networkPlan } : {})
      })
    ]
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

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);
  if (!value) {
    throw new Error(`missing required string ${key}`);
  }
  return value;
}

function readRequiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`missing required number ${key}`);
  }
  return value;
}

function readStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
