import type { EncryptedJsonPayload } from "@hyperspace-zone/shared";
import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export interface ArtifactDownloadRow {
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
}

export interface RenderedPlanArtifactRow {
  id: string;
  publicMaterial: unknown;
}

export interface AssignmentArtifactMaterialRow {
  role: string;
  gateName: string;
  publicEndpoint: string;
  localMaterial: unknown;
}

export async function selectRenderedPlanForArtifact(
  db: Queryable,
  sessionId: string,
  generation: number
): Promise<RenderedPlanArtifactRow | null> {
  const planResult = await db.query<RenderedPlanArtifactRow>(
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
  return planResult.rows[0] ?? null;
}

export async function listAssignmentMaterialsForArtifact(
  db: Queryable,
  sessionId: string
): Promise<AssignmentArtifactMaterialRow[]> {
  const assignments = await db.query<AssignmentArtifactMaterialRow>(
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
  return assignments.rows;
}

export async function selectRenderedPlanSecret(
  db: Queryable,
  planId: string
): Promise<EncryptedJsonPayload | null> {
  const planSecret = await db.query<EncryptedJsonPayload>(
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
    [planId]
  );
  return planSecret.rows[0] ?? null;
}

export async function insertClientConfigArtifact(
  db: Queryable,
  input: {
    sessionId: string;
    publicPayload: Record<string, unknown>;
    keyFingerprints: string[];
    encryptedArtifact: EncryptedJsonPayload;
    initialPhase: string;
  }
): Promise<string> {
  const artifact = await db.query<{ id: string }>(
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
      VALUES ($1, 'client_config', $5, $2::jsonb, $3::text[], $4::jsonb, now())
      RETURNING id
    `,
    [
      input.sessionId,
      JSON.stringify(input.publicPayload),
      input.keyFingerprints,
      JSON.stringify({ oneTime: false }),
      input.initialPhase
    ]
  );
  return String(mustRow(artifact).id);
}

export async function insertClientConfigArtifactPayload(
  db: Queryable,
  artifactId: string,
  encryptedArtifact: EncryptedJsonPayload
): Promise<void> {
  await db.query(
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
}

export async function attachArtifactToSessionStatus(
  db: Queryable,
  sessionId: string,
  artifactId: string
): Promise<void> {
  await db.query(
    "UPDATE session_status SET artifact_id = $2, updated_at = now() WHERE session_id = $1",
    [sessionId, artifactId]
  );
}

export async function selectLatestClientConfigArtifactForSession(
  db: Queryable,
  accountId: string,
  sessionId: string
): Promise<{ id: string } | null> {
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
    [sessionId, accountId]
  );
  return artifact.rows[0] ?? null;
}

export async function insertArtifactDownloadToken(
  db: Queryable,
  input: {
    artifactId: string;
    subjectUserId: string;
    tokenHash: string;
    expiresAt: string;
    availablePhase: string;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO artifact_download_tokens (artifact_id, token_hash, subject_user_id, expires_at)
      VALUES ($1, $2, $3, $4::timestamptz)
    `,
    [input.artifactId, input.tokenHash, input.subjectUserId, input.expiresAt]
  );
  await db.query(
    `
      UPDATE artifacts
      SET phase = $2, issued_at = COALESCE(issued_at, now())
      WHERE id = $1
    `,
    [input.artifactId, input.availablePhase]
  );
}

export async function invalidateArtifactsForSession(
  db: Queryable,
  input: {
    sessionId: string;
    invalidatedPhase: string;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE artifacts
      SET invalidated_at = now(),
          phase = $2
      WHERE session_id = $1
        AND invalidated_at IS NULL
    `,
    [input.sessionId, input.invalidatedPhase]
  );
}

export async function revokeExpiredArtifactDownloadTokens(db: Queryable): Promise<number> {
  const result = await db.query(
    `
      UPDATE artifact_download_tokens
      SET revoked_at = now()
      WHERE revoked_at IS NULL
        AND expires_at <= now()
    `
  );
  return result.rowCount ?? 0;
}

export async function redeemArtifactDownloadTokenRow(
  db: TransactionalQueryable,
  tokenHash: string,
  downloadedPhase: string
): Promise<ArtifactDownloadRow | null> {
  return db.transaction(async (client) => {
    const tokenRow = await client.query<ArtifactDownloadRow>(
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
      "UPDATE artifacts SET phase = $2, downloaded_at = now() WHERE id = $1",
      [row.artifactId, downloadedPhase]
    );
    return row;
  });
}
