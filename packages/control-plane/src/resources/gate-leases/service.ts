export function isGateLeaseFresh(leaseExpiresAt: Date, now = new Date()): boolean {
  return leaseExpiresAt.getTime() > now.getTime();
}

export function gateHeartbeatLeaseTtlSeconds(heartbeatIntervalSeconds = 10): number {
  return Math.max(30, heartbeatIntervalSeconds * 3);
}
