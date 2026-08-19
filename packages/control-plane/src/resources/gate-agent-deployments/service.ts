import type { GateAgentDeployment, GateAgentRelease } from "@hyperspace-zone/contracts";
import { canOperateCluster } from "../../authz/policies.js";
import type { Principal } from "../../authz/principals.js";
import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import {
  insertGateAgentDeployment,
  insertGateAgentRelease,
  listGateAgentDeployments,
  listGateAgentReleases,
  readGateAgentDeployment,
  requestDeploymentRollback,
  type CreateGateAgentReleaseInput
} from "./repository.js";

export async function createGateAgentRelease(
  db: Queryable,
  principal: Principal,
  input: Omit<CreateGateAgentReleaseInput, "createdBy">
): Promise<GateAgentRelease | "forbidden"> {
  if (!canOperateCluster(principal)) return "forbidden";
  return insertGateAgentRelease(db, { ...input, createdBy: principal.id });
}

export async function requestGateAgentDeployment(
  db: TransactionalQueryable,
  principal: Principal,
  input: { gateId: string; releaseId: string }
): Promise<GateAgentDeployment | "forbidden" | "gate_not_found" | "gate_not_bootstrapped" | "release_not_found" | "deployment_active"> {
  if (!canOperateCluster(principal)) return "forbidden";
  const result = await db.transaction((client) => insertGateAgentDeployment(client, {
    ...input,
    requestedBy: principal.id
  }));
  if (["gate_not_found", "gate_not_bootstrapped", "release_not_found", "deployment_active"].includes(result)) {
    return result as "gate_not_found" | "gate_not_bootstrapped" | "release_not_found" | "deployment_active";
  }
  const deployment = await readGateAgentDeployment(db, result);
  if (!deployment) throw new Error("created gate-agent deployment was not found");
  return deployment;
}

export async function requestGateAgentRollback(
  db: TransactionalQueryable,
  principal: Principal,
  input: { deploymentId: string; reason: string }
): Promise<GateAgentDeployment | "forbidden" | "not_found" | "no_previous_release" | "not_rollbackable"> {
  if (!canOperateCluster(principal)) return "forbidden";
  const result = await db.transaction((client) => requestDeploymentRollback(
    client,
    input.deploymentId,
    principal.id,
    input.reason
  ));
  if (result !== "queued") return result;
  const deployment = await readGateAgentDeployment(db, input.deploymentId);
  if (!deployment) return "not_found";
  return deployment;
}

export async function readGateAgentDeploymentHistory(
  db: Queryable,
  principal: Principal,
  gateId?: string
): Promise<GateAgentDeployment[] | "forbidden"> {
  if (!canOperateCluster(principal)) return "forbidden";
  return listGateAgentDeployments(db, gateId);
}

export async function readGateAgentReleases(
  db: Queryable,
  principal: Principal
): Promise<GateAgentRelease[] | "forbidden"> {
  if (!canOperateCluster(principal)) return "forbidden";
  return listGateAgentReleases(db);
}
