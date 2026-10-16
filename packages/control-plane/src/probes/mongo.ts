import { randomUUID } from "node:crypto";
import type { Collection, Document } from "mongodb";
import type { GateBenchmarkMetric, PublicTradingLatencyResponse, TradingProbeJob, TradingProbeMetricSummary } from "@hyperspace-zone/contracts";
import type { AuthenticatedTradingProbeNode } from "../security/trading-probe-auth.js";
import { sha256Hex } from "../security/tokens.js";
import type { TradingProbeHeartbeat } from "../resources/trading-probes/service.js";
import type { ScheduleGateBenchmarkInput, ScheduleGateNtpDiscoveryInput, GateBenchmarkReportMetricInput } from "../resources/benchmarks/repository.js";
import { readBenchmarkResults } from "../resources/benchmarks/service.js";
import type { GateJobReport } from "../resources/jobs/attempts.js";
import type { ClaimedGateJob } from "../resources/jobs/repository.js";
import { validDate, type MongoMeasurementStore } from "../measurements/mongo.js";
import { catalogGates, catalogNodes, jobTarget, publicTarget, milliseconds, type ProbeCatalog } from "./catalog.js";

const DAY = 86_400_000;
export interface ProbeEvent { id: string; kind: "benchmark" | "trading"; payload: unknown }
export interface ProbeTask extends Document {
  _id: string; key: string; kind: "benchmark" | "trading" | "ntp"; sourceId: string; targetId: string;
  revision: number; intervalMs: number; payload: Record<string, any>;
  phase: "queued" | "leased" | "completed"; active: boolean;
  attempts: number; maxAttempts: number; createdAt: Date; updatedAt: Date; runAfter: Date;
  claimId?: string; leaseExpiresAt?: Date; leaseOwner?: string;
  completedAt?: Date; outcome?: string; errorCode?: string; events?: ProbeEvent[];
  deliveryPending?: boolean; deliveryAfter?: Date; deliveryAttempts?: number; expiresAt?: Date;
  lastReportedClaimId?: string;
  releaseAfter?: Date;
}
interface CatalogDocument extends Document { _id: string; rows: ProbeCatalog; capturedAt: Date }
interface NodeStatus extends Document { _id: string; lastSeenAt: Date; leaseExpiresAt: Date; report: TradingProbeHeartbeat }
interface ScheduleDocument extends Document { _id: string; completedAt: Date; revision: number }

/** Single-document compare-and-set queue; works on standalone Mongo and Atlas.
 * Completion + durable result journal are ONE atomic write. Projections are
 * delivered at least once; active keys remain reserved until delivery succeeds.
 * No cross-store transactions or authoritative operational data live here. */
