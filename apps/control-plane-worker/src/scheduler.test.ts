import assert from "node:assert/strict";
import test from "node:test";
import { choosePath } from "./scheduler.js";

interface QueryCall {
  sql: string;
  params: readonly unknown[] | undefined;
}

const ingressGate = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "gate-ingress-01",
  publicEndpoint: "203.0.113.10",
  doubleZeroEnv: "mainnet-beta"
};

const egressGate = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "gate-egress-01",
  publicEndpoint: "203.0.113.20",
  doubleZeroEnv: "mainnet-beta"
};

test("choosePath schedules an explicit mainnet-beta gate pair using gate_status readiness", async () => {
  const calls: QueryCall[] = [];
  const client = {
    async query(sql: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
      calls.push({ sql, params });
      assertSchedulableGateQuery(sql);

      if (calls.length === 1) {
        assert.deepEqual(params, [null, ingressGate.name]);
        return { rows: [ingressGate] };
      }

      assert.deepEqual(params, [ingressGate.id, null, egressGate.name]);
      return { rows: [egressGate] };
    }
  };

  const path = await choosePath(client, {
    ingressGateName: ingressGate.name,
    egressGateName: egressGate.name
  });

  assert.deepEqual(path, {
    ingressGateId: ingressGate.id,
    ingressGateName: ingressGate.name,
    ingressPublicEndpoint: ingressGate.publicEndpoint,
    egressGateId: egressGate.id,
    egressGateName: egressGate.name,
    egressPublicEndpoint: egressGate.publicEndpoint
  });
  assert.equal(calls.length, 2);
});

function assertSchedulableGateQuery(sql: string): void {
  if (/gate_status\./.test(sql) && !/\bJOIN\s+gate_status\b/i.test(sql)) {
    throw new Error('missing FROM-clause entry for table "gate_status"');
  }

  assert.match(sql, /LEFT\s+JOIN\s+gate_status\s+ON\s+gate_status\.gate_id\s+=\s+gates\.id/i);
  assert.match(sql, /LEFT\s+JOIN\s+gate_conditions\s+agent\b/i);
  assert.match(sql, /LEFT\s+JOIN\s+gate_conditions\s+ready\b/i);
  assert.match(sql, /LEFT\s+JOIN\s+gate_conditions\s+schedulable\b/i);
  assert.match(sql, /COALESCE\(agent\.status\s+=\s+'True',\s+false\)/i);
  assert.match(sql, /COALESCE\(ready\.status\s+=\s+'True',\s+false\)/i);
  assert.match(sql, /COALESCE\(schedulable\.status\s+=\s+'True',\s+false\)/i);
  assert.match(sql, /'doublezero0:up'\s+=\s+ANY\(gate_status\.observed_capabilities\)/i);
  assert.match(sql, /gate_status\.doublezero_status->>'tunnelStatus'\s+=\s+'BGP Session Up'/i);
  assert.match(
    sql,
    /gate_status\.doublezero_status->>'network'\s+=\s+COALESCE\(NULLIF\(gates\.spec->>'doubleZeroEnv',\s+''\),\s+'testnet'\)/i
  );
  assert.match(sql, /gate_status\.doublezero_status->>'tunnelSrc'\s+=\s+gates\.public_endpoint/i);
}
