import type { Queryable } from "../db/queryable.js";
import type { GateDesiredState } from "../resources/gates/transitions.js";
import { sha256Hex } from "./tokens.js";

export interface AuthenticatedGate {
  id: string;
  name: string;
  generation: number;
  desiredState: GateDesiredState;
  publicEndpoint: string;
  spec: Record<string, unknown>;
}

export function gateTokenHash(token: string): string {
  return sha256Hex(token);
}

export async function authenticateGateToken(
  db: Queryable,
  input: {
    gateName: string;
    gateToken: string;
  }
): Promise<AuthenticatedGate | null> {
  const result = await db.query<AuthenticatedGate>(
    `
      SELECT
        gates.id,
        gates.name,
        gates.generation::int AS generation,
        gates.desired_state::text AS "desiredState",
        gates.public_endpoint AS "publicEndpoint",
        gates.spec
      FROM gates
      JOIN gate_auth_tokens ON gate_auth_tokens.gate_id = gates.id
      WHERE gates.name = $1
        AND gate_auth_tokens.token_hash = $2
        AND gate_auth_tokens.revoked_at IS NULL
        AND (gate_auth_tokens.expires_at IS NULL OR gate_auth_tokens.expires_at > now())
    `,
    [input.gateName, gateTokenHash(input.gateToken)]
  );
  return result.rows[0] ?? null;
}
