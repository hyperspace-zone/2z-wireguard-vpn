import type { Queryable } from "../../db/queryable.js";
import { updateGateActualState } from "./repository.js";

export interface GateActualStateReport {
  stateHash: string;
  capabilities: string[];
}

export async function recordGateActualState(
  db: Queryable,
  gateId: string,
  report: GateActualStateReport
): Promise<void> {
  await updateGateActualState(db, gateId, report);
}
