import assert from "node:assert/strict";
import test from "node:test";
import { choosePath } from "./choose-path.js";

interface QueryCall {
  sql: string;
  params: readonly unknown[] | undefined;
}

const ingressGate = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "gate-eu-fra-01",
  publicIpv4: "203.0.113.10",
  doubleZeroEnv: "mainnet-beta"
};

const egressGate = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "gate-na-chi-01",
  publicIpv4: "203.0.113.20",
  doubleZeroEnv: "mainnet-beta"
};

test("choosePath schedules an explicit mainnet-beta gate pair using gate_status readiness", async () => {
  const calls: QueryCall[] = [];
  const client = {
    async query<Row extends object = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[]
    ): Promise<{ rows: Row[] }> {
      calls.push({ sql, params });
      assertSchedulableGateQuery(sql);

      if (calls.length === 1) {
        assert.deepEqual(params, [null, null, ingressGate.name]);
        return { rows: [ingressGate as unknown as Row] };
      }

      assert.deepEqual(params, [ingressGate.id, null, egressGate.name]);
      return { rows: [egressGate as unknown as Row] };
    }
  };

  const path = await choosePath(client, {
    ingressGateName: ingressGate.name,
    egressGateName: egressGate.name
  });

  assert.deepEqual(path, {
    ingressGateId: ingressGate.id,
    ingressGateName: ingressGate.name,
    ingressPublicIpv4: ingressGate.publicIpv4,
    egressGateId: egressGate.id,
    egressGateName: egressGate.name,
    egressPublicIpv4: egressGate.publicIpv4
  });
  assert.equal(calls.length, 2);
});

function assertSchedulableGateQuery(sql: string): void {
  if (/gate_status\./.test(sql) && !/\bJOIN\s+gate_status\b/i.test(sql)) {
    throw new Error('missing FROM-clause entry for table "gate_status"');
  }

  assert.match(sql, /LEFT\s+JOIN\s+gate_status\s+ON\s+gate_status\.gate_id\s+=\s+gates\.id/i);
  assert.match(sql, /LEFT\s+JOIN\s+gate_leases\s+ON\s+gate_leases\.gate_id\s+=\s+gates\.id/i);
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
  assert.match(sql, /gate_status\.doublezero_status->>'tunnelSrc'\s+=\s+gates\.public_ipv4/i);
  assert.match(sql, /gate_leases\.lease_expires_at\s+>\s+now\(\)/i);
}
