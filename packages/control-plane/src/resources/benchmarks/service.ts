import type { Queryable } from "../../db/queryable.js";
import {
  insertDueGateBenchmarkProbeJobs,
  insertGateBenchmarkReport,
  type GateBenchmarkReportMetricInput,
  type ScheduleGateBenchmarkInput
} from "./repository.js";

export interface GateBenchmarkSchedulerConfig extends ScheduleGateBenchmarkInput {
  enabled: boolean;
}

export async function scheduleGateBenchmarkProbes(
  db: Queryable,
  config: GateBenchmarkSchedulerConfig
): Promise<number> {
  if (!config.enabled) {
    return 0;
  }
  return insertDueGateBenchmarkProbeJobs(db, config);
}

export async function recordGateBenchmarkJobReport(
  db: Queryable,
  input: {
    jobId: string;
    sourceGateId: string;
    payload: Record<string, unknown>;
    resultSummary: Record<string, unknown>;
  }
): Promise<void> {
  if (readString(input.payload, "kind") !== "gate_benchmark_v1") {
    return;
  }
  const targetGateId = readString(input.payload, "targetGateId");
  if (!targetGateId) {
    return;
  }
  const results = readBenchmarkResults(input.resultSummary);
  if (results.length === 0) {
    return;
  }
  await insertGateBenchmarkReport(db, {
    jobId: input.jobId,
    sourceGateId: input.sourceGateId,
    targetGateId,
    results
  });
}

function readBenchmarkResults(summary: Record<string, unknown>): GateBenchmarkReportMetricInput[] {
  const value = summary.results;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(readBenchmarkResult).filter((entry): entry is GateBenchmarkReportMetricInput => entry !== null);
}

function readBenchmarkResult(value: unknown): GateBenchmarkReportMetricInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const transport = readString(record, "transport");
  if (transport !== "public" && transport !== "doublezero") {
    return null;
  }
  const status = readString(record, "status") === "failed" ? "failed" : "succeeded";
  const result: GateBenchmarkReportMetricInput = {
    transport,
    status
  };
  assignString(result, "sourceInterface", readString(record, "sourceInterface"));
  assignString(result, "targetEndpoint", readString(record, "targetEndpoint"));
  assignNumber(result, "packetCount", readNumber(record, "packetCount"));
  assignNumber(result, "packetsReceived", readNumber(record, "packetsReceived"));
  assignNumber(result, "lossPercent", readNumber(record, "lossPercent"));
  assignSummary(result, "rttMs", readSummary(record.rttMs));
  assignNumber(result, "jitterMs", readNumber(record, "jitterMs"));
  assignSummary(result, "forwardOneWayMs", readSummary(record.forwardOneWayMs));
  assignSummary(result, "reverseOneWayMs", readSummary(record.reverseOneWayMs));
  if (Array.isArray(record.samples)) {
    result.samples = record.samples;
  }
  assignString(result, "errorCode", readString(record, "errorCode"));
  assignString(result, "errorMessage", readString(record, "errorMessage"));
  assignString(result, "measuredAt", readString(record, "measuredAt"));
  return result;
}

function readSummary(value: unknown): GateBenchmarkReportMetricInput["rttMs"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const summary: NonNullable<GateBenchmarkReportMetricInput["rttMs"]> = {};
  const min = readNumber(record, "min");
  const p50 = readNumber(record, "p50");
  const p95 = readNumber(record, "p95");
  const max = readNumber(record, "max");
  if (min !== undefined) summary.min = min;
  if (p50 !== undefined) summary.p50 = p50;
  if (p95 !== undefined) summary.p95 = p95;
  if (max !== undefined) summary.max = max;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function assignString<T extends keyof GateBenchmarkReportMetricInput>(
  result: GateBenchmarkReportMetricInput,
  key: T,
  value: string
): void {
  if (value) {
    Object.assign(result, { [key]: value });
  }
}

function assignNumber<T extends keyof GateBenchmarkReportMetricInput>(
  result: GateBenchmarkReportMetricInput,
  key: T,
  value: number | undefined
): void {
  if (value !== undefined) {
    Object.assign(result, { [key]: value });
  }
}

function assignSummary<T extends keyof GateBenchmarkReportMetricInput>(
  result: GateBenchmarkReportMetricInput,
  key: T,
  value: GateBenchmarkReportMetricInput["rttMs"]
): void {
  if (value) {
    Object.assign(result, { [key]: value });
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
