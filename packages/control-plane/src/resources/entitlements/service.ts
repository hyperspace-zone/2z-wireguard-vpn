export function addEntitlementSeconds(currentSeconds: number, addedSeconds: number): number {
  return Math.max(0, currentSeconds) + Math.max(0, addedSeconds);
}
