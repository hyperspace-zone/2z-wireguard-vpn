import type { Database } from "@hyperspace-zone/db";

export const catalogMirrors = [
  { table: "gates", key: "id" },
  { table: "gate_status", key: "gate_id" },
  { table: "gate_conditions", key: "id" },
  { table: "gate_leases", key: "gate_id" },
  { table: "gate_agent_deployments", key: "id", columns: "id, gate_id, phase" },
  { table: "trading_probe_nodes", key: "id" },
  { table: "trading_probe_auth_tokens", key: "id" },
  { table: "trading_probe_targets", key: "id" }
] as const;

/** End the read-only core snapshot before beginning the probes transaction.
 * No two-phase commit, foreign server, synchronous core write or reverse sync. */
export async function syncProbesCatalog(core: Database, probes: Database): Promise<void> {
  const snapshot = await core.transaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const rows: Record<string, unknown[]> = {};
    for (const mirror of catalogMirrors) {
      const columns = "columns" in mirror ? mirror.columns : "*";
      const result = await client.query(`SELECT row_to_json(row) AS value FROM (SELECT ${columns} FROM ${mirror.table}) row`);
      rows[mirror.table] = result.rows.map(row => row.value);
    }
    return rows;
  });
  await probes.transaction(async client => {
    // Preserve historical rows of retired gates, but never let a deleted core
    // gate remain enabled in the local measurement scheduler.
    await client.query("UPDATE gates SET desired_state='Disabled' WHERE NOT (id = ANY($1::uuid[]))", [(snapshot.gates as { id: string }[]).map(row => row.id)]);
    await client.query("UPDATE trading_probe_nodes SET desired_state='Disabled' WHERE NOT (id=ANY($1::uuid[]))", [(snapshot.trading_probe_nodes as { id: string }[]).map(row => row.id)]);
    await client.query("UPDATE trading_probe_targets SET enabled=false WHERE NOT (id=ANY($1::uuid[]))", [(snapshot.trading_probe_targets as { id: string }[]).map(row => row.id)]);
    for (const mirror of catalogMirrors) {
      const fields = await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [mirror.table]);
      const columns = fields.rows.map(row => row.column_name);
      const updates = columns.filter(name => name !== mirror.key).map(name => `"${name}"=EXCLUDED."${name}"`).join(",");
      await client.query(`INSERT INTO ${mirror.table} SELECT * FROM json_populate_recordset(NULL::${mirror.table}, $1::json) ON CONFLICT (${mirror.key}) DO UPDATE SET ${updates}`, [JSON.stringify(snapshot[mirror.table])]);
    }
    // Retired gate-host placements must not remain scheduled or raise stale
    // alerts because their old probe config is still Enabled. This state is
    // derived locally: standalone placements and core config are unchanged.
    // Source gate re-enablement restores configured state on the next sync.
    await client.query(`UPDATE trading_probe_nodes nodes SET desired_state='Disabled'
      WHERE nodes.placement_kind='gate_host' AND nodes.gate_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM gates WHERE gates.id=nodes.gate_id AND gates.desired_state='Disabled')`);
    // Removing/revoking credentials must also propagate, not just new tokens.
    for (const table of ["gate_status", "gate_conditions", "gate_leases", "gate_agent_deployments", "trading_probe_auth_tokens"] as const) {
      const mirror = catalogMirrors.find(item => item.table === table)!;
      const keys = (snapshot[table] as Record<string, unknown>[]).map(row => row[mirror.key]);
      await client.query(`DELETE FROM ${table} WHERE NOT (${mirror.key}=ANY($1::uuid[]))`, [keys]);
    }
    await client.query("INSERT INTO probes_catalog_sync(id,last_success_at) VALUES(true,now()) ON CONFLICT(id) DO UPDATE SET last_success_at=EXCLUDED.last_success_at");
  });
}
