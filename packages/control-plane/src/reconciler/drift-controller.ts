import type { Queryable } from "../db/queryable.js";
import { compareManagedHandles } from "../resources/actual-state/drift-policy.js";
import {
  listGateActualStateDriftInputs,
  setGateDriftCondition
} from "../resources/actual-state/repository.js";

export async function reconcileDrift(db: Queryable): Promise<void> {
  const gates = await listGateActualStateDriftInputs(db);

  for (const gate of gates) {
    const drift = compareManagedHandles(gate.desiredHandles, gate.actualHandles);
    await setGateDriftCondition(db, {
      gateId: gate.gateId,
      drifted: drift.drifted,
      message: drift.drifted
        ? `Gate actual state differs from desired managed handles (${drift.missingHandles.length} missing, ${drift.orphanHandles.length} orphan)`
        : "Gate actual state matches desired managed handles",
      details: {
        gateName: gate.gateName,
        actualStateHash: gate.actualStateHash,
        reportedAt: gate.reportedAt,
        missingHandles: drift.missingHandles,
        orphanHandles: drift.orphanHandles
      }
    });
  }
}
