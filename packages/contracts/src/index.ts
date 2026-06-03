export type ApiSurface = "public" | "agent" | "admin" | "gate";

export type SessionMode = "IpToIp" | "FullTunnel";
export type DesiredSessionState = "Active" | "Revoked";
export type SessionPhase =
  | "requested"
  | "probing"
  | "scheduling"
  | "provisioning"
  | "active"
  | "degraded"
  | "expired"
  | "revoking"
  | "revoked"
  | "failed";

export type GateRole = "Ingress" | "Egress";
export type GateDesiredState = "Enabled" | "Draining" | "Disabled" | "Maintenance";
export type GateAssignmentDesiredState = "Applied" | "Revoked";
export type JobType =
  | "probe"
  | "apply_assignment"
  | "revoke_assignment"
  | "cleanup_orphan"
  | "reconcile"
  | "expire_session";

export interface SessionSpec {
  desiredState: DesiredSessionState;
  mode: SessionMode;
  destinationCidrs: string[];
  ttlSeconds?: number;
  pathPolicy?: Record<string, unknown>;
  artifactPolicy?: Record<string, unknown>;
}

export interface GateAgentHeartbeat {
  gateId: string;
  agentVersion: string;
  bootId: string;
  observedEndpoint: string;
  capabilities: string[];
  reportedAt: string;
}

export interface GateActualSnapshot {
  gateId: string;
  bootId: string;
  agentVersion: string;
  managedHandles: string[];
  stateHash: string;
  reportedAt: string;
}

export const apiSurfaces: Record<ApiSurface, string> = {
  public: "/v1/public",
  agent: "/v1/agent",
  admin: "/v1/admin",
  gate: "/v1/gate"
};
