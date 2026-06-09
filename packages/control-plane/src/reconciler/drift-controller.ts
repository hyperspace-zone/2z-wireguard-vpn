import type { Queryable, TransactionalQueryable } from "../db/queryable.js";
import { assignmentNetworkMaterial } from "../planning/network-plan.js";
import { compareManagedHandles } from "../resources/actual-state/drift-policy.js";
import { listGateActualStateDriftInputs } from "../resources/actual-state/repository.js";
import { recordGateAuditEvent } from "../resources/audit/service.js";
import {
  listKnownOrphanAssignmentsForCleanup,
  listMissingHandleRepairSessions,
  listSessionAssignmentMaterials,
  markAssignmentRevoking,
  markMissingHandleAssignmentsDrifted
} from "../resources/gate-assignments/repository.js";
import { enqueueApplyJob, enqueueRevokeAssignmentJob } from "../resources/jobs/service.js";
import { setGateDriftCondition } from "../resources/gates/conditions.js";

export async function reconcileDrift(db: TransactionalQueryable): Promise<void> {
  await db.transaction(async (client) => {
    const gates = await listGateActualStateDriftInputs(client);

    for (const gate of gates) {
      if (!gate.reportedAt) {
        continue;
      }

      const drift = compareManagedHandles(gate.desiredHandles, gate.actualHandles);
      const message = drift.drifted
        ? `Gate actual state differs from desired managed handles (${drift.missingHandles.length} missing, ${drift.orphanHandles.length} orphan)`
        : "Gate actual state matches desired managed handles";
      const details = {
        gateName: gate.gateName,
        actualStateHash: gate.actualStateHash,
        reportedAt: gate.reportedAt,
        missingHandles: drift.missingHandles,
        orphanHandles: drift.orphanHandles
      };

      const condition = await setGateDriftCondition(client, {
        gateId: gate.gateId,
        drifted: drift.drifted,
        message
      });

      if (condition.changedToDrift) {
        await recordGateAuditEvent(client, {
          eventType: "gate_drift_detected",
          gateId: gate.gateId,
          details
        });
      }

      if (!drift.drifted) {
        continue;
      }

      await markMissingHandleAssignmentsDrifted(client, gate.gateId, drift.missingHandles);
      await enqueueRepairJobsForMissingHandles(client, gate.gateId, drift.missingHandles);
      await enqueueCleanupJobsForKnownOrphans(client, gate.gateId, drift.orphanHandles);
    }
  });
}

async function enqueueRepairJobsForMissingHandles(
  db: Queryable,
  gateId: string,
  missingHandles: string[]
): Promise<void> {
  const sessions = await listMissingHandleRepairSessions(db, gateId, missingHandles);
  for (const session of sessions) {
    const assignments = await listSessionAssignmentMaterials(db, session.id);
    const ingress = assignments.find((assignment) => assignment.role === "Ingress");
    const egress = assignments.find((assignment) => assignment.role === "Egress");
    if (!ingress || !egress) {
      continue;
    }

    const networkPlan = {
      planId: session.planId,
      sessionId: session.id,
      generation: session.generation,
      publicMaterial: session.publicMaterial,
      routingModel: session.routingModel,
      firewallModel: session.firewallModel,
      ingress: assignmentNetworkMaterial(ingress),
      egress: assignmentNetworkMaterial(egress)
    };

    await enqueueApplyJob(db, {
      assignmentId: ingress.id,
      gateId: ingress.gateId,
      sessionId: session.id,
      operation: "commit",
      role: "Ingress",
      networkPlan
    });
    await enqueueApplyJob(db, {
      assignmentId: egress.id,
      gateId: egress.gateId,
      sessionId: session.id,
      operation: "commit",
      role: "Egress",
      networkPlan
    });
  }
}

async function enqueueCleanupJobsForKnownOrphans(
  db: Queryable,
  gateId: string,
  orphanHandles: string[]
): Promise<void> {
  const assignments = await listKnownOrphanAssignmentsForCleanup(db, gateId, orphanHandles);
  for (const assignment of assignments) {
    await markAssignmentRevoking(db, assignment.assignmentId);
    await enqueueRevokeAssignmentJob(db, assignment);
  }
}
