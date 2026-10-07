import type { Database } from "@hyperspace-zone/db";
import { measurementStore } from "@hyperspace-zone/control-plane";

export async function readMongoBenchmarkMetricRows(db: Database) {
  const store = measurementStore(db)!;
  const gates = await db.query<{ id: string; name: string; ip: string; probe: string | null; connected: boolean; metro: string | null }>(`
      SELECT gates.id,gates.name,gates.public_ipv4 AS ip,gates.spec->>'probeUrl' AS probe,
      COALESCE(agent.status='True' AND leases.lease_expires_at>now(),false) AS connected,
      NULLIF(BTRIM(status.doublezero_status->>'metro'),'') AS metro
      FROM gates LEFT JOIN gate_status status ON status.gate_id=gates.id
      LEFT JOIN gate_conditions agent ON agent.gate_id=gates.id AND agent.type='AgentConnected'
      LEFT JOIN gate_leases leases ON leases.gate_id=gates.id
      WHERE gates.desired_state='Enabled' ORDER BY gates.name`);
  const latest = await store.benchmarks(gates.rows.map(gate => gate.id));
  const indexed = new Map(latest.map(row => [`${row.sourceGateId}:${row.targetGateId}:${row.transport}`, row.recent]));
  return gates.rows.flatMap(source => gates.rows.filter(target => target.id !== source.id).flatMap(target => {
    const sameMetro = source.metro && target.metro && source.metro.toLowerCase() === target.metro.toLowerCase();
    return (sameMetro ? ["public"] : ["public", "doublezero"]).map(transport => {
      const samples = indexed.get(`${source.id}:${target.id}:${transport}`) ?? [];
      const metric = samples[0]?.metric;
      return {
        sourceGate: source.name, sourcePublicIpv4: source.ip, sourceProbeUrl: source.probe, sourceAgentConnected: source.connected,
        targetGate: target.name, targetPublicIpv4: target.ip, targetProbeUrl: target.probe, targetAgentConnected: target.connected,
        transport, status: metric?.status ?? null, sampleCount: samples.length,
        failedSampleCount: samples.filter(value => value.metric.status === "failed").length,
        rttP50Ms: metric?.rttMs?.p50 ?? null, jitterMs: metric?.jitterMs ?? null, lossPercent: metric?.lossPercent ?? null,
        ageSeconds: metric ? (Date.now()-new Date(metric.measuredAt).getTime())/1000 : null
      };
    });
  }));
}

export async function readMongoTradingTargetMetricRows(db: Database) {
  const [targets, nodes] = await Promise.all([
    db.query<{ id: string; target: string; category: string }>("SELECT id,target_key AS target,category FROM trading_probe_targets WHERE enabled=true"),
    db.query<{ id: string }>("SELECT id FROM trading_probe_nodes WHERE desired_state <> 'Disabled'")
  ]);
  const latest = await measurementStore(db)!.trading({ nodeIds: nodes.rows.map(node => node.id), targetIds: targets.rows.map(target => target.id) });
  const live = new Set(nodes.rows.map(node => node.id));
  return targets.rows.map(target => {
    const values = latest.filter(value => value.targetId === target.id && live.has(value.nodeId));
    const newest = Math.max(...values.map(value => new Date(value.measuredAt).getTime()));
    return { target: target.target, category: target.category,
      reportingNodes: values.filter(value => value.status === "succeeded").length,
      failedNodes: values.filter(value => value.status === "failed").length,
      rateLimitedNodes: values.filter(value => value.errorCode === "rate_limited").length,
      latestAgeSeconds: Number.isFinite(newest) ? (Date.now()-newest)/1000 : 1_000_000_000
    };
  });
}
