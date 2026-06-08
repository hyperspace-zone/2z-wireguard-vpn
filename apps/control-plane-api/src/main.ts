import { scryptSync, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createDatabase, newSecretToken, sha256Hex } from "@hyperspace-zone/db";
import type { GateSummary, SessionMode, SessionSummary } from "@hyperspace-zone/contracts";
import { evaluateGateReadiness, readGateDoubleZeroEnv } from "./gate-readiness.js";
import {
  decryptJsonPayload,
  parseAes256GcmKey,
  type EncryptedJsonPayload
} from "@hyperspace-zone/shared";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8080");
const authSessionTtlSeconds = Number(process.env.AUTH_SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 30);
const downloadTokenTtlSeconds = Number(process.env.ARTIFACT_DOWNLOAD_TTL_SECONDS ?? 300);
const adminToken = process.env.ADMIN_TOKEN;
const artifactEncryptionKeyRaw = process.env.ARTIFACT_ENCRYPTION_KEY;
const artifactEncryptionKey = artifactEncryptionKeyRaw ? parseAes256GcmKey(artifactEncryptionKeyRaw) : null;
const wireGuardCanonicalBase64Pattern = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

const db = createDatabase({
  connectionString: databaseUrl,
  applicationName: "hyperspace-control-plane-api"
});

const app = Fastify({
  logger: true
});

interface AuthUser {
  id: string;
  accountId: string;
  email: string;
  displayName: string;
}

interface GateAuth {
  id: string;
  name: string;
  generation: number;
  publicEndpoint: string;
  spec: Record<string, unknown>;
}

app.get("/health", async () => ({
  ok: true,
  service: "control-plane-api",
  now: new Date().toISOString()
}));

app.get("/v1/public/health", async () => ({
  ok: true,
  surface: "public"
}));

app.get("/v1/agent/health", async () => ({
  ok: true,
  surface: "agent"
}));

app.get("/v1/admin/health", async () => ({
  ok: true,
  surface: "admin"
}));

app.get("/v1/gate/health", async () => ({
  ok: true,
  surface: "gate"
}));

app.post("/v1/public/auth/register", async (request, reply) => {
  const body = asRecord(request.body);
  const email = normalizeEmail(readString(body, "email"));
  const password = readString(body, "password");
  const displayName = readString(body, "displayName") || email;

  if (!email || !email.includes("@")) {
    return reply.code(400).send({ error: "invalid_email" });
  }
  if (!password || password.length < 12) {
    return reply.code(400).send({ error: "weak_password", message: "password must be at least 12 characters" });
  }

  const result = await db.transaction(async (client) => {
    const account = await client.query<{ id: string }>(
      "INSERT INTO accounts (display_name) VALUES ($1) RETURNING id",
      [displayName]
    );
    const accountId = mustRow(account).id;
    const user = await client.query<AuthUser>(
      `
        INSERT INTO users (account_id, email, display_name)
        VALUES ($1, $2, $3)
        RETURNING id, account_id AS "accountId", email::text, display_name AS "displayName"
      `,
      [accountId, email, displayName]
    );
    const createdUser = mustRow(user);

    await client.query(
      "INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)",
      [createdUser.id, hashPassword(password)]
    );
    await client.query(
      `
        INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, details)
        VALUES ('user_registered', 'user', $1, $2, $3::jsonb)
      `,
      [createdUser.id, createdUser.accountId, JSON.stringify({ email: createdUser.email })]
    );

    const session = await createAuthSession(createdUser.id, client);
    return { user: createdUser, accessToken: session.token, expiresAt: session.expiresAt };
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      return { error: "email_already_registered" as const };
    }
    throw error;
  });

  if ("error" in result) {
    return reply.code(409).send({ error: result.error });
  }

  return reply.code(201).send(result);
});

app.post("/v1/public/auth/login", async (request, reply) => {
  const body = asRecord(request.body);
  const email = normalizeEmail(readString(body, "email"));
  const password = readString(body, "password");

  if (!email || !password) {
    return reply.code(400).send({ error: "credentials_required" });
  }

  const credential = await db.query<AuthUser & { passwordHash: string }>(
    `
      SELECT
        users.id,
        users.account_id AS "accountId",
        users.email::text,
        users.display_name AS "displayName",
        password_credentials.password_hash AS "passwordHash"
      FROM users
      JOIN password_credentials ON password_credentials.user_id = users.id
      WHERE users.email = $1 AND users.disabled_at IS NULL
    `,
    [email]
  );
  const row = credential.rows[0];
  if (!row || !verifyPassword(password, row.passwordHash)) {
    return reply.code(401).send({ error: "invalid_credentials" });
  }

  const session = await createAuthSession(row.id);
  return reply.send({
    user: {
      id: row.id,
      accountId: row.accountId,
      email: row.email,
      displayName: row.displayName
    },
    accessToken: session.token,
    expiresAt: session.expiresAt
  });
});

app.get("/v1/public/auth/me", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) {
    return;
  }
  return reply.send({ user });
});

app.get("/v1/public/network/me", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) {
    return;
  }
  return reply.send({ ip: detectClientIpv4(request) });
});

app.get("/v1/public/gates", async () => ({
  gates: await listGates()
}));

