export function gateHeartbeatLeaseTtlSeconds(heartbeatIntervalSeconds = 10): number {
  return Math.max(30, heartbeatIntervalSeconds * 3);
}
