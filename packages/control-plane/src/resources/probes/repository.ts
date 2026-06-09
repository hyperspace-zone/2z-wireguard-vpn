import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export interface CreateProbeRunInput {
  sessionId?: string;
  targetCidrs: string[];
}

export interface RecordProbeResultInput {
  probeRunId: string;
  gateId: string;
  target: string;
  rttMs?: number;
  packetLossPercent?: number;
  method: string;
}

export async function createProbeRun(db: Queryable, input: CreateProbeRunInput): Promise<string> {
  const result = await db.query<{ id: string }>(
    `
      INSERT INTO probe_runs (session_id, target_cidrs, status)
      VALUES ($1::uuid, $2::cidr[], 'queued')
      RETURNING id
    `,
    [input.sessionId || null, input.targetCidrs]
  );
  return mustRow(result).id;
}

export async function markProbeRunCompleted(db: Queryable, probeRunId: string): Promise<void> {
  await db.query(
    `
      UPDATE probe_runs
      SET status = 'completed',
          completed_at = now()
      WHERE id = $1
    `,
    [probeRunId]
  );
}

export async function insertProbeResult(db: Queryable, input: RecordProbeResultInput): Promise<void> {
  await db.query(
    `
      INSERT INTO probe_results (
        probe_run_id,
        gate_id,
        target,
        rtt_ms,
        packet_loss_percent,
        method
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      input.probeRunId,
      input.gateId,
      input.target,
      input.rttMs ?? null,
      input.packetLossPercent ?? null,
      input.method
    ]
  );
}
