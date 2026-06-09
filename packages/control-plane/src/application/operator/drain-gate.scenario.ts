import type { Queryable } from "../../db/queryable.js";
import { canOperateCluster } from "../../authz/policies.js";
import type { Principal } from "../../authz/principals.js";
import { updateGateDesiredState } from "../../resources/gates/repository.js";

export async function drainGate(
  db: Queryable,
  principal: Principal,
  gateId: string
): Promise<"draining" | "forbidden" | "not_found"> {
  if (!canOperateCluster(principal)) {
    return "forbidden";
  }
  const updated = await updateGateDesiredState(db, {
    gateId,
    desiredState: "Draining",
    actorId: principal.id
  });
  return updated ? "draining" : "not_found";
}