app.get("/v1/public/sessions", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) {
    return;
  }

  const result = await db.query<SessionRow>(
    sessionSelectSql("WHERE sessions.account_id = $1 AND sessions.hidden_at IS NULL ORDER BY sessions.created_at DESC LIMIT 200"),
    [user.accountId]
  );

  return reply.send({ sessions: result.rows.map(mapSessionRow) });
});

app.post("/v1/public/sessions", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) {
    return;
  }

  const parsed = parseSessionCreateBody(asRecord(request.body));
  if ("error" in parsed) {
    return reply.code(400).send(parsed);
  }

  const created = await db.transaction(async (client) => {
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
        user.accountId,
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
        VALUES ($1, 'requested')
      `,
      [sessionId]
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
      [user.id, user.accountId, sessionId, JSON.stringify({ mode: parsed.mode })]
    );
    return sessionId;
  });

  const session = await readOwnSession(user.accountId, created);
  return reply.code(201).send({ session });
});

app.get("/v1/public/sessions/:sessionId", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) {
    return;
  }

  const sessionId = readParam(request, "sessionId");
  const session = await readOwnSession(user.accountId, sessionId);
  if (!session) {
    return reply.code(404).send({ error: "session_not_found" });
  }

  return reply.send({ session });
});

app.post("/v1/public/sessions/:sessionId/revoke", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) {
    return;
  }

  const sessionId = readParam(request, "sessionId");
  const updated = await db.transaction(async (client) => {
    const session = await client.query<{ id: string }>(
      `
        UPDATE sessions
        SET desired_state = 'Revoked', generation = generation + 1, updated_at = now()
        WHERE id = $1 AND account_id = $2 AND hidden_at IS NULL
        RETURNING id
      `,
      [sessionId, user.accountId]
    );
    if (session.rowCount === 0) {
      return false;
    }

    await client.query(
      `
        UPDATE session_status
        SET phase = CASE WHEN phase = 'revoked' THEN phase ELSE 'revoking' END,
            updated_at = now()
        WHERE session_id = $1
      `,
      [sessionId]
    );
    await client.query(
      `
        INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, session_id)
        VALUES ('session_revoke_requested', 'user', $1, $2, $3)
      `,
      [user.id, user.accountId, sessionId]
    );
    return true;
  });

  if (!updated) {
    return reply.code(404).send({ error: "session_not_found" });
  }

  return reply.send({ session: await readOwnSession(user.accountId, sessionId) });
});

app.delete("/v1/public/sessions/:sessionId", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) {
    return;
  }

  const sessionId = readParam(request, "sessionId");
  const deleted = await db.transaction(async (client) => {
    const existing = await client.query<{ id: string; phase: SessionSummary["phase"]; hiddenAt: string | null }>(
      `
        SELECT sessions.id, session_status.phase::text AS phase, sessions.hidden_at AS "hiddenAt"
        FROM sessions
        JOIN session_status ON session_status.session_id = sessions.id
        WHERE sessions.id = $1 AND sessions.account_id = $2
      `,
      [sessionId, user.accountId]
    );
    const row = existing.rows[0];
    if (!row) {
      return "not_found" as const;
    }
    if (row.hiddenAt) {
      return "deleted" as const;
    }
    if (row.phase !== "revoked" && row.phase !== "failed") {
      return "not_revoked" as const;
    }

    await client.query(
      `
        UPDATE sessions
        SET hidden_at = now(), updated_at = now()
        WHERE id = $1 AND account_id = $2
      `,
      [sessionId, user.accountId]
    );
    await client.query(
      `
        INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, session_id)
        VALUES ('session_hidden', 'user', $1, $2, $3)
      `,
      [user.id, user.accountId, sessionId]
    );
    return "deleted" as const;
  });

  if (deleted === "not_found") {
    return reply.code(404).send({ error: "session_not_found" });
  }
  if (deleted === "not_revoked") {
    return reply.code(409).send({ error: "session_not_revoked" });
  }
  return reply.code(204).send();
});

app.post("/v1/public/sessions/:sessionId/artifacts/client-config/download-token", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) {
    return;
  }

  const sessionId = readParam(request, "sessionId");
  const artifact = await db.query<{ id: string }>(
    `
      SELECT artifacts.id
      FROM artifacts
      JOIN sessions ON sessions.id = artifacts.session_id
      WHERE sessions.id = $1
        AND sessions.account_id = $2
        AND sessions.hidden_at IS NULL
        AND artifacts.artifact_type = 'client_config'
        AND artifacts.invalidated_at IS NULL
        AND artifacts.phase IN ('prepared', 'available', 'downloaded')
      ORDER BY artifacts.created_at DESC
      LIMIT 1
    `,
    [sessionId, user.accountId]
  );
  const row = artifact.rows[0];
  if (!row) {
    return reply.code(409).send({ error: "artifact_not_ready" });
  }

  const token = newSecretToken();
  const expiresAt = new Date(Date.now() + downloadTokenTtlSeconds * 1000).toISOString();
  await db.query(
    `
      INSERT INTO artifact_download_tokens (artifact_id, token_hash, subject_user_id, expires_at)
      VALUES ($1, $2, $3, $4::timestamptz)
    `,
    [row.id, sha256Hex(token), user.id, expiresAt]
  );
  await db.query(
    `
      UPDATE artifacts
      SET phase = 'available', issued_at = COALESCE(issued_at, now())
      WHERE id = $1
    `,
    [row.id]
  );

  return reply.send({
    token,
    expiresAt,
    downloadUrl: `/v1/public/artifacts/download/${token}`,
    downloadConfigUrl: `/v1/public/artifacts/download/${token}?format=conf`
  });
});

app.get("/v1/public/artifacts/download/:token", async (request, reply) => {
  const token = readParam(request, "token");
  const tokenHash = sha256Hex(token);

  const result = await db.transaction(async (client) => {
    const tokenRow = await client.query<{
      id: string;
      artifactId: string;
      publicPayload: unknown;
      encryptedPayloadRef: string | null;
      payloadType: string | null;
      encryptionMethod: string | null;
      nonce: string | null;
      ciphertext: string | null;
      authTag: string | null;
      aad: string | null;
      keyFingerprint: string | null;
    }>(
      `
        SELECT
          artifact_download_tokens.id,
          artifacts.id AS "artifactId",
          artifacts.public_payload AS "publicPayload",
          artifacts.encrypted_payload_ref AS "encryptedPayloadRef",
          artifact_payloads.payload_type AS "payloadType",
          artifact_payloads.encryption_method AS "encryptionMethod",
          artifact_payloads.nonce,
          artifact_payloads.ciphertext,
          artifact_payloads.auth_tag AS "authTag",
          artifact_payloads.aad,
          artifact_payloads.key_fingerprint AS "keyFingerprint"
        FROM artifact_download_tokens
        JOIN artifacts ON artifacts.id = artifact_download_tokens.artifact_id
        LEFT JOIN artifact_payloads ON artifact_payloads.artifact_id = artifacts.id
        WHERE artifact_download_tokens.token_hash = $1
          AND artifact_download_tokens.expires_at > now()
          AND artifact_download_tokens.revoked_at IS NULL
          AND artifacts.invalidated_at IS NULL
        FOR UPDATE OF artifact_download_tokens
      `,
      [tokenHash]
    );
    const row = tokenRow.rows[0];
    if (!row) {
      return null;
    }

    await client.query(
      "UPDATE artifact_download_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL",
      [row.id]
    );
    await client.query(
      "UPDATE artifacts SET phase = 'downloaded', downloaded_at = now() WHERE id = $1",
      [row.artifactId]
    );
    return row;
  });

  if (!result) {
    return reply.code(404).send({ error: "download_token_not_found" });
  }

  const encryptedPayload = encryptedPayloadFromRow(result);
  if (encryptedPayload && !artifactEncryptionKey) {
    return reply.code(503).send({ error: "artifact_encryption_not_configured" });
  }
  const payload = encryptedPayload && artifactEncryptionKey
    ? decryptJsonPayload<Record<string, unknown>>(encryptedPayload, artifactEncryptionKey)
    : asRecord(result.publicPayload);

  if (shouldReturnRawWireGuardConfig(request)) {
    const configText = readString(payload, "configText");
    if (!configText) {
      return reply.code(406).send({ error: "raw_config_not_available" });
    }
    const fileName = attachmentFileName(readString(payload, "fileName"), result.artifactId);
    return reply
      .type("text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="${fileName}"`)
      .send(configText);
  }

  return reply.send({
    artifactId: result.artifactId,
    metadata: result.publicPayload,
    payload,
    ...(result.payloadType ? { payloadType: result.payloadType } : {}),
    encryptedPayloadRef: result.encryptedPayloadRef
  });
});

