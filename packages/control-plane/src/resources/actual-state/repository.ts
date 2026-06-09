import type { Queryable } from "../../db/queryable.js";

export interface GateActualStatePersistenceInput {
  stateHash: string;
  capabilities: string[];
}

export async function updateGateActualState(
  db: Queryable,
  gateId: string,
  input: GateActualStatePersistenceInput
): Promise<void> {
  await db.query(
    `
      UPDATE gate_status
      SET actual_state_hash = $2,
          observed_capabilities = CASE WHEN cardinality($3::text[]) > 0 THEN $3::text[] ELSE observed_capabilities END,
          updated_at = now()
      WHERE gate_id = $1
    `,
    [gateId, input.stateHash || null, input.capabilities]
  );
}
