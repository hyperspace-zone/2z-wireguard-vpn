import type { TransactionalQueryable } from "../db/queryable.js";
import { choosePath } from "../planning/choose-path.js";
import { toGatePreparePlan } from "../planning/network-plan.js";
import { renderWireGuardPlan } from "../planning/render-plan.js";
import { ensureClientAddressLease, releaseClientAddressLease, type AddressAllocatorLogger } from "../resources/addresses/allocator.js";
import { prepareClientConfigArtifact } from "../resources/artifacts/service.js";
import { createAssignment } from "../resources/gate-assignments/service.js";
import { enqueueApplyJob } from "../resources/jobs/service.js";
import { writeRenderedPlanSecret } from "../resources/rendered-plans/service.js";
import { setSessionCondition } from "../resources/sessions/conditions.js";
import {
  hasActiveClientConfigArtifact,
  insertSessionAuditEvent,
  invalidateSessionArtifacts,
  listAssignmentPhasesForSession,
  listProvisionedSessionsForActivation,
  listRequestedSessionsForUpdate,
  listSessionsReadyToMarkRevoked,
  listSessionsToBeginRevocation,
  listTimedOutProvisioningSessions,
  markApplyJobsDeadForSession,
  markPendingAssignmentsDeadForSession,
  markSessionActive,
  markSessionFailed,
  markSessionProvisioning,
  markSessionRevoked,
  markSessionRevoking,
  upsertRenderedPlan
} from "../resources/sessions/repository.js";

export interface SessionReconcileConfig {
  artifactEncryptionKey: Buffer;
  provisioningTimeoutSeconds: number;
  log?: AddressAllocatorLogger;
}

export async function scheduleRequestedSessions(
  db: TransactionalQueryable,
  config: Pick<SessionReconcileConfig, "artifactEncryptionKey" | "log">
): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await listRequestedSessionsForUpdate(client);

    for (const session of sessions) {
      const path = await choosePath(client, session.spec);
      if (!path) {
        const error = {
          code: "no_schedulable_path",
          message: "No ready ingress/egress gate pair is currently schedulable"
        };
        await setSessionCondition(client, session.id, "Ready", "False", "NoSchedulablePath", error.message, session.generation);
        await markSessionFailed(client, session.id, error);
        continue;
      }

      const clientAddress = await ensureClientAddressLease(client, session.id, config.log);
      if (!clientAddress) {
        const error = {
          code: "address_pool_exhausted",
          message: "No WireGuard client address is currently available"
        };
        await setSessionCondition(client, session.id, "Ready", "False", "AddressPoolExhausted", error.message, session.generation);
        await markSessionFailed(client, session.id, error);
        continue;
      }

      const plan = renderWireGuardPlan(session, path, clientAddress, config.artifactEncryptionKey);
      const planId = await upsertRenderedPlan(client, {
        sessionId: session.id,
        generation: session.generation,
        planHash: plan.planHash,
        publicMaterial: plan.publicMaterial,
        routingModel: plan.routingModel,
        firewallModel: plan.firewallModel,
        secretRefs: plan.secretRefs
      });
      if (plan.secretPayload) {
        await writeRenderedPlanSecret(client, planId, plan.secretPayload);
      }

      const ingressAssignment = await createAssignment(client, {
        sessionId: session.id,
        gateId: path.ingressGateId,
        role: "Ingress",
        planId
      });
      const egressAssignment = await createAssignment(client, {
        sessionId: session.id,
        gateId: path.egressGateId,
        role: "Egress",
        planId
      });

      await enqueueApplyJob(client, {
        assignmentId: ingressAssignment,
        gateId: path.ingressGateId,
        sessionId: session.id,
        operation: "prepare",
        role: "Ingress",
        plan: toGatePreparePlan(planId, plan)
      });
      await enqueueApplyJob(client, {
        assignmentId: egressAssignment,
        gateId: path.egressGateId,
        sessionId: session.id,
        operation: "prepare",
        role: "Egress",
        plan: toGatePreparePlan(planId, plan)
      });
      await markSessionProvisioning(client, session.id, session.generation, {
        ingressGateId: path.ingressGateId,
        ingressGateName: path.ingressGateName,
        ingressPublicEndpoint: path.ingressPublicEndpoint,
        egressGateId: path.egressGateId,
        egressGateName: path.egressGateName,
        egressPublicEndpoint: path.egressPublicEndpoint
      });
      await setSessionCondition(
        client,
        session.id,
        "Ready",
        "False",
        "Provisioning",
        "Ingress and egress gate assignments are being applied",
        session.generation
      );
    }
  });
}

export async function completeProvisionedSessions(
  db: TransactionalQueryable,
  config: Pick<SessionReconcileConfig, "artifactEncryptionKey">
): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await listProvisionedSessionsForActivation(client);

    for (const session of sessions) {
      if (!(await hasActiveClientConfigArtifact(client, session.id))) {
        await prepareClientConfigArtifact(client, session.id, session.generation, config.artifactEncryptionKey);
      }

      await markSessionActive(client, session.id, session.generation);
      await setSessionCondition(client, session.id, "Ready", "True", "AssignmentsApplied", "Session is active", session.generation);
      await insertSessionAuditEvent(client, "session_active", session.id, {});
    }
  });
}

export async function failTimedOutProvisioningSessions(
  db: TransactionalQueryable,
  config: Pick<SessionReconcileConfig, "provisioningTimeoutSeconds">
): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await listTimedOutProvisioningSessions(client, config.provisioningTimeoutSeconds);

    for (const session of sessions) {
      const assignments = await listAssignmentPhasesForSession(client, session.id);
      const pendingAssignments = assignments.filter((assignment) => assignment.phase !== "applied");
      const pendingText = pendingAssignments
        .map((assignment) => `${assignment.role.toLowerCase()} ${assignment.gateName}: ${assignment.phase}`)
        .join("; ");
      const message = pendingText
        ? `Provisioning timed out waiting for gate confirmation (${pendingText})`
        : "Provisioning timed out waiting for gate confirmation";
      const error = {
        code: "gate_confirmation_timeout",
        message
      };

      await markApplyJobsDeadForSession(client, session.id);
      await markPendingAssignmentsDeadForSession(client, session.id, error);
      await invalidateSessionArtifacts(client, session.id);
      await markSessionFailed(client, session.id, error);
      await releaseClientAddressLease(client, session.id, "provisioning_failed");
      await setSessionCondition(client, session.id, "Ready", "False", "ProvisioningFailed", message, session.generation);
      await insertSessionAuditEvent(client, "session_failed", session.id, error);
    }
  });
}

export async function beginSessionRevocation(db: TransactionalQueryable): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await listSessionsToBeginRevocation(client);
    for (const session of sessions) {
      await markSessionRevoking(client, session.id);
    }
  });
}

export async function completeRevokedSessions(db: TransactionalQueryable): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await listSessionsReadyToMarkRevoked(client);

    for (const session of sessions) {
      await invalidateSessionArtifacts(client, session.id);
      await markSessionRevoked(client, session.id, session.generation);
      await releaseClientAddressLease(client, session.id, "session_revoked");
      await setSessionCondition(client, session.id, "Ready", "False", "Revoked", "Session has been revoked", session.generation);
      await insertSessionAuditEvent(client, "session_revoked", session.id, {});
    }
  });
}
