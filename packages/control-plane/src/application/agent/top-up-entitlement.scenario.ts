import type { AgentSurfaceDisabledResult } from "./create-prepaid-session.scenario.js";

export async function topUpEntitlement(): Promise<AgentSurfaceDisabledResult> {
  return {
    status: "disabled",
    error: "agent_surface_disabled",
    message: "Agent entitlement top-up requires an agent authentication contract before this surface can be enabled."
  };
}
