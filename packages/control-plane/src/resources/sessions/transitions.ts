export function isTerminalSessionPhase(phase: string): boolean {
  return phase === "active" || phase === "revoked" || phase === "failed";
}

export function canRequestRevocation(phase: string): boolean {
  return phase !== "revoking" && phase !== "revoked" && phase !== "failed";
}
