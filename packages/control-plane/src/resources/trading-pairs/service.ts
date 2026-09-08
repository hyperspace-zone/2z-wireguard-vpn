import { createHash } from "node:crypto";
import type { PublicTradingLatencyResponse, PublicGateBenchmarkMatrixResponse, PublicTradingPairsResponse, PublicTradingRouteResponse, TradingPairRow, TradingPairsQuery } from "@hyperspace-zone/contracts";
import type { Queryable } from "../../db/queryable.js";
import { readPublicTradingLatency } from "../trading-probes/service.js";
import { readPublicGateBenchmarkMatrix } from "../../read-models/public-benchmarks.query.js";
import { SnapshotCache } from "./snapshot-cache.js";

type Target = PublicTradingLatencyResponse["targets"][number];
type Measurement = PublicTradingLatencyResponse["measurements"][number];
export type TradingPairsSnapshot = Omit<PublicTradingPairsResponse, "total" | "offset" | "limit">;
const caches = new WeakMap<Queryable, SnapshotCache<TradingPairsSnapshot>>();

export function tradingMeasurementState(node: { fresh: boolean }, target: Target, measurement: Measurement | undefined, now: number): "fresh" | "stale" | "unavailable" {
  if (!node.fresh) return "stale";
  if (!measurement) return "unavailable";
  if (!isRecent(measurement.measuredAt, Math.max(90, 3 * (target.intervalSeconds ?? 30)) * 1000, now)) return "stale";
  if (measurement.targetRevision !== target.revision) return "stale";
  if (measurement.status !== "succeeded" || measurement.addressFamily !== "ipv4" || measurement.failureCount > 0 || measurement.sampleCount < 2 || !finiteNonnegative(measurement.tcpMs)) return "unavailable";
  return "fresh";
}

