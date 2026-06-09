import type { Queryable } from "../../db/queryable.js";
import type { Principal } from "../../authz/principals.js";
import { setGateDesiredState } from "./set-gate-desired-state.scenario.js";

export async function drainGate(
  db: Queryable,
  principal: Principal,
  gateId: string
): Promise<"draining" | "forbidden" | "not_found"> {
  const result = await setGateDesiredState(db, principal, {
    gateId,
    desiredState: "Draining"
  });
  if (result === "forbidden" || result === "not_found") {
    return result;
  }
  return "draining";
}