app.get("/v1/admin/gates", async (request, reply) => {
  if (!requireAdmin(request, reply)) {
    return;
  }
  return reply.send({ gates: await listGates() });
});

app.post("/v1/gate/heartbeat", async (request, reply) => {
  const gate = await requireGate(request, reply);
  if (!gate) {
    return;
  }

  const body = asRecord(request.body);
  const bootId = readString(body, "bootId");
  const agentVersion = readString(body, "agentVersion");
  const observedEndpoint = readString(body, "observedEndpoint");
  const capabilities = readStringArray(body, "capabilities");
  const doubleZero = asRecord(body.doubleZero);
  const doubleZeroCurrentDevice = readString(doubleZero, "currentDevice") || null;
  const doubleZeroLowestLatencyDevice = readString(doubleZero, "lowestLatencyDevice") || null;
  const doubleZeroLowestLatencyDeviceWarning =
    typeof doubleZero.lowestLatencyDeviceWarning === "boolean" ? doubleZero.lowestLatencyDeviceWarning : null;
  const hostReady =
    capabilities.includes("wireguard-tools:present") &&
    capabilities.includes("iproute2:present") &&
    capabilities.includes("nft:present");
  const readiness = evaluateGateReadiness({
    capabilities,
    doubleZero,
    publicEndpoint: gate.publicEndpoint,
    doubleZeroEnv: readGateDoubleZeroEnv(gate.spec),
    hostReady
  });

  await db.transaction(async (client) => {
    await client.query(
      `
        INSERT INTO gate_status (
          gate_id,
          observed_generation,
          agent_version,
          boot_id,
          last_seen_at,
          observed_endpoint,
          observed_capabilities,
          doublezero_status,
          doublezero_current_device,
          doublezero_lowest_latency_device,
          doublezero_lowest_latency_device_warning,
          updated_at
        )
        VALUES ($1, $2, $3, $4, now(), $5, $6::text[], $7::jsonb, $8, $9, $10, now())
        ON CONFLICT (gate_id) DO UPDATE
        SET
          observed_generation = EXCLUDED.observed_generation,
          agent_version = EXCLUDED.agent_version,
          boot_id = EXCLUDED.boot_id,
          last_seen_at = EXCLUDED.last_seen_at,
          observed_endpoint = EXCLUDED.observed_endpoint,
          observed_capabilities = EXCLUDED.observed_capabilities,
          doublezero_status = EXCLUDED.doublezero_status,
          doublezero_current_device = EXCLUDED.doublezero_current_device,
          doublezero_lowest_latency_device = EXCLUDED.doublezero_lowest_latency_device,
          doublezero_lowest_latency_device_warning = EXCLUDED.doublezero_lowest_latency_device_warning,
          updated_at = now()
      `,
      [
        gate.id,
        gate.generation,
        agentVersion || null,
        bootId || null,
        observedEndpoint || null,
        capabilities,
        JSON.stringify(doubleZero),
        doubleZeroCurrentDevice,
        doubleZeroLowestLatencyDevice,
        doubleZeroLowestLatencyDeviceWarning
      ]
    );
    await client.query(
      `
        INSERT INTO gate_leases (gate_id, lease_owner, lease_expires_at, heartbeat_at)
        VALUES ($1, $2, now() + interval '30 seconds', now())
        ON CONFLICT (gate_id) DO UPDATE
        SET lease_owner = EXCLUDED.lease_owner,
            lease_expires_at = EXCLUDED.lease_expires_at,
            heartbeat_at = now()
      `,
      [gate.id, gate.name]
    );
    await upsertGateCondition(client, gate.id, "AgentConnected", "True", "HeartbeatFresh", "Gate agent heartbeat is fresh", gate.generation);
    await upsertGateCondition(
      client,
      gate.id,
      "Ready",
      readiness.ready ? "True" : "False",
      readiness.reason,
      readiness.message,
      gate.generation
    );
    await upsertGateCondition(
      client,
      gate.id,
      "Schedulable",
      readiness.ready ? "True" : "False",
      readiness.ready ? "Enabled" : readiness.reason,
      readiness.ready ? "Gate is eligible for new sessions" : `Gate is not eligible for new sessions: ${readiness.message}`,
      gate.generation
    );
  });

  return reply.send({ ok: true });
});