export function buildTradingPairsSnapshot(latency: PublicTradingLatencyResponse, matrix: PublicGateBenchmarkMatrixResponse, now = Date.now()): TradingPairsSnapshot {
  const gates = new Map(matrix.gates.map(gate => [gate.id, gate]));
  const nodes = latency.nodes.map(node => {
    const gate = node.gateId ? gates.get(node.gateId) : undefined;
    return { ...node, ...(gate ? { gateName: gate.name } : {}), schedulable: Boolean(gate?.ready && gate.schedulable) };
  });
  // One curated public endpoint per venue in this release. Never turn chain/RPC
  // targets into exchanges or create a venue pair with two endpoints of itself.
  const venueKeys = new Set<string>();
  const venues = latency.targets.filter(target => {
    if (!target.venueKey || !["cex", "perpdex", "prediction"].includes(target.venueType ?? "") || venueKeys.has(target.venueKey)) return false;
    venueKeys.add(target.venueKey);
    return true;
  }).sort((a, b) => (a.venueKey ?? a.key).localeCompare(b.venueKey ?? b.key));
  const measurements = new Map(latency.measurements.filter(row => row.networkProfile === "direct").map(row => [`${row.nodeId}:${row.targetId}`, row]));
  const routes = new Map(matrix.routes.map(route => [`${route.sourceGateId}:${route.targetGateId}`, route]));
  const rows: TradingPairRow[] = [];
  for (const source of nodes) {
    for (let a = 0; a < venues.length; a += 1) for (let b = a + 1; b < venues.length; b += 1) {
      const venueA = venues[a]!;
      const venueB = venues[b]!;
      const directA = measurements.get(`${source.id}:${venueA.id}`);
      const directB = measurements.get(`${source.id}:${venueB.id}`);
      const states = [tradingMeasurementState(source, venueA, directA, now), tradingMeasurementState(source, venueB, directB, now)];
      const pairKey = `${venueA.venueKey}:${venueB.venueKey}`;
      const base: TradingPairRow = {
        id: routeId(source.id, "none", venueA, venueB), pairKey, sourceNodeId: source.id,
        venueAId: venueA.id, venueBId: venueB.id, status: states.includes("stale") ? "stale" : "unavailable",
        evidence: "estimated", reason: "Both venue probes must be fresh, complete, successful and IPv4-compatible with the VPN config.",
        legA: directLeg(directA), legB: directLeg(directB), configEligible: false
      };
      if (!states.every(state => state === "fresh") || !directA || !directB) { rows.push(base); continue; }
      if (Math.abs(time(directA.measuredAt) - time(directB.measuredAt)) > Math.max(venueA.intervalSeconds ?? 30, venueB.intervalSeconds ?? 30) * 1000) {
        rows.push({ ...base, status: "stale", reason: "The venue samples are from different measurement windows." }); continue;
      }
      const directIndexMs = directA.tcpMs! + directB.tcpMs!;
      if (directIndexMs <= 0 || !source.gateId || !source.schedulable) {
        rows.push({ ...base, reason: "Source gate is not schedulable or the baseline is invalid." }); continue;
      }
      let best: TradingPairRow | undefined;
      for (const egress of nodes) {
        if (!egress.gateId || egress.gateId === source.gateId || !egress.schedulable) continue;
        const route = routes.get(`${source.gateId}:${egress.gateId}`);
        const backbone = route?.doublezero;
        if (!backbone || route?.doublezeroApplicability?.status === "not_applicable" || backbone.status !== "succeeded" || !isRecent(backbone.measuredAt, 15 * 60_000, now) || !finiteNonnegative(backbone.rttMs?.p50) || backbone.sourceInterface !== "doublezero0" || backbone.lossPercent !== 0) continue;
        const exitA = measurements.get(`${egress.id}:${venueA.id}`);
        const exitB = measurements.get(`${egress.id}:${venueB.id}`);
        if (!exitA || !exitB || tradingMeasurementState(egress, venueA, exitA, now) !== "fresh" || tradingMeasurementState(egress, venueB, exitB, now) !== "fresh") continue;
        const times = [directA, directB, exitA, exitB].map(row => time(row.measuredAt));
        if (Math.max(...times) - Math.min(...times) > Math.max(venueA.intervalSeconds ?? 30, venueB.intervalSeconds ?? 30) * 1000) continue;
        const backboneRttMs = backbone.rttMs!.p50!;
        const estimatedA = backboneRttMs + exitA.tcpMs!;
        const estimatedB = backboneRttMs + exitB.tcpMs!;
        const savedA = directA.tcpMs! - estimatedA;
        const savedB = directB.tcpMs! - estimatedB;
        const estimatedIndexMs = estimatedA + estimatedB;
        const savedMs = directIndexMs - estimatedIndexMs;
        const regression = savedA < 0 || savedB < 0;
        const publicBackbone = route?.public;
        const publicRtt = publicBackbone?.status === "succeeded" && isRecent(publicBackbone.measuredAt, 15 * 60_000, now) && finiteNonnegative(publicBackbone.rttMs?.p50) ? publicBackbone.rttMs!.p50 : undefined;
        const candidate: TradingPairRow = {
          ...base, egressNodeId: egress.id, ingressGateName: source.gateName!, egressGateName: egress.gateName!,
          status: savedMs <= 0 ? "no_improvement" : regression ? "regression" : "estimated",
          reason: "TCP connection estimate: DoubleZero gate RTT + egress-to-venue TCP RTT. Not a tunnel A/B measurement or execution latency.",
          measuredAt: new Date(Math.min(...times)).toISOString(), backboneMeasuredAt: new Date(time(backbone.measuredAt)).toISOString(),
          directIndexMs, estimatedIndexMs, savedMs, savedPercent: savedMs / directIndexMs * 100,
          backboneRttMs, backboneLossPercent: backbone.lossPercent,
          ...(publicRtt !== undefined ? { publicBackboneRttMs: publicRtt, backboneSavedMs: publicRtt - backboneRttMs } : {}),
          legA: { ...base.legA, estimatedMs: estimatedA, savedMs: savedA, egressTcpMs: exitA.tcpMs!, ...(exitA.totalP50Ms !== undefined ? { egressApiP50Ms: exitA.totalP50Ms } : {}) },
          legB: { ...base.legB, estimatedMs: estimatedB, savedMs: savedB, egressTcpMs: exitB.tcpMs!, ...(exitB.totalP50Ms !== undefined ? { egressApiP50Ms: exitB.totalP50Ms } : {}) },
          configEligible: savedMs > 0 && !regression
        };
        // Prefer a route improving both legs; a faster aggregate with a leg
        // regression must not mask a balanced, slightly slower alternative.
        if (!best || (candidate.configEligible && !best.configEligible) || (candidate.configEligible === best.configEligible && estimatedIndexMs < best.estimatedIndexMs!)) best = candidate;
      }
      if (best) {
        best.id = routeId(source.id, best.egressNodeId!, venueA, venueB);
        rows.push(best);
      } else rows.push({ ...base, directIndexMs, reason: "No compatible fresh, loss-free DoubleZero gate route and venue samples. Same-metro DZ routes are not applicable." });
    }
  }
  return {
    generatedAt: new Date(now).toISOString(), methodology: "tcp-connect-estimate-v1", venues, nodes,
    matrix: latency.measurements.filter(row => row.networkProfile === "direct" && venues.some(venue => venue.id === row.targetId)), rows,
    summary: { combinations: rows.length, estimatedImprovements: rows.filter(row => row.status === "estimated").length, verifiedRoutes: 0, freshNodes: nodes.filter(node => node.fresh).length }
  };
}

export async function readTradingPairsSnapshot(db: Queryable, force = false): Promise<TradingPairsSnapshot> {
  const cache = snapshotCache(db);
  if (force) return { ...await cache.fresh(), snapshotStatus: "live", snapshotAgeSeconds: 0 };
  const { data, state, ageSeconds } = await cache.read();
  return {
    ...data, snapshotStatus: state, snapshotAgeSeconds: ageSeconds,
    // An old published snapshot is useful for browsing, never for a preset.
    rows: state === "live" ? data.rows : data.rows.map(row => ({ ...row, configEligible: false }))
  };
}

