import type { Queryable } from "../../db/queryable.js";
import {
  createProbeRun,
  insertProbeResult,
  markProbeRunCompleted,
  type CreateProbeRunInput,
  type RecordProbeResultInput
} from "./repository.js";

export function summarizeProbeMetric(value: number, unit: string): string {
  return `${value} ${unit}`;
}

export async function recordProbeRun(
  db: Queryable,
  input: CreateProbeRunInput & {
    results: Omit<RecordProbeResultInput, "probeRunId">[];
  }
): Promise<string> {
  const probeRunId = await createProbeRun(db, input);
  for (const result of input.results) {
    await insertProbeResult(db, {
      ...result,
      probeRunId
    });
  }
  await markProbeRunCompleted(db, probeRunId);
  return probeRunId;
}
