import type { Queryable } from "../../db/queryable.js";

export interface AddressPoolRow {
  id: string;
  cidr: string;
  nextOffset: string;
}

export async function findActiveClientAddressLease(
  db: Queryable,
  sessionId: string
): Promise<string | null> {
  const existing = await db.query<{ clientAddress: string }>(
    `
      SELECT client_address::text AS "clientAddress"
      FROM client_address_leases
      WHERE session_id = $1
        AND released_at IS NULL
      LIMIT 1
    `,
    [sessionId]
  );
  return existing.rows[0]?.clientAddress ?? null;
}

export async function listWireGuardAddressPoolsForUpdate(db: Queryable): Promise<AddressPoolRow[]> {
  const pools = await db.query<AddressPoolRow>(
    `
      SELECT id, cidr::text AS cidr, next_offset::text AS "nextOffset"
      FROM address_pools
      WHERE enabled = true
        AND family = 4
        AND purpose = 'wireguard_client'
      ORDER BY priority ASC, name ASC
      FOR UPDATE
    `
  );
  return pools.rows;
}

export async function tryInsertClientAddressLease(
  db: Queryable,
  input: {
    poolId: string;
    sessionId: string;
    clientAddress: string;
  }
): Promise<string | null> {
  const inserted = await db.query<{ clientAddress: string }>(
    `
      INSERT INTO client_address_leases (pool_id, session_id, client_address)
      VALUES ($1, $2, $3::inet)
      ON CONFLICT DO NOTHING
      RETURNING client_address::text AS "clientAddress"
    `,
    [input.poolId, input.sessionId, input.clientAddress]
  );
  return inserted.rows[0]?.clientAddress ?? null;
}

export async function updateAddressPoolNextOffset(
  db: Queryable,
  poolId: string,
  nextOffset: string
): Promise<void> {
  await db.query(
    "UPDATE address_pools SET next_offset = $2, updated_at = now() WHERE id = $1",
    [poolId, nextOffset]
  );
}

export async function markClientAddressLeaseReleased(
  db: Queryable,
  sessionId: string,
  reason: string
): Promise<void> {
  await db.query(
    `
      UPDATE client_address_leases
      SET released_at = now(),
          release_reason = $2
      WHERE session_id = $1
        AND released_at IS NULL
    `,
    [sessionId, reason]
  );
}
