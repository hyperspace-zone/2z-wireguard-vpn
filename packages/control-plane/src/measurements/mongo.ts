import { MongoClient, type Document } from "mongodb";
import type { GateBenchmarkMetric, PublicTradingLatencyResponse } from "@hyperspace-zone/contracts";

export type TradingMeasurement = PublicTradingLatencyResponse["measurements"][number] & Record<string, unknown>;
export interface BenchmarkMeasurement {
  sourceGateId: string; targetGateId: string; metric: GateBenchmarkMetric;
}
export interface BenchmarkLatest {
  sourceGateId: string; targetGateId: string; transport: string;
  recent: Array<{ eventId: string; measuredAt: Date; metric: GateBenchmarkMetric }>;
}
export interface MeasurementStore {
  initialize(): Promise<void>;
  deliver(id: string, kind: "benchmark" | "trading", payload: unknown): Promise<void>;
  benchmarks(gateIds?: readonly string[]): Promise<BenchmarkLatest[]>;
  trading(filter?: { nodeIds: readonly string[]; targetIds: readonly string[] }): Promise<TradingMeasurement[]>;
  stats?(): Promise<{ dataBytes: number; storageBytes: number; indexBytes: number }>;
  close(): Promise<void>;
}
type Stored = Document & { _id: string };
const DAY = 86_400_000;

/** No Mongo/PostgreSQL transaction. Every write is replayable independently.
 * Ordinary collections deliberately retain unique event IDs (time-series
 * collections cannot enforce the same uniqueness guarantees). */
