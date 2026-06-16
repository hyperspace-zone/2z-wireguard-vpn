import type { TransactionalQueryable } from "../db/queryable.js";
import { choosePath } from "../planning/choose-path.js";
import { toGatePreparePlan } from "../planning/network-plan.js";
import { renderWireGuardPlan } from "../planning/render-plan.js";
import { ensureClientAddressLease, releaseClientAddressLease, type AddressAllocatorLogger } from "../resources/addresses/allocator.js";
import { invalidateSessionArtifacts, prepareClientConfigArtifact } from "../resources/artifacts/service.js";
import { listAssignmentPhasesForSession } from "../resources/gate-assignments/repository.js";
import { createAssignment, markPendingAssignmentsDeadForSession } from "../resources/gate-assignments/service.js";
import { enqueueApplyJob, markApplyJobsDeadForSession } from "../resources/jobs/service.js";
import { recordProbeRun } from "../resources/probes/service.js";
import { upsertRenderedPlan, writeRenderedPlanSecret } from "../resources/rendered-plans/service.js";
import { setSessionCondition } from "../resources/sessions/conditions.js";
import {
  hasActiveClientConfigArtifact,
  insertSessionAuditEvent,
  listProbingSessionsForUpdate,
  listProvisionedSessionsForActivation,
  listRequestedSessionsForUpdate,
  listSchedulingSessionsForUpdate,
  listSessionsReadyToMarkRevoked,
  listSessionsToBeginRevocation,
  listTimedOutProvisioningSessions,
  markSessionActive,
  markSessionFailed,
  markSessionProvisioning,
  markSessionRevoked,
  markSessionRevoking,
  updateSessionStatusPhase
} from "../resources/sessions/repository.js";
import {
  activeTransition,
  beginRevokingTransition,
  failedTransition,
  probingTransition,
  provisioningTransition,
  schedulingTransition,
  revokedTransition,
  type SessionPhase
} from "../resources/sessions/transitions.js";

export interface SessionReconcileConfig {
  artifactEncryptionKey: Buffer;
  provisioningTimeoutSeconds: number;
  log?: AddressAllocatorLogger;
}

export async function beginRequestedSessionProbing(db: TransactionalQueryable): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await listRequestedSessionsForUpdate(client);

    for (const session of sessions) {
      await recordProbeRun(client, {
        sessionId: session.id,
        targetCidrs: session.destinationCidrs,
        results: []
      });
      await updateSessionStatusPhase(client, {
        sessionId: session.id,
        ...probingTransition()
      });
      await setSessionCondition(
        client,
        session.id,
        "Ready",
        "False",
        "Probing",
        "Path probe inputs are being collected",
        session.generation
      );
    }
  });
}

export async function advanceProbedSessionsToScheduling(db: TransactionalQueryable): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await listProbingSessionsForUpdate(client);

    for (const session of sessions) {
      await updateSessionStatusPhase(client, {
        sessionId: session.id,
        ...schedulingTransition()
      });
      await setSessionCondition(
        client,
        session.id,
        "Ready",
        "False",
        "Scheduling",
        "Ingress and egress gate candidates are being selected",
        session.generation
      );
    }
  });
}

export async function scheduleSessionsForProvisioning(
  db: TransactionalQueryable,
  config: Pick<SessionReconcileConfig, "artifactEncryptionKey" | "log">
): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await listSchedulingSessionsForUpdate(client);

    for (const session of sessions) {
      const path = await choosePath(client, session.spec);
      if (!path) {
        const error = {
          code: "no_schedulable_path",
          message: "No ready ingress/egress gate pair is currently schedulable"
        };
        await setSessionCondition(client, session.id, "Ready", "False", "NoSchedulablePath", error.message, session.generation);
        await markSessionFailed(client, session.id, failedTransition(error));
        continue;
      }

      const clientAddress = await ensureClientAddressLease(client, session.id, config.log);
      if (!clientAddress) {
        const error = {
          code: "address_pool_exhausted",
          message: "No WireGuard client address is currently available"
        };
        await setSessionCondition(client, session.id, "Ready", "False", "AddressPoolExhausted", error.message, session.generation);
        await markSessionFailed(client, session.id, failedTransition(error));
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
      const selectedPath = {
        ingressGateId: path.ingressGateId,
        ingressGateName: path.ingressGateName,
        ingressPublicIpv4: path.ingressPublicIpv4,
        egressGateId: path.egressGateId,
        egressGateName: path.egressGateName,
        egressPublicIpv4: path.egressPublicIpv4
      };
      await markSessionProvisioning(client, session.id, provisioningTransition(session.generation, selectedPath), selectedPath);
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

      await markSessionActive(client, session.id, activeTransition(session.generation));
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
      await markSessionFailed(client, session.id, failedTransition(error));
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
      const transition = beginRevokingTransition(session.phase as SessionPhase);
      if (transition) {
        await markSessionRevoking(client, session.id, transition);
      }
    }
  });
}

export async function completeRevokedSessions(db: TransactionalQueryable): Promise<void> {
  await db.transaction(async (client) => {
    const sessions = await listSessionsReadyToMarkRevoked(client);

    for (const session of sessions) {
      await invalidateSessionArtifacts(client, session.id);
      await markSessionRevoked(client, session.id, revokedTransition(session.generation));
      await releaseClientAddressLease(client, session.id, "session_revoked");
      await setSessionCondition(client, session.id, "Ready", "False", "Revoked", "Session has been revoked", session.generation);
      await insertSessionAuditEvent(client, "session_revoked", session.id, {});
    }
  });
}
