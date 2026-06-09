import type { Queryable } from "../../db/queryable.js";

export interface GateLeasePersistenceInput {
  gateId: string;
  leaseOwner: string;
  ttlSeconds: number;
}

export const freshGateLeaseSqlPredicate = "COALESCE(gate_leases.lease_expires_at > now(), false)";

export async function upsertGateLease(db: Queryable, input: GateLeasePersistenceInput): Promise<void> {
  await db.query(
    `
      INSERT INTO gate_leases (gate_id, lease_owner, lease_expires_at, heartbeat_at)
      VALUES ($1, $2, now() + ($3::int * interval '1 second'), now())
      ON CONFLICT (gate_id) DO UPDATE
      SET lease_owner = EXCLUDED.lease_owner,
          lease_expires_at = EXCLUDED.lease_expires_at,
          heartbeat_at = now()
    `,
    [input.gateId, input.leaseOwner, input.ttlSeconds]
  );
}

export async function listExpiredGateLeaseIds(db: Queryable, staleSeconds: number): Promise<string[]> {
  const result = await db.query<{ gateId: string }>(
    `
      SELECT gates.id AS "gateId"
      FROM gates
      LEFT JOIN gate_leases ON gate_leases.gate_id = gates.id
      WHERE gate_leases.lease_expires_at IS NULL
         OR gate_leases.lease_expires_at <= now()
         OR gate_leases.heartbeat_at < now() - ($1::int * interval '1 second')
    `,
    [staleSeconds]
  );
  return result.rows.map((row) => row.gateId);
}