function snapshotCache(db: Queryable): SnapshotCache<TradingPairsSnapshot> {
  let cache = caches.get(db);
  if (!cache) {
    cache = new SnapshotCache(async () => {
      const [latency, matrix] = await Promise.all([readPublicTradingLatency(db), readPublicGateBenchmarkMatrix(db)]);
      return buildTradingPairsSnapshot(latency, matrix);
    });
    caches.set(db, cache);
  }
  return cache;
}

export function startTradingPairsRefresh(db: Queryable, onError: (error: unknown) => void): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void>;
  const tick = async () => {
    try { await snapshotCache(db).fresh(); } catch (error) { onError(error); }
    finally { if (!stopped) { timer = setTimeout(() => { active = tick(); }, 10_000); timer.unref(); } }
  };
  active = tick();
  return async () => { stopped = true; clearTimeout(timer); await active; };
}

export function filterTradingPairs(snapshot: TradingPairsSnapshot, query: TradingPairsQuery): PublicTradingPairsResponse {
  const venues = new Map(snapshot.venues.map(venue => [venue.id, venue]));
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const a = new Set((query.a ?? "").split(",").filter(Boolean));
  const b = new Set((query.b ?? "").split(",").filter(Boolean));
  const inSide = (selected: Set<string>, venue: Target) => selected.size === 0 || selected.has(venue.venueKey ?? "");
  let rows = snapshot.rows.filter(row => {
    const va = venues.get(row.venueAId)!; const vb = venues.get(row.venueBId)!;
    if (!(inSide(a, va) && inSide(b, vb)) && !(inSide(a, vb) && inSide(b, va))) return false;
    if (query.source && query.source !== "all" && query.source !== row.sourceNodeId) return false;
    if (query.evidence === "measured") return false;
    if (query.positive !== "false" && (row.savedMs ?? 0) <= 0) return false;
    if (query.noRegression !== "false" && (row.status === "regression" || row.status === "no_improvement")) return false;
    const types = [va.venueType, vb.venueType].sort().join("-");
    if (query.kind && query.kind !== "all" && (query.kind === "prediction" ? !types.includes("prediction") : types !== query.kind)) return false;
    const node = nodes.get(row.sourceNodeId)!;
    if (query.search && !`${va.displayName} ${vb.displayName} ${node.city} ${node.provider}`.toLowerCase().includes(query.search.toLowerCase())) return false;
    return true;
  });
  rows.sort((a, b) => {
    if (query.sort === "pair") return a.pairKey.localeCompare(b.pairKey) || a.id.localeCompare(b.id);
    const result = query.sort === "latency" ? (a.estimatedIndexMs ?? Infinity) - (b.estimatedIndexMs ?? Infinity)
      : query.sort === "percent" ? (b.savedPercent ?? -Infinity) - (a.savedPercent ?? -Infinity)
      : (b.savedMs ?? -Infinity) - (a.savedMs ?? -Infinity);
    return (Number.isNaN(result) ? 0 : result) || a.id.localeCompare(b.id);
  });
  if (query.group !== "all" && (!query.source || query.source === "all")) {
    const seen = new Set<string>(); rows = rows.filter(row => { if (seen.has(row.pairKey)) return false; seen.add(row.pairKey); return true; });
  }
  const offset = query.offset ?? 0; const limit = query.limit ?? 50;
  return { ...snapshot, rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
}

export async function resolveTradingRoute(db: Queryable, id: string, force = true): Promise<PublicTradingRouteResponse | null> {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const snapshot = await readTradingPairsSnapshot(db, force);
  const route = snapshot.rows.find(row => row.id === id && row.configEligible);
  if (!route) return null;
  const source = snapshot.nodes.find(node => node.id === route.sourceNodeId)!;
  const egress = snapshot.nodes.find(node => node.id === route.egressNodeId)!;
  return { route, source, egress, venues: snapshot.venues.filter(venue => [route.venueAId, route.venueBId].includes(venue.id)), warning: "Estimated from Hyperspace gate probes, not measured from your server. One shared egress; FullTunnel routes all IPv4 traffic in its network namespace. No execution or profit guarantee." };
}

function directLeg(value: Measurement | undefined): TradingPairRow["legA"] {
  if (!value || value.status !== "succeeded") return {};
  return {
    ...(finiteNonnegative(value.tcpMs) ? { directMs: value.tcpMs! } : {}),
    ...(finiteNonnegative(value.totalP50Ms) ? { directApiP50Ms: value.totalP50Ms! } : {}),
    ...(finiteNonnegative(value.totalP95Ms) ? { directApiP95Ms: value.totalP95Ms! } : {}),
    sampleCount: value.sampleCount, failureCount: value.failureCount
  };
}
function routeId(source: string, egress: string, a: Target, b: Target): string { return createHash("sha256").update(JSON.stringify(["tcp-connect-estimate-v1", source, egress, a.id, a.revision, b.id, b.revision])).digest("hex"); }
function finiteNonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function time(value: string): number { return new Date(value).getTime(); }
function isRecent(value: string, ttl: number, now: number): boolean { const age = now - time(value); return Number.isFinite(age) && age >= -5000 && age <= ttl; }
