import type { SessionSummary } from "@hyperspace-zone/contracts";
import type { Queryable } from "../db/queryable.js";

interface AdminSessionRow {
  id: string;
  mode: SessionSummary["mode"];
  desiredState: SessionSummary["desiredState"];
  phase: SessionSummary["phase"];
  label: string | null;
  destinationCidrs: string[];
  sourceCidr: string | null;
  selectedPath: Record<string, unknown> | null;
  lastError: { code?: string; message?: string } | null;
  createdAt: string;
  updatedAt: string;
}

export async function listAdminSessions(db: Queryable): Promise<SessionSummary[]> {
  const result = await db.query<AdminSessionRow>(
    `
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
      WHERE sessions.hidden_at IS NULL
      ORDER BY sessions.created_at DESC
      LIMIT 500
    `
  );
  return result.rows.map(mapAdminSessionRow);
}

function mapAdminSessionRow(row: AdminSessionRow): SessionSummary {
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
