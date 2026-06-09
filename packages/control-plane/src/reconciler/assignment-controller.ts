import type { TransactionalQueryable } from "../db/queryable.js";
import { assignmentNetworkMaterial } from "../planning/network-plan.js";
import {
  listAssignmentsToRevoke,
  listSessionAssignmentMaterials,
  markAssignmentDesiredRevoked,
  markAssignmentRevoking,
  markPreparedAssignmentsQueued
} from "../resources/gate-assignments/repository.js";
import { enqueueApplyJob, enqueueRevokeAssignmentJob } from "../resources/jobs/service.js";
import { setSessionCondition } from "../resources/sessions/conditions.js";
import {
  listSessionsReadyForCommit,
  touchSessionStatus
} from "../resources/sessions/repository.js";

export async function enqueueCommitJobsForPreparedAssignments(db: TransactionalQueryable): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await listSessionsReadyForCommit(client);

    for (const session of sessions) {
      const assignments = await listSessionAssignmentMaterials(client, session.id);
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

      await enqueueApplyJob(client, {
        assignmentId: ingress.id,
        gateId: ingress.gateId,
        sessionId: session.id,
        operation: "commit",
        role: "Ingress",
        networkPlan
      });
      await enqueueApplyJob(client, {
        assignmentId: egress.id,
        gateId: egress.gateId,
        sessionId: session.id,
        operation: "commit",
        role: "Egress",
        networkPlan
      });
      await markPreparedAssignmentsQueued(client, ingress.id, egress.id);
      await touchSessionStatus(client, session.id);
      await setSessionCondition(
        client,
        session.id,
        "Ready",
        "False",
        "ApplyingNetworkPlan",
        "Both gates prepared local key material; network plan commit is queued",
        session.generation
      );
    }
  });
}

export async function enqueueRevocationJobsForAssignments(db: TransactionalQueryable): Promise<void> {
  await db.transaction(async (client) => {
    const assignments = await listAssignmentsToRevoke(client);
    for (const assignment of assignments) {
      await markAssignmentDesiredRevoked(client, assignment.assignmentId);
      await markAssignmentRevoking(client, assignment.assignmentId);
      await enqueueRevokeAssignmentJob(client, assignment);
    }
  });
}