export class MongoMeasurementStore implements MeasurementStore {
  readonly client: MongoClient;
  readonly databaseName: string;
  constructor(url: string, caFile?: string, options: { socketTimeoutMs?: number } = {}) {
    this.client = new MongoClient(url, {
      maxPoolSize: 3, minPoolSize: 1, waitQueueTimeoutMS: 250, serverSelectionTimeoutMS: 1200,
      connectTimeoutMS: 1200, socketTimeoutMS: options.socketTimeoutMs ?? 2500, maxIdleTimeMS: 60_000,
      writeConcern: { w: 1, j: true },
      ...(caFile ? { tls: true, tlsCAFile: caFile } : {})
    });
    this.databaseName = new URL(url.replace(/^mongodb\+srv:/, "mongodb:")).pathname.slice(1) || "hyperspace_measurements";
  }
  collection(name: string) { return this.client.db(this.databaseName).collection<Stored>(name); }
  async initialize(): Promise<void> {
    for (const name of ["benchmark_results", "trading_results", "trading_rollups"]) {
      await this.collection(name).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }
    await this.collection("benchmark_results").createIndex({ sourceGateId: 1, targetGateId: 1, transport: 1, measuredAt: -1 });
    await this.collection("trading_rollups").createIndex({ nodeId: 1, targetId: 1, networkProfile: 1, bucketStart: -1 });
    await this.collection("trading_latest").createIndex({ targetId: 1, nodeId: 1, networkProfile: 1 });
    await this.collection("benchmark_latest").createIndex({ sourceGateId: 1, targetGateId: 1, transport: 1 });
  }
  async deliver(id: string, kind: "benchmark" | "trading", payload: unknown): Promise<void> {
    if (kind === "benchmark") {
      const value = payload as BenchmarkMeasurement;
      const at = validDate(value.metric.measuredAt);
      const document: Stored = { _id: id, sourceGateId: value.sourceGateId, targetGateId: value.targetGateId,
        transport: value.metric.transport, measuredAt: at, metric: value.metric, expiresAt: new Date(at.getTime() + DAY) };
      if (document.expiresAt > new Date()) {
        await this.collection("benchmark_results").updateOne({ _id: id }, { $setOnInsert: document }, { upsert: true });
      }
      // Atomic, bounded latest-two list. Retry never counts as another cycle;
      // delayed deliveries cannot push a newer sample out of the list.
      const routeId = `${value.sourceGateId}:${value.targetGateId}:${value.metric.transport}`;
      await this.collection("benchmark_latest").updateOne({ _id: routeId }, [{ $set: {
        sourceGateId: { $literal: value.sourceGateId }, targetGateId: { $literal: value.targetGateId }, transport: { $literal: value.metric.transport },
        recent: { $slice: [{ $sortArray: { input: { $concatArrays: [
          { $filter: { input: { $ifNull: ["$recent", []] }, as: "item", cond: { $ne: ["$$item.eventId", { $literal: id }] } } },
          { $literal: [{ eventId: id, measuredAt: at, metric: value.metric }] }
        ] }, sortBy: { measuredAt: -1, eventId: -1 } } }, 2] }
      } }], { upsert: true });
      return;
    }
    const value = payload as TradingMeasurement;
    const at = validDate(value.measuredAt);
    const document: Stored = { ...value, _id: id, measuredAt: at, expiresAt: new Date(at.getTime() + DAY) };
    if (document.expiresAt > new Date()) {
      await this.collection("trading_results").updateOne({ _id: id }, { $setOnInsert: document }, { upsert: true });
    }
    const latestId = `${value.nodeId}:${value.targetId}:${value.networkProfile}`;
    const latest: Stored = { ...document, _id: latestId };
    delete latest.expiresAt;
    await this.replaceIfNewer("trading_latest", latest);
    const bucketStart = new Date(Math.floor(at.getTime() / 300_000) * 300_000);
    const expiresAt = new Date(bucketStart.getTime() + 14 * DAY);
    if (expiresAt > new Date()) {
      await this.replaceIfNewer("trading_rollups", { ...document, _id: `${latestId}:${bucketStart.toISOString()}`, bucketStart, expiresAt });
    }
  }
  async replaceIfNewer(name: string, document: Stored): Promise<void> {
    // Pipeline uses a literal document: error strings beginning with '$' are
    // data, never aggregation expressions. No upsert race/duplicate-key retry.
    await this.collection(name).updateOne({ _id: document._id }, [{ $replaceWith: { $cond: [
      { $or: [
        { $eq: [{ $type: "$measuredAt" }, "missing"] },
        { $lt: ["$measuredAt", { $literal: document.measuredAt }] },
        { $and: [{ $eq: ["$measuredAt", { $literal: document.measuredAt }] }, { $lte: [{ $ifNull: ["$targetRevision", 0] }, document.targetRevision ?? 0] }] }
      ] }, { $literal: document }, "$$ROOT"
    ] } }], { upsert: true });
  }
  async benchmarks(gateIds?: readonly string[]): Promise<BenchmarkLatest[]> {
    if (gateIds && !gateIds.length) return [];
    const filter = gateIds ? { sourceGateId: { $in: [...gateIds] }, targetGateId: { $in: [...gateIds] } } : {};
    return await this.collection("benchmark_latest").find(filter, {
      projection: { _id: 0, sourceGateId: 1, targetGateId: 1, transport: 1, recent: { $slice: 2 } },
      maxTimeMS: 1500, batchSize: 512
    }).limit(50_000).toArray() as unknown as BenchmarkLatest[];
  }
  async trading(selection?: { nodeIds: readonly string[]; targetIds: readonly string[] }): Promise<TradingMeasurement[]> {
    if (selection && (!selection.nodeIds.length || !selection.targetIds.length)) return [];
    const filter = selection ? { nodeId: { $in: [...selection.nodeIds] }, targetId: { $in: [...selection.targetIds] } } : {};
    const rows = await this.collection("trading_latest").find(filter, {
      projection: { _id: 0, nodeId: 1, targetId: 1, targetRevision: 1, addressFamily: 1, networkProfile: 1,
        status: 1, measuredAt: 1, dnsMs: 1, tcpMs: 1, tlsMs: 1, ttfbMs: 1, totalP50Ms: 1, totalP95Ms: 1,
        jitterMs: 1, sampleCount: 1, failureCount: 1, errorCode: 1, errorMessage: 1 },
      maxTimeMS: 1500, batchSize: 512
    }).limit(50_000).toArray();
    return rows.map(row => ({ ...row, measuredAt: (row.measuredAt as Date).toISOString() })) as unknown as TradingMeasurement[];
  }
  async close(): Promise<void> { await this.client.close(); }
  async stats(): Promise<{ dataBytes: number; storageBytes: number; indexBytes: number }> {
    const value = await this.client.db(this.databaseName).command({ dbStats: 1, scale: 1 }, { timeoutMS: 2000 });
    return { dataBytes: Number(value.dataSize), storageBytes: Number(value.storageSize), indexBytes: Number(value.indexSize) };
  }
}

export function validDate(value: unknown): Date {
  const result = new Date(String(value));
  if (!Number.isFinite(result.getTime())) throw new Error("Invalid measurement timestamp");
  // Reject future reports rather than keeping permanently 'fresh' measurements.
  if (result.getTime() > Date.now() + 300_000) throw new Error("Measurement timestamp is in the future");
  return result;
}