export class MongoProbeStore {
  constructor(readonly measurements: MongoMeasurementStore, readonly prefix = "") {
    if (prefix && !/^__test_[a-f0-9]+_$/.test(prefix)) throw new Error("Invalid test collection prefix");
  }
  collection<T extends Document = Document & { _id: string }>(name: string): Collection<T> {
    return this.measurements.client.db(this.measurements.databaseName).collection<T>(`${this.prefix}probe_${name}`);
  }
  get tasks() { return this.collection<ProbeTask>("jobs"); }
  async initialize(): Promise<void> {
    await this.measurements.connect();
    await this.tasks.createIndex({ key: 1 }, { unique: true, partialFilterExpression: { active: true }, name: "one_active_task" });
    await this.tasks.createIndex({ claimId: 1 }, { unique: true, sparse: true });
    await this.tasks.createIndex({ sourceId: 1, kind: 1, phase: 1, runAfter: 1, createdAt: 1 });
    await this.tasks.createIndex({ phase: 1, leaseExpiresAt: 1 });
    await this.tasks.createIndex({ deliveryPending: 1, deliveryAfter: 1, completedAt: 1 });
    await this.tasks.createIndex({ phase: 1, active: 1, createdAt: 1 });
    await this.tasks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }
  async replaceCatalog(rows: ProbeCatalog, capturedAt = new Date()): Promise<void> {
    await this.measurements.connect();
    if (Buffer.byteLength(JSON.stringify(rows)) > 8 * 1024 * 1024) throw new Error("Probes catalog exceeds bounded snapshot size");
    // One atomic snapshot, including removals/revocations. Older syncs cannot
    // resurrect revoked tokens. API reads don't depend on core availability.
    await this.collection<CatalogDocument>("catalog").updateOne({ _id: "current" }, [{ $replaceWith: { $cond: [
      { $or: [{ $eq: [{ $type: "$capturedAt" }, "missing"] }, { $lt: ["$capturedAt", { $literal: capturedAt }] }] },
      { $literal: { _id: "current", rows, capturedAt } }, "$$ROOT"
    ] } }], { upsert: true });
  }
  async catalog(): Promise<ProbeCatalog> {
    await this.measurements.connect();
    const value = await this.collection<CatalogDocument>("catalog").findOne({ _id: "current" }, { maxTimeMS: 1500 });
    if (!value || Date.now() - value.capturedAt.getTime() > 60_000 || value.capturedAt.getTime() > Date.now() + 5000) {
      throw new Error("Probes catalog snapshot unavailable or stale");
    }
    return value.rows;
  }
  async authenticate(input: { nodeName: string; nodeToken: string }): Promise<AuthenticatedTradingProbeNode | null> {
    const catalog = await this.catalog();
    const node = catalogNodes(catalog).find(row => row.name === input.nodeName);
    if (!node) return null;
    const token = catalog.trading_probe_auth_tokens?.some(row => row.probe_node_id === node.id && row.token_hash === sha256Hex(input.nodeToken)
      && !row.revoked_at && (!row.expires_at || milliseconds(row.expires_at) > Date.now()));
    return token ? { id: node.id, name: node.name, generation: Number(node.generation), desiredState: node.desired_state } : null;
  }
  async heartbeat(node: AuthenticatedTradingProbeNode, report: TradingProbeHeartbeat): Promise<void> {
    await this.measurements.connect();
    const now = new Date();
    await this.collection<NodeStatus>("node_status").updateOne({ _id: node.id }, { $set: {
      lastSeenAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000), report
    } }, { upsert: true });
  }
  async enqueue(task: Pick<ProbeTask, "key" | "kind" | "sourceId" | "targetId" | "revision" | "intervalMs" | "payload" | "maxAttempts">): Promise<boolean> {
    await this.measurements.connect();
    const now = new Date();
    const state = await this.collection<ScheduleDocument>("schedule").findOne({ _id: task.key }, { maxTimeMS: 1500 });
    if (state && state.revision === task.revision && state.completedAt.getTime() + task.intervalMs > now.getTime()) return false;
    try {
      const inserted = await this.tasks.updateOne({ key: task.key, active: true }, { $setOnInsert: {
        ...task, _id: randomUUID(), phase: "queued", active: true, attempts: 0, createdAt: now, updatedAt: now, runAfter: now
      } }, { upsert: true });
      return inserted.upsertedCount === 1;
    } catch (error) {
      if ((error as {code?: number}).code === 11000) return false;
      throw error;
    }
  }
  async scheduleBenchmarks(input: ScheduleGateBenchmarkInput): Promise<number> {
    const gates = catalogGates(await this.catalog()).filter(gate => gate.benchmarkReady);
    let count = 0;
    for (const source of gates) for (const target of gates) {
      if (source.gate.id === target.gate.id) continue;
      const sameMetro = source.metro && target.metro && source.metro.toLowerCase() === target.metro.toLowerCase();
      const transports = [{ name: "public", interface: "public" }, ...(!sameMetro ? [{ name: "doublezero", interface: source.gate.doublezero_interface }] : [])];
      if (await this.enqueue({ key: `benchmark:${source.gate.id}:${target.gate.id}`, kind: "benchmark", sourceId: source.gate.id,
        targetId: target.gate.id, revision: 0, intervalMs: input.intervalSeconds * 1000, maxAttempts: 2,
        payload: { kind: "gate_benchmark_v1", sourceGateId: source.gate.id, sourceGateName: source.gate.name,
          targetGateId: target.gate.id, targetGateName: target.gate.name, targetPublicIpv4: target.gate.public_ipv4,
          targetProbePort: input.probePort, count: input.probeCount, intervalMs: input.probeIntervalMs, timeoutMs: input.probeTimeoutMs, transports }
      })) count++;
    }
    return count;
  }
  async scheduleNtp(input: ScheduleGateNtpDiscoveryInput): Promise<number> {
    let count = 0;
    for (const {gate, ready, schedulable, capabilities} of catalogGates(await this.catalog())) {
      if (!ready || !schedulable || !capabilities.includes("chrony:sync") || !capabilities.includes("ntp-discovery:enabled")) continue;
      if (await this.enqueue({ key: `ntp:${gate.id}`, kind: "ntp", sourceId: gate.id, targetId: gate.id, revision: 0,
        intervalMs: input.intervalSeconds * 1000, maxAttempts: 1, payload: { kind: "gate_ntp_discovery_v1", gateId: gate.id,
          gateName: gate.name, sampleSeconds: input.sampleSeconds, maxCandidates: input.maxCandidates } })) count++;
    }
    return count;
  }
  async scheduleTrading(): Promise<number> {
    const catalog = await this.catalog();
    const statuses = await this.collection<NodeStatus>("node_status").find({ leaseExpiresAt: { $gt: new Date() } }, { maxTimeMS: 1500 }).toArray();
    const live = new Set(statuses.map(row => row._id));
    let count = 0;
    for (const node of catalogNodes(catalog).filter(row => row.desired_state === "Enabled" && live.has(row.id))) {
      for (const target of (catalog.trading_probe_targets ?? []).filter(row => row.enabled)) {
        if (await this.enqueue({ key: `trading:${node.id}:${target.id}:direct`, kind: "trading", sourceId: node.id, targetId: target.id,
          revision: Number(target.revision), intervalMs: Number(target.interval_seconds) * 1000, maxAttempts: 3,
          payload: { networkProfile: "direct", target: jobTarget(target) } })) count++;
      }
    }
    return count;
  }
  async claim(sourceId: string, kind: "gate" | "trading", owner: string): Promise<ProbeTask | null> {
    const catalog = await this.catalog();
    const now = new Date();
    const trading = kind === "trading";
    const eligible = trading ? catalogNodes(catalog).some(row => row.id === sourceId && row.desired_state === "Enabled")
      : catalogGates(catalog).some(row => row.gate.id === sourceId && row.ready && row.schedulable);
    if (!eligible) return null;
    // Re-check target eligibility at claim time, not only at scheduling. Old
    // queued jobs must not probe revoked/disabled targets indefinitely.
    const targets = trading ? (catalog.trading_probe_targets ?? []).filter(row => row.enabled).map(row => row.id)
      : catalogGates(catalog).filter(row => row.ready && row.schedulable).map(row => row.gate.id);
    const currentRevisions = (catalog.trading_probe_targets ?? []).filter(row=>row.enabled).map(row=>({targetId:row.id,revision:Number(row.revision)}));
    if (trading && !currentRevisions.length) return null;
    const claimed = await this.tasks.findOneAndUpdate({ sourceId, kind: trading ? "trading" : { $in: ["benchmark", "ntp"] },
      targetId: { $in: targets }, ...(trading ? { $or: currentRevisions } : {}), phase: "queued", active: true, runAfter: { $lte: now } }, [{
      $set: { phase: "leased", claimId: { $literal: randomUUID() }, leaseOwner: { $literal: owner }, updatedAt: { $literal: now },
        attempts: { $add: ["$attempts", 1] },
        leaseExpiresAt: { $add: [{ $literal: now }, { $min: [900_000, { $max: [120_000,
          trading ? { $add: [15_000, { $multiply: [{ $add: [1, "$payload.target.sampleCount"] }, "$payload.target.timeoutMs"] }] }
            : { $multiply: [{ $add: [60, { $ifNull: ["$payload.sampleSeconds", 0] }] }, 1000] }
        ] }] }] }
      }
    }], { sort: { createdAt: 1, _id: 1 }, returnDocument: "after", maxTimeMS: 1500 });
    return claimed;
  }
  async claimGate(sourceId: string, owner: string): Promise<ClaimedGateJob | null> {
    const task = await this.claim(sourceId, "gate", owner);
    return task ? { id: task.claimId!, type: "probe", payload: task.payload, attemptNumber: task.attempts, sessionId: null, assignmentId: null } : null;
  }
  async claimTrading(node: AuthenticatedTradingProbeNode, owner: string): Promise<TradingProbeJob | null> {
    const task = await this.claim(node.id, "trading", owner);
    return task ? { id: task.claimId!, attemptNumber: task.attempts, networkProfile: "direct", target: task.payload.target } : null;
  }
  async reportGate(sourceId: string, claimId: string, report: GateJobReport): Promise<boolean> {
    await this.measurements.connect();
    const task = await this.tasks.findOne({ claimId, sourceId, kind: { $in: ["benchmark", "ntp"] } }, { maxTimeMS: 1500 });
    if (!task) return false;
    if (task.phase !== "leased") return task.lastReportedClaimId === claimId;
    if (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= Date.now()) return false;
    const events: ProbeEvent[] = [];
    if (task.kind === "benchmark") {
      const results = readBenchmarkResults(report.resultSummary);
      for (const transport of task.payload.transports ?? []) {
        if (!["public", "doublezero"].includes(transport.name)) continue;
        const result: GateBenchmarkReportMetricInput = results.find(row => row.transport === transport.name) ?? {
          transport: transport.name, status: "failed", errorCode: report.errorCode || "probe_result_missing"
        };
        const { samples: _samples, reverseOneWayMs: _reverse, oneWayClockErrorMs, ...values } = result;
        const metric: GateBenchmarkMetric = { ...values, measuredAt: validDate(values.measuredAt ?? new Date().toISOString()).toISOString(),
          ...(oneWayClockErrorMs === undefined ? {} : { oneWayDiagnostics: { clockErrorMs: oneWayClockErrorMs } }),
          ...(values.errorMessage ? { errorMessage: values.errorMessage.slice(0, 512) } : {}) };
        events.push({ id: `benchmark:${task._id}:${transport.name}`, kind: "benchmark", payload: { sourceGateId: sourceId, targetGateId: task.targetId, metric } });
      }
    }
    return this.complete(task, report.status, report.errorCode, events, report.status === "retryable_failed");
  }
  async reportTrading(node: AuthenticatedTradingProbeNode, claimId: string, attempt: number, result: TradingProbeMetricSummary): Promise<boolean> {
    await this.measurements.connect();
    const task = await this.tasks.findOne({ claimId, sourceId: node.id, kind: "trading", attempts: attempt }, { maxTimeMS: 1500 });
    if (!task) return false;
    if (task.phase !== "leased") return task.lastReportedClaimId === claimId;
    const resolved = result.resolvedIp ?? "";
    const payload = { ...result, measuredAt: validDate(result.measuredAt).toISOString(), nodeId: node.id, targetId: task.targetId,
      targetRevision: task.revision, networkProfile: "direct", addressFamily: resolved.includes(":") ? "ipv6" : /^\d+\.\d+\.\d+\.\d+$/.test(resolved) ? "ipv4" : "unknown",
      ...(result.errorMessage ? { errorMessage: result.errorMessage.slice(0, 512) } : {}) };
    return this.complete(task, result.status, result.errorCode ?? "", [{ id: `trading:${task._id}`, kind: "trading", payload }], false);
  }
  private async complete(task: ProbeTask, outcome: string, errorCode: string, events: ProbeEvent[], retry: boolean): Promise<boolean> {
    const now = new Date();
    const requeue = retry && task.attempts < task.maxAttempts;
    const result = await this.tasks.updateOne({ _id: task._id, claimId: task.claimId!, phase: "leased", leaseExpiresAt: { $gt: now } }, {
      $set: { phase: requeue ? "queued" : "completed", outcome, errorCode: errorCode.slice(0,128), lastReportedClaimId: task.claimId!, updatedAt: now,
        ...(requeue ? { runAfter: new Date(now.getTime() + 10_000) } : { completedAt: now, events, deliveryPending: true, deliveryAfter: now, deliveryAttempts: 0 }) },
      $unset: { leaseExpiresAt: "", leaseOwner: "" }
    });
    if (result.modifiedCount) return true;
    // Lost HTTP response / concurrent replay must acknowledge the same durable
    // completion, never create another cycle or accept an earlier lease.
    return !!await this.tasks.findOne({ _id: task._id, claimId: task.claimId!, lastReportedClaimId: task.claimId!, phase: { $ne: "leased" } }, { projection: { _id: 1 } });
  }
  async reapExpired(): Promise<void> {
    await this.measurements.connect();
    const now = new Date();
    // Keep the unique active key for the whole cooldown, including the gap
    // between a scheduler's state read and enqueue. Completion cannot race a
    // concurrent scheduler into creating an immediate duplicate cycle.
    await this.tasks.updateMany({ phase: "completed", active: true, deliveryPending: false, releaseAfter: { $lte: now } }, { $set: { active: false } });
    const expired = await this.tasks.find({ phase: "leased", leaseExpiresAt: { $lte: now } }, { maxTimeMS: 1500 }).limit(200).toArray();
    for (const task of expired) {
      const retry = task.attempts < task.maxAttempts;
      await this.tasks.updateOne({ _id: task._id, phase: "leased", claimId: task.claimId!, leaseExpiresAt: { $lte: now } }, {
        $set: { phase: retry ? "queued" : "completed", updatedAt: now, errorCode: "lease_expired",
          ...(retry ? { runAfter: new Date(now.getTime() + 10_000) } : { outcome: "dead", completedAt: now, events: [], deliveryPending: true, deliveryAfter: now }) },
        $unset: { leaseExpiresAt: "", leaseOwner: "" }
      });
    }
    // Configuration removals must not leave permanently active keys. Only
    // unclaimed work is cancelled; already completed journal entries are kept.
    const catalog = await this.catalog();
    const gates = catalogGates(catalog).filter(row => row.gate.desired_state === "Enabled").map(row => row.gate.id);
    const nodes = catalogNodes(catalog).filter(row => row.desired_state === "Enabled").map(row => row.id);
    const targets = (catalog.trading_probe_targets ?? []).filter(row => row.enabled).map(row => row.id);
    await this.tasks.updateMany({ phase: "queued", $or: [
      { kind: { $in: ["benchmark", "ntp"] }, $or: [{ sourceId: { $nin: gates } }, { targetId: { $nin: gates } }] },
      { kind: "trading", $or: [{ sourceId: { $nin: nodes } }, { targetId: { $nin: targets } }] }
    ] }, { $set: { phase: "completed", active: false, outcome: "cancelled", updatedAt: now, completedAt: now, expiresAt: new Date(now.getTime() + 2 * DAY) } });
    for (const target of (catalog.trading_probe_targets ?? []).filter(row=>row.enabled)) {
      await this.tasks.updateMany({ phase: "queued", kind: "trading", targetId: target.id, revision: { $ne: Number(target.revision) } }, {
        $set: { phase: "completed", active: false, outcome: "superseded", updatedAt: now, completedAt: now, expiresAt: new Date(now.getTime()+2*DAY) }
      });
    }
  }
  async deliver(limit = 200): Promise<number> {
    await this.measurements.connect();
    const rows = await this.tasks.find({ deliveryPending: true, deliveryAfter: { $lte: new Date() } }, { maxTimeMS: 1500 })
      .sort({ completedAt: 1 }).limit(limit).toArray();
    let delivered = 0;
    for (const row of rows) {
      try {
        for (const event of row.events ?? []) await this.measurements.deliver(event.id, event.kind, event.payload);
        await this.collection<ScheduleDocument>("schedule").updateOne({ _id: row.key }, [{ $replaceWith: { $cond: [
          { $or: [{ $eq: [{ $type: "$completedAt" }, "missing"] }, { $lte: ["$completedAt", { $literal: row.completedAt }] }] },
          { $literal: { _id: row.key, completedAt: row.completedAt, revision: row.revision } }, "$$ROOT"
        ] } }], { upsert: true });
        await this.tasks.updateOne({ _id: row._id, deliveryPending: true, phase: "completed" }, { $set: {
          deliveryPending: false, releaseAfter: new Date(row.completedAt!.getTime() + row.intervalMs),
          expiresAt: new Date(Math.max(Date.now() + 2 * DAY, row.completedAt!.getTime() + row.intervalMs + DAY))
        }, $unset: { events: "" } });
        delivered++;
      } catch {
        await this.tasks.updateOne({ _id: row._id, deliveryPending: true }, { $inc: { deliveryAttempts: 1 },
          $set: { deliveryAfter: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(row.deliveryAttempts ?? 0, 6))) } });
        throw new Error("Probe projection delivery failed; durable task journal retained");
      }
    }
    return delivered;
  }
  async stats() {
    await this.measurements.connect();
    const [pending, oldest, phases, catalog, queued] = await Promise.all([
      this.tasks.countDocuments({ deliveryPending: true }, { maxTimeMS: 1500 }),
      this.tasks.find({ deliveryPending: true }, { projection: { completedAt: 1 }, maxTimeMS: 1500 }).sort({ completedAt: 1 }).limit(1).toArray(),
      this.tasks.aggregate<{ _id: {kind: string; phase: string}; count: number }>([
        { $match: { active: true } }, { $group: { _id: {kind: "$kind", phase: "$phase"}, count: { $sum: 1 } } }
      ], { maxTimeMS: 1500 }).toArray(),
      this.collection<CatalogDocument>("catalog").findOne({ _id: "current" }, { projection: { capturedAt: 1 }, maxTimeMS: 1500 }),
      this.tasks.find({ phase: "queued", active: true }, { projection: { createdAt: 1 }, maxTimeMS: 1500 }).sort({ createdAt: 1 }).limit(1).toArray()
    ]);
    return { pending, oldestAge: oldest[0]?.completedAt ? (Date.now() - oldest[0].completedAt.getTime()) / 1000 : 0, phases,
      catalogAge: catalog ? (Date.now()-catalog.capturedAt.getTime())/1000 : 1e9,
      oldestQueuedAge: queued[0] ? (Date.now()-queued[0].createdAt.getTime())/1000 : 0 };
  }
  async tradingNodeMetrics() {
    const [catalog, statuses] = await Promise.all([this.catalog(), this.collection<NodeStatus>("node_status").find({}, { maxTimeMS: 1500 }).toArray()]);
    return catalogNodes(catalog).filter(row => row.desired_state !== "Disabled").map(node => {
      const status = statuses.find(row => row._id === node.id);
      const age = status ? (Date.now()-status.lastSeenAt.getTime())/1000 : 1e9;
      return { node: node.name as string, city: node.city as string, enabled: node.desired_state === "Enabled", fresh: age < 90, lastSeenAgeSeconds: age };
    });
  }
  async tradingLatency(category?: string, targetKey?: string): Promise<PublicTradingLatencyResponse> {
    const [catalog, statuses] = await Promise.all([this.catalog(), this.collection<NodeStatus>("node_status").find({}, { maxTimeMS: 1500 }).toArray()]);
    const nodes = catalogNodes(catalog).filter(row => row.desired_state !== "Disabled").sort((a,b)=>a.name.localeCompare(b.name)).map(node => {
      const status = statuses.find(row => row._id === node.id);
      return { id: node.id, name: node.name, ...(node.gate_id ? { gateId: node.gate_id } : {}), city: node.city, country: node.country,
        latitude: Number(node.latitude), longitude: Number(node.longitude), provider: node.provider, regionCode: node.region_code,
        fresh: !!status && Date.now()-status.lastSeenAt.getTime() < 90_000, ...(status ? { lastSeenAt: status.lastSeenAt.toISOString() } : {}) };
    });
    const targets = (catalog.trading_probe_targets ?? []).filter(row => row.enabled && (!category || row.category === category))
      .map(publicTarget).sort((a,b)=>a.sortOrder-b.sortOrder || a.key.localeCompare(b.key));
    const selected = targetKey ? targets.find(row => row.key === targetKey) ?? targets[0] : undefined;
    const measurements = await this.measurements.trading({ nodeIds: nodes.map(row => row.id), targetIds: targetKey ? (selected ? [selected.id] : []) : targets.map(row => row.id) });
    measurements.sort((a,b) => a.targetId.localeCompare(b.targetId) || (a.totalP50Ms ?? Infinity)-(b.totalP50Ms ?? Infinity));
    return { generatedAt: new Date().toISOString(), nodes, targets, measurements };
  }
}
