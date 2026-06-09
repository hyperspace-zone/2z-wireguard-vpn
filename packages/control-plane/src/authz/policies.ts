import type { Principal } from "./principals.js";

export function canManageOwnSession(principal: Principal, accountId: string): boolean {
  return principal.kind === "user" && principal.accountId === accountId;
}

export function canOperateCluster(principal: Principal): boolean {
  return principal.kind === "admin" || principal.kind === "system";
}

export function canClaimGateJob(principal: Principal, gateId: string): boolean {
  return principal.kind === "gate" && principal.id === gateId;
}
