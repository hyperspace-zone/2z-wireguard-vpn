export type SessionDesiredState = "Active" | "Revoked";

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

export interface SessionLifecycleTransition {
  phase: SessionPhase;
  observedGeneration?: number;
  lastError?: Record<string, unknown> | null;
}

export function isTerminalSessionPhase(phase: string): boolean {
  return phase === "active" || phase === "revoked" || phase === "failed";
}

export function canRequestRevocation(phase: string): boolean {
  return phase !== "revoking" && phase !== "revoked" && phase !== "failed";
}

export function requestedSessionInitialTransition(): SessionLifecycleTransition {
  return { phase: "requested" };
}

export function probingTransition(): SessionLifecycleTransition {
  return { phase: "probing" };
}

export function schedulingTransition(): SessionLifecycleTransition {
  return { phase: "scheduling" };
}

export function requestRevocationTransition(currentPhase: SessionPhase): {
  desiredState: SessionDesiredState;
  incrementGeneration: boolean;
  statusTransition: SessionLifecycleTransition;
} {
  return {
    desiredState: "Revoked",
    incrementGeneration: true,
    statusTransition: {
      phase: currentPhase === "revoked" ? "revoked" : "revoking"
    }
  };
}

export function provisioningTransition(
  generation: number,
  _selectedPath: Record<string, unknown>
): SessionLifecycleTransition {
  return {
    phase: "provisioning",
    observedGeneration: generation,
    lastError: null
  };
}

export function activeTransition(generation: number): SessionLifecycleTransition {
  return {
    phase: "active",
    observedGeneration: generation,
    lastError: null
  };
}

export function failedTransition(error: Record<string, unknown>): SessionLifecycleTransition {
  return {
    phase: "failed",
    lastError: error
  };
}

export function beginRevokingTransition(currentPhase: SessionPhase): SessionLifecycleTransition | null {
  if (currentPhase === "revoking" || currentPhase === "revoked" || currentPhase === "failed") {
    return null;
  }
  return { phase: "revoking" };
}

export function revokedTransition(generation: number): SessionLifecycleTransition {
  return {
    phase: "revoked",
    observedGeneration: generation,
    lastError: null
  };
}

export function canHideSession(phase: SessionPhase, hiddenAt: string | null): "deleted" | "not_revoked" | "can_hide" {
  if (hiddenAt) {
    return "deleted";
  }
  if (phase !== "revoked" && phase !== "failed") {
    return "not_revoked";
  }
  return "can_hide";
}
