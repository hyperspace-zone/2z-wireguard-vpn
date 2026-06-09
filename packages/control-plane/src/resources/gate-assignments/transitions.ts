export function isTerminalAssignmentPhase(phase: string): boolean {
  return phase === "applied" || phase === "revoked" || phase === "dead";
}
