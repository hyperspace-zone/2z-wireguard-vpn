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
  | "revoking"
  | "revoked"
  | "failed";

export type GateRole = "Ingress" | "Egress";
export type GateDesiredState = "Enabled" | "Draining" | "Disabled" | "Maintenance";
export type GateAssignmentDesiredState = "Applied" | "Revoked";
export type GateAssignmentPhase =
  | "planned"
  | "queued"
  | "leased"
  | "applying"
  | "prepared"
  | "applied"
  | "drifted"
  | "revoking"
  | "revoked"
  | "retryable_failed"
  | "dead";
export type JobType =
  | "probe"
  | "apply_assignment"
  | "revoke_assignment"
  | "cleanup_orphan"
  | "reconcile";

export interface SessionSpec {
  desiredState: DesiredSessionState;
  mode: SessionMode;
  destinationCidrs: string[];
  sourceCidr?: string;
  ingressGateId?: string;
  egressGateId?: string;
  ingressGateName?: string;
  egressGateName?: string;
  clientPublicKey?: string;
  pathPolicy?: Record<string, unknown>;
  artifactPolicy?: Record<string, unknown>;
}

export interface PublicUser {
  id: string;
  accountId: string;
  email: string;
  displayName: string;
}

export interface SessionSummary {
  id: string;
  mode: SessionMode;
  desiredState: DesiredSessionState;
  phase: SessionPhase;
  label?: string;
  destinationCidrs: string[];
  sourceCidr?: string;
  selectedPath?: Record<string, unknown>;
  lastError?: {
    code?: string;
    message?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface GateSummary {
  id: string;
  name: string;
  desiredState: GateDesiredState;
  region: string;
  city?: string;
  country?: string;
  countryCode?: string;
  publicEndpoint: string;
  probeUrl?: string;
  lastSeenAt?: string;
  doubleZero?: GateDoubleZeroStatus;
  ready: boolean;
  schedulable: boolean;
}

export interface GateDoubleZeroStatus {
  tunnelStatus?: string;
  lastSessionUpdate?: string;
  tunnelName?: string;
  tunnelSrc?: string;
  tunnelDst?: string;
  doubleZeroIp?: string;
  userType?: string;
  reconciler?: string;
  tenant?: string;
  currentDevice?: string;
  lowestLatencyDevice?: string;
  lowestLatencyDeviceWarning?: boolean;
  metro?: string;
  network?: string;
  reportedAt?: string;
  error?: string;
  raw?: string;
}

export interface GateAgentHeartbeat {
  gateId: string;
  agentVersion: string;
  bootId: string;
  observedEndpoint: string;
  doubleZero?: GateDoubleZeroStatus;
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

export * from "./api/admin.js";
export * from "./api/agent.js";
export * from "./api/gate.js";
export * from "./api/public.js";
export * from "./resources/actual-state.js";
export * from "./resources/artifact.js";
export * from "./resources/condition.js";
export * from "./resources/entitlement.js";
export * from "./resources/gate-assignment.js";
export * from "./resources/gate-lease.js";
export * from "./resources/gate.js";
export * from "./resources/job.js";
export * from "./resources/payment.js";
export * from "./resources/probe.js";
export * from "./resources/rendered-plan.js";
export * from "./resources/session.js";
export * from "./schemas/admin.schema.js";
export * from "./schemas/agent.schema.js";
export * from "./schemas/gate.schema.js";
export * from "./schemas/public.schema.js";
