export interface AgentSurfaceDisabledResult {
  status: "disabled";
  error: "agent_surface_disabled";
  message: string;
}

export async function createPrepaidSession(): Promise<AgentSurfaceDisabledResult> {
  return {
    status: "disabled",
    error: "agent_surface_disabled",
    message: "Agent-created prepaid sessions require an agent authentication contract before this surface can be enabled."
  };
}
