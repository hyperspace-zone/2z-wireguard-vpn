import type { Queryable } from "../db/queryable.js";
import { sha256Hex } from "./tokens.js";

export interface AuthenticatedTradingProbeNode {
  id: string;
  name: string;
  generation: number;
  desiredState: "Enabled" | "Maintenance" | "Disabled";
}

export async function authenticateTradingProbeToken(
  db: Queryable,
  input: { nodeName: string; nodeToken: string }
): Promise<AuthenticatedTradingProbeNode | null> {
  const result = await db.query<AuthenticatedTradingProbeNode>(
    `
      SELECT
        trading_probe_nodes.id,
        trading_probe_nodes.name,
        trading_probe_nodes.generation::int AS generation,
        trading_probe_nodes.desired_state AS "desiredState"
      FROM trading_probe_nodes
      JOIN trading_probe_auth_tokens
        ON trading_probe_auth_tokens.probe_node_id = trading_probe_nodes.id
      WHERE trading_probe_nodes.name = $1
        AND trading_probe_auth_tokens.token_hash = $2
        AND trading_probe_auth_tokens.revoked_at IS NULL
        AND (
          trading_probe_auth_tokens.expires_at IS NULL
          OR trading_probe_auth_tokens.expires_at > now()
        )
    `,
    [input.nodeName, sha256Hex(input.nodeToken)]
  );
  return result.rows[0] ?? null;
}
