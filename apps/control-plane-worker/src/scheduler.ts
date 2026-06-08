const doubleZeroGateSqlPredicate = `
  AND 'doublezero0:up' = ANY(gate_status.observed_capabilities)
  AND gate_status.doublezero_status->>'tunnelStatus' = 'BGP Session Up'
  AND gate_status.doublezero_status->>'network' = COALESCE(NULLIF(gates.spec->>'doubleZeroEnv', ''), 'testnet')
  AND gate_status.doublezero_status->>'tunnelSrc' = gates.public_endpoint
`;

export interface PathChoice {
  ingressGateId: string;
  ingressGateName: string;
  ingressPublicEndpoint: string;
  egressGateId: string;
  egressGateName: string;
  egressPublicEndpoint: string;
}

interface Queryable {
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function choosePath(client: Queryable, spec: Record<string, unknown>): Promise<PathChoice | null> {
  const ingressGateId = readOptionalString(spec, "ingressGateId");
  const egressGateId = readOptionalString(spec, "egressGateId");
  const ingressGateName = readOptionalString(spec, "ingressGateName");
  const egressGateName = readOptionalString(spec, "egressGateName");
  const gates = await client.query(
    `
      SELECT gates.id, gates.name, gates.public_endpoint AS "publicEndpoint"
      FROM gates
      LEFT JOIN gate_status ON gate_status.gate_id = gates.id
      LEFT JOIN gate_conditions agent ON agent.gate_id = gates.id AND agent.type = 'AgentConnected'
      LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
      LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
      WHERE gates.desired_state = 'Enabled'
        AND COALESCE(agent.status = 'True', false)
        AND COALESCE(ready.status = 'True', false)
        AND COALESCE(schedulable.status = 'True', false)
        ${doubleZeroGateSqlPredicate}
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
      LEFT JOIN gate_status ON gate_status.gate_id = gates.id
      LEFT JOIN gate_conditions agent ON agent.gate_id = gates.id AND agent.type = 'AgentConnected'
      LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
      LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
      WHERE gates.desired_state = 'Enabled'
        AND gates.id <> $1
        AND COALESCE(agent.status = 'True', false)
        AND COALESCE(ready.status = 'True', false)
        AND COALESCE(schedulable.status = 'True', false)
        ${doubleZeroGateSqlPredicate}
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

function readOptionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}
