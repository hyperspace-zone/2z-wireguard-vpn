export function isGateLeaseFresh(leaseExpiresAt: Date, now = new Date()): boolean {
  return leaseExpiresAt.getTime() > now.getTime();
}
