import type { Queryable } from "../../db/queryable.js";
import { canOperateCluster } from "../../authz/policies.js";
import type { Principal } from "../../authz/principals.js";
import { updateGateDesiredState } from "../../resources/gates/repository.js";
import type { GateDesiredState } from "../../resources/gates/transitions.js";

export type GateDesiredStateCommandStatus = "enabled" | "draining" | "disabled" | "maintenance";

export async function setGateDesiredState(
  db: Queryable,
  principal: Principal,
  input: {
    gateId: string;
    desiredState: GateDesiredState;
  }
): Promise<GateDesiredStateCommandStatus | "forbidden" | "not_found"> {
  if (!canOperateCluster(principal)) {
    return "forbidden";
  }
  const updated = await updateGateDesiredState(db, {
    gateId: input.gateId,
    desiredState: input.desiredState,
    actorId: principal.id
  });
  if (!updated) {
    return "not_found";
  }
  return commandStatus(input.desiredState);
}

function commandStatus(desiredState: GateDesiredState): GateDesiredStateCommandStatus {
  switch (desiredState) {
    case "Enabled":
      return "enabled";
    case "Draining":
      return "draining";
    case "Disabled":
      return "disabled";
    case "Maintenance":
      return "maintenance";
  }
}
