export type PrincipalKind = "user" | "gate" | "admin" | "agent" | "system";

export interface Principal {
  kind: PrincipalKind;
  id: string;
  accountId?: string;
}

export function systemPrincipal(): Principal {
  return { kind: "system", id: "system" };
}