app.post("/v1/gate/actual-state", async (request, reply) => {
  const gate = await requireGate(request, reply);
  if (!gate) {
    return;
  }

  const body = asRecord(request.body);
  const actualStateHash = readString(body, "stateHash");
  const capabilities = readStringArray(body, "capabilities");

  await db.query(
    `
      UPDATE gate_status
      SET actual_state_hash = $2,
          observed_capabilities = CASE WHEN cardinality($3::text[]) > 0 THEN $3::text[] ELSE observed_capabilities END,
          updated_at = now()
      WHERE gate_id = $1
    `,
    [gate.id, actualStateHash || null, capabilities]
  );

  return reply.send({ ok: true });
});

app.post("/v1/gate/jobs/claim", async (request, reply) => {
  const gate = await requireGate(request, reply);
  if (!gate) {
    return;
  }

  const claimed = await db.transaction(async (client) => {
    const job = await client.query<{
      id: string;
      type: string;
      payload: unknown;
      sessionId: string | null;
      assignmentId: string | null;
    }>(
      `
        SELECT
          id,
          type::text,
          payload,
          session_id AS "sessionId",
          assignment_id AS "assignmentId"
        FROM jobs
        WHERE gate_id = $1
          AND phase IN ('queued', 'retryable_failed')
          AND run_after <= now()
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
      [gate.id]
    );
    const row = job.rows[0];
    if (!row) {
      return null;
    }

    const attempt = await client.query<{ attemptNumber: number }>(
      `
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS "attemptNumber"
        FROM job_attempts
        WHERE job_id = $1
      `,
      [row.id]
    );
    const attemptNumber = mustRow(attempt).attemptNumber;

    await client.query(
      `
        UPDATE jobs
        SET phase = 'leased',
            lease_owner = $2,
            lease_expires_at = now() + interval '60 seconds',
            updated_at = now()
        WHERE id = $1
      `,
      [row.id, gate.name]
    );
    await client.query(
      `
        INSERT INTO job_attempts (job_id, attempt_number, lease_owner, lease_expires_at)
        VALUES ($1, $2, $3, now() + interval '60 seconds')
      `,
      [row.id, attemptNumber, gate.name]
    );
    if (row.assignmentId) {
      await client.query(
        `
          UPDATE gate_assignment_status
          SET phase = CASE
                WHEN $2::text = 'revoke_assignment' THEN 'revoking'::gate_assignment_phase
                ELSE 'applying'::gate_assignment_phase
              END,
              updated_at = now()
          WHERE assignment_id = $1
            AND phase NOT IN ('applied', 'revoked')
        `,
        [row.assignmentId, row.type]
      );
    }

    return {
      id: row.id,
      type: row.type,
      payload: row.payload,
      sessionId: row.sessionId,
      assignmentId: row.assignmentId,
      attemptNumber
    };
  });

  return reply.send({ job: claimed });
});

app.post("/v1/gate/jobs/:jobId/report", async (request, reply) => {
  const gate = await requireGate(request, reply);
  if (!gate) {
    return;
  }

  const jobId = readParam(request, "jobId");
  const body = asRecord(request.body);
  const status = readString(body, "status");
  const actualStateHash = readString(body, "actualStateHash");
  const errorCode = readString(body, "errorCode");
  const resultSummary = asRecord(body.resultSummary ?? {});

  if (!["succeeded", "retryable_failed", "failed"].includes(status)) {
    return reply.code(400).send({ error: "invalid_job_status" });
  }

  const updated = await db.transaction(async (client) => {
    const job = await client.query<{
      id: string;
      type: string;
      assignmentId: string | null;
      retryCount: number;
      maxRetries: number;
    }>(
      `
        SELECT
          id,
          type::text,
          assignment_id AS "assignmentId",
          retry_count AS "retryCount",
          max_retries AS "maxRetries"
        FROM jobs
        WHERE id = $1 AND gate_id = $2
        FOR UPDATE
      `,
      [jobId, gate.id]
    );
    const row = job.rows[0];
    if (!row) {
      return false;
    }

    const terminalFailure = status === "failed" || (status === "retryable_failed" && row.retryCount + 1 >= row.maxRetries);
    const nextPhase = status === "succeeded" ? "succeeded" : terminalFailure ? "dead" : "retryable_failed";
    const nextRunAfter = status === "retryable_failed" && !terminalFailure ? "now() + interval '10 seconds'" : "now()";

    await client.query(
      `
        UPDATE jobs
        SET phase = $2::job_phase,
            retry_count = CASE WHEN $2::job_phase = 'retryable_failed' THEN retry_count + 1 ELSE retry_count END,
            lease_expires_at = NULL,
            run_after = ${nextRunAfter},
            updated_at = now()
        WHERE id = $1
      `,
      [row.id, nextPhase]
    );
    await client.query(
      `
        UPDATE job_attempts
        SET completed_at = now(),
            result_summary = $2::jsonb,
            error_code = $3,
            actual_state_hash = $4
        WHERE job_id = $1
          AND completed_at IS NULL
      `,
      [row.id, JSON.stringify(resultSummary), errorCode || null, actualStateHash || null]
    );

    if (row.assignmentId) {
      if (status === "succeeded" && row.type === "apply_assignment") {
        const operation = readString(resultSummary, "operation") || "commit";
        if (operation === "prepare") {
          await client.query(
            `
              UPDATE gate_assignment_status
              SET phase = 'prepared',
                  observed_generation = gate_assignments.generation,
                  actual_state_hash = $2,
                  local_material = $3::jsonb,
                  reported_state = $4::jsonb,
                  last_observed_at = now(),
                  updated_at = now()
              FROM gate_assignments
              WHERE gate_assignment_status.assignment_id = gate_assignments.id
                AND gate_assignment_status.assignment_id = $1
            `,
            [
              row.assignmentId,
              actualStateHash || null,
              JSON.stringify(asRecord(resultSummary.material ?? {})),
              JSON.stringify(resultSummary)
            ]
          );
        } else {
          await client.query(
            `
              UPDATE gate_assignment_status
              SET phase = 'applied',
                  observed_generation = gate_assignments.generation,
                  applied_plan_id = gate_assignments.plan_id,
                  actual_state_hash = $2,
                  reported_state = $3::jsonb,
                  applied_at = now(),
                  last_observed_at = now(),
                  updated_at = now()
              FROM gate_assignments
              WHERE gate_assignment_status.assignment_id = gate_assignments.id
                AND gate_assignment_status.assignment_id = $1
            `,
            [row.assignmentId, actualStateHash || null, JSON.stringify(resultSummary)]
          );
        }
      } else if (status === "succeeded" && row.type === "revoke_assignment") {
        await client.query(
          `
            UPDATE gate_assignment_status
            SET phase = 'revoked',
                actual_state_hash = $2,
                reported_state = $3::jsonb,
                revoked_at = now(),
                last_observed_at = now(),
                updated_at = now()
            WHERE assignment_id = $1
          `,
          [row.assignmentId, actualStateHash || null, JSON.stringify(resultSummary)]
        );
      } else {
        await client.query(
          `
            UPDATE gate_assignment_status
            SET phase = $2::gate_assignment_phase,
                last_error = $3::jsonb,
                updated_at = now()
            WHERE assignment_id = $1
          `,
          [
            row.assignmentId,
            terminalFailure ? "dead" : "retryable_failed",
            JSON.stringify({ errorCode: errorCode || "job_failed", resultSummary })
          ]
        );
      }
    }

    return true;
  });

  if (!updated) {
    return reply.code(404).send({ error: "job_not_found" });
  }

  return reply.send({ ok: true });
});

process.on("SIGTERM", () => {
  void app.close().finally(() => db.close());
});

await app.listen({ host, port });

interface SessionCreateParsed {
  mode: SessionMode;
  destinationCidrs: string[];
  sourceCidr?: string;
  clientPublicKey?: string;
  label?: string;
  spec: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  mode: SessionMode;
  desiredState: "Active" | "Revoked";
  phase: SessionSummary["phase"];
  label: string | null;
  destinationCidrs: string[];
  sourceCidr: string | null;
  selectedPath: Record<string, unknown> | null;
  lastError: { code?: string; message?: string } | null;
  createdAt: string;
  updatedAt: string;
}

function parseSessionCreateBody(body: Record<string, unknown>): SessionCreateParsed | { error: string; message?: string } {
  const mode = readString(body, "mode");
  if (mode !== "IpToIp" && mode !== "FullTunnel") {
    return { error: "invalid_mode" };
  }

  const destinationCidrs = normalizeDestinationCidrs(body, mode);
  if (destinationCidrs.length === 0) {
    return { error: "destination_required" };
  }

  const sourceCidr = normalizeOptionalCidr(readString(body, "sourceCidr") || ipToCidr(readString(body, "sourceIp")));
  const clientPublicKey = readString(body, "clientPublicKey") || undefined;
  const label = readString(body, "label") || undefined;
  const ingressGateName = readString(body, "ingressGateName") || undefined;
  const egressGateName = readString(body, "egressGateName") || undefined;
  const ingressGateId = readString(body, "ingressGateId") || undefined;
  const egressGateId = readString(body, "egressGateId") || undefined;

  if (!ingressGateName && !ingressGateId) {
    return { error: "ingress_gate_required" };
  }
  if (!egressGateName && !egressGateId) {
    return { error: "egress_gate_required" };
  }
  if ((ingressGateName && ingressGateName === egressGateName) || (ingressGateId && ingressGateId === egressGateId)) {
    return { error: "distinct_gates_required", message: "Ingress and egress must be different gates." };
  }
  if (clientPublicKey && !isWireGuardPublicKey(clientPublicKey)) {
    return { error: "invalid_client_public_key", message: "Client public key must be a canonical 44-character WireGuard public key." };
  }

  const spec = {
    desiredState: "Active",
    mode,
    destinationCidrs,
    ...(sourceCidr ? { sourceCidr } : {}),
    ...(clientPublicKey ? { clientPublicKey } : {}),
    ...(ingressGateName ? { ingressGateName } : {}),
    ...(egressGateName ? { egressGateName } : {}),
    ...(ingressGateId ? { ingressGateId } : {}),
    ...(egressGateId ? { egressGateId } : {}),
    pathPolicy: asRecord(body.pathPolicy ?? {}),
    artifactPolicy: asRecord(body.artifactPolicy ?? {})
  };

  return {
    mode,
    destinationCidrs,
    ...(sourceCidr ? { sourceCidr } : {}),
    ...(clientPublicKey ? { clientPublicKey } : {}),
    ...(label ? { label } : {}),
    spec
  };
}

function normalizeDestinationCidrs(body: Record<string, unknown>, mode: SessionMode): string[] {
  const rawCidrs = readStringArray(body, "destinationCidrs");
  const targetIp = readString(body, "targetIp");
  if (rawCidrs.length > 0) {
    return rawCidrs.map(normalizeRequiredCidr).filter(Boolean);
  }
  if (mode === "IpToIp" && targetIp) {
    return [ipToCidr(targetIp)];
  }
  if (mode === "FullTunnel") {
    return ["0.0.0.0/0"];
  }
  return [];
}

function normalizeRequiredCidr(value: string): string {
  return value.includes("/") ? value : `${value}/32`;
}

function normalizeOptionalCidr(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return normalizeRequiredCidr(value);
}

function ipToCidr(value: string): string {
  if (!value) {
    return "";
  }
  return value.includes("/") ? value : `${value}/32`;
}

function isWireGuardPublicKey(value: string): boolean {
  const trimmed = value.trim();
  if (!wireGuardCanonicalBase64Pattern.test(trimmed)) {
    return false;
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    return decoded.length === 32 && !decoded.every((byte) => byte === 0);
  } catch {
    return false;
  }
}

function sessionSelectSql(tail: string): string {
  return `
    SELECT
      sessions.id,
      sessions.mode::text AS mode,
      sessions.desired_state::text AS "desiredState",
      session_status.phase::text AS phase,
      sessions.label,
      ARRAY(SELECT unnest(sessions.destination_cidrs)::text) AS "destinationCidrs",
      sessions.source_cidr::text AS "sourceCidr",
      session_status.selected_path AS "selectedPath",
      session_status.last_error AS "lastError",
      sessions.created_at AS "createdAt",
      sessions.updated_at AS "updatedAt"
    FROM sessions
    JOIN session_status ON session_status.session_id = sessions.id
    ${tail}
  `;
}

async function readOwnSession(accountId: string, sessionId: string): Promise<SessionSummary | null> {
  const result = await db.query<SessionRow>(
    sessionSelectSql("WHERE sessions.account_id = $1 AND sessions.id = $2 AND sessions.hidden_at IS NULL"),
    [accountId, sessionId]
  );
  const row = result.rows[0];
  return row ? mapSessionRow(row) : null;
}

function mapSessionRow(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    mode: row.mode,
    desiredState: row.desiredState,
    phase: row.phase,
    ...(row.label ? { label: row.label } : {}),
    destinationCidrs: row.destinationCidrs,
    ...(row.sourceCidr ? { sourceCidr: row.sourceCidr } : {}),
    ...(row.selectedPath ? { selectedPath: row.selectedPath } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function listGates(): Promise<GateSummary[]> {
  const result = await db.query<{
    id: string;
    name: string;
    desiredState: GateSummary["desiredState"];
    region: string;
    city: string;
    country: string;
    countryCode: string;
    publicEndpoint: string;
    probeUrl: string | null;
    lastSeenAt: string | null;
    doubleZero: Record<string, unknown> | null;
    doubleZeroCurrentDevice: string | null;
    doubleZeroLowestLatencyDevice: string | null;
    doubleZeroLowestLatencyDeviceWarning: boolean | null;
    agentConnected: boolean;
    ready: boolean;
    schedulable: boolean;
  }>(
    `
      SELECT
        gates.id,
        gates.name,
        gates.desired_state::text AS "desiredState",
        gates.region,
        gates.city,
        gates.country,
        gates.country_code AS "countryCode",
        gates.public_endpoint AS "publicEndpoint",
        NULLIF(gates.spec->>'probeUrl', '') AS "probeUrl",
        gate_status.last_seen_at AS "lastSeenAt",
        gate_status.doublezero_status AS "doubleZero",
        gate_status.doublezero_current_device AS "doubleZeroCurrentDevice",
        gate_status.doublezero_lowest_latency_device AS "doubleZeroLowestLatencyDevice",
        gate_status.doublezero_lowest_latency_device_warning AS "doubleZeroLowestLatencyDeviceWarning",
        COALESCE(agent.status = 'True', false) AS "agentConnected",
        COALESCE(agent.status = 'True', false) AND COALESCE(ready.status = 'True', false) AS ready,
        COALESCE(agent.status = 'True', false) AND COALESCE(schedulable.status = 'True', false) AS schedulable
      FROM gates
      LEFT JOIN gate_status ON gate_status.gate_id = gates.id
      LEFT JOIN gate_conditions agent ON agent.gate_id = gates.id AND agent.type = 'AgentConnected'
      LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
      LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
      ORDER BY gates.region, gates.name
    `
  );
  return result.rows.map((row) => {
    const doubleZero = mergeGateDoubleZeroStatus({
      status: row.doubleZero,
      currentDevice: row.doubleZeroCurrentDevice,
      lowestLatencyDevice: row.doubleZeroLowestLatencyDevice,
      lowestLatencyDeviceWarning: row.doubleZeroLowestLatencyDeviceWarning
    });
    return {
      id: row.id,
      name: row.name,
      desiredState: row.desiredState,
      region: row.region,
      ...(row.city ? { city: row.city } : {}),
      ...(row.country ? { country: row.country } : {}),
      ...(row.countryCode ? { countryCode: row.countryCode } : {}),
      publicEndpoint: row.publicEndpoint,
      ...(row.probeUrl ? { probeUrl: row.probeUrl } : {}),
      ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt } : {}),
      ...(doubleZero ? { doubleZero } : {}),
      ready: row.ready,
      schedulable: row.schedulable
    };
  });
}

function mergeGateDoubleZeroStatus(input: {
  status: Record<string, unknown> | null;
  currentDevice: string | null;
  lowestLatencyDevice: string | null;
  lowestLatencyDeviceWarning: boolean | null;
}): Record<string, unknown> | null {
  const status = input.status && Object.keys(input.status).length > 0 ? { ...input.status } : {};
  if (input.currentDevice) {
    status.currentDevice = input.currentDevice;
  }
  if (input.lowestLatencyDevice) {
    status.lowestLatencyDevice = input.lowestLatencyDevice;
  }
  if (input.lowestLatencyDeviceWarning !== null) {
    status.lowestLatencyDeviceWarning = input.lowestLatencyDeviceWarning;
  }
  return Object.keys(status).length > 0 ? status : null;
}

async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const token = bearerToken(request);
  if (!token) {
    reply.code(401).send({ error: "auth_required" });
    return null;
  }

  const result = await db.query<AuthUser>(
    `
      SELECT
        users.id,
        users.account_id AS "accountId",
        users.email::text,
        users.display_name AS "displayName"
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = $1
        AND auth_sessions.expires_at > now()
        AND auth_sessions.revoked_at IS NULL
        AND users.disabled_at IS NULL
    `,
    [sha256Hex(token)]
  );
  const user = result.rows[0] ?? null;
  if (!user) {
    reply.code(401).send({ error: "invalid_auth_session" });
    return null;
  }

  await db.query("UPDATE auth_sessions SET last_seen_at = now() WHERE token_hash = $1", [sha256Hex(token)]);
  return user;
}

async function requireGate(request: FastifyRequest, reply: FastifyReply): Promise<GateAuth | null> {
  const gateName = headerValue(request, "x-gate-name");
  const gateToken = headerValue(request, "x-gate-token");
  if (!gateName || !gateToken) {
    reply.code(401).send({ error: "gate_auth_required" });
    return null;
  }

  const result = await db.query<GateAuth>(
    `
      SELECT
        gates.id,
        gates.name,
        gates.generation::int AS generation,
        gates.public_endpoint AS "publicEndpoint",
        gates.spec
      FROM gates
      JOIN gate_auth_tokens ON gate_auth_tokens.gate_id = gates.id
      WHERE gates.name = $1
        AND gate_auth_tokens.token_hash = $2
        AND gate_auth_tokens.revoked_at IS NULL
        AND (gate_auth_tokens.expires_at IS NULL OR gate_auth_tokens.expires_at > now())
    `,
    [gateName, sha256Hex(gateToken)]
  );
  const gate = result.rows[0] ?? null;
  if (!gate) {
    reply.code(401).send({ error: "invalid_gate_credentials" });
    return null;
  }
  return gate;
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!adminToken) {
    reply.code(503).send({ error: "admin_surface_not_configured" });
    return false;
  }
  if (headerValue(request, "x-admin-token") !== adminToken) {
    reply.code(401).send({ error: "admin_auth_required" });
    return false;
  }
  return true;
}

async function createAuthSession(
  userId: string,
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> } = db
): Promise<{ token: string; expiresAt: string }> {
  const token = newSecretToken();
  const expiresAt = new Date(Date.now() + authSessionTtlSeconds * 1000).toISOString();
  await client.query(
    `
      INSERT INTO auth_sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, $3::timestamptz)
    `,
    [userId, sha256Hex(token), expiresAt]
  );
  return { token, expiresAt };
}

async function upsertGateCondition(
  client: { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> },
  gateId: string,
  type: string,
  status: "True" | "False" | "Unknown",
  reason: string,
  message: string,
  observedGeneration: number
): Promise<void> {
  await client.query(
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
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (gate_id, type) DO UPDATE
      SET status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          message = EXCLUDED.message,
          observed_generation = EXCLUDED.observed_generation,
          last_transition_at = CASE
            WHEN gate_conditions.status <> EXCLUDED.status THEN now()
            ELSE gate_conditions.last_transition_at
          END
    `,
    [gateId, type, status, reason, message, observedGeneration]
  );
}

function hashPassword(password: string): string {
  const salt = newSecretToken(16);
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const [, salt, stored] = parts;
  if (!salt || !stored) {
    return false;
  }
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(stored, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function bearerToken(request: FastifyRequest): string {
  const header = headerValue(request, "authorization");
  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return header.slice("bearer ".length).trim();
}

function headerValue(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return typeof value === "string" ? value : "";
}

function detectClientIpv4(request: FastifyRequest): string {
  const candidates = [
    ...headerValue(request, "x-forwarded-for").split(","),
    headerValue(request, "x-real-ip"),
    request.ip
  ];
  for (const candidate of candidates) {
    const ip = normalizeIpv4(candidate);
    if (ip) {
      return ip;
    }
  }
  return "";
}

function normalizeIpv4(value: string): string {
  const candidate = value.trim().replace(/^::ffff:/, "");
  return isIP(candidate) === 4 ? candidate : "";
}

function readParam(request: FastifyRequest, name: string): string {
  const params = asRecord(request.params);
  return readString(params, name);
}

function readQuery(request: FastifyRequest, name: string): string {
  const query = asRecord(request.query);
  return readString(query, name);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function shouldReturnRawWireGuardConfig(request: FastifyRequest): boolean {
  if (readQuery(request, "format") === "conf") {
    return true;
  }
  return headerValue(request, "accept")
    .split(",")
    .some((entry) => entry.split(";", 1)[0]?.trim().toLowerCase() === "text/plain");
}

function attachmentFileName(value: string, artifactId: string): string {
  const fallback = `hyperspace-${artifactId.slice(0, 8)}.conf`;
  const baseName = value.split(/[\\/]/).pop()?.trim() || fallback;
  const sanitized = baseName.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return fallback;
  }
  return sanitized.endsWith(".conf") ? sanitized : `${sanitized}.conf`;
}

function encryptedPayloadFromRow(row: {
  encryptionMethod: string | null;
  nonce: string | null;
  ciphertext: string | null;
  authTag: string | null;
  aad: string | null;
  keyFingerprint: string | null;
}): EncryptedJsonPayload | null {
  if (!row.encryptionMethod || !row.nonce || !row.ciphertext || !row.authTag || !row.aad || !row.keyFingerprint) {
    return null;
  }
  if (row.encryptionMethod !== "aes-256-gcm") {
    throw new Error(`unsupported artifact encryption method ${row.encryptionMethod}`);
  }
  return {
    encryptionMethod: row.encryptionMethod,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    authTag: row.authTag,
    aad: row.aad,
    keyFingerprint: row.keyFingerprint
  };
}

function normalizeEmail(value: string): string {
  return value.toLowerCase();
}

function mustRow<T>(result: { rows: T[] }): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error("expected database row");
  }
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
