export interface GatePreparePlanInput {
  publicMaterial: Record<string, unknown>;
  routingModel: Record<string, unknown>;
  firewallModel: Record<string, unknown>;
}

export interface AssignmentNetworkMaterialInput {
  id: string;
  role: "Ingress" | "Egress";
  externalHandle: string;
  gateName: string;
  publicEndpoint: string;
  localMaterial: Record<string, unknown>;
}

export function toGatePreparePlan(planId: string, plan: GatePreparePlanInput): Record<string, unknown> {
  return {
    planId,
    publicMaterial: plan.publicMaterial,
    routingModel: plan.routingModel,
    firewallModel: plan.firewallModel
  };
}

export function assignmentNetworkMaterial(input: AssignmentNetworkMaterialInput): Record<string, unknown> {
  return {
    assignmentId: input.id,
    role: input.role,
    handle: input.externalHandle,
    gateName: input.gateName,
    publicEndpoint: input.publicEndpoint,
    localMaterial: input.localMaterial
  };
}
