import type { Queryable } from "../db/queryable.js";
import { selectSchedulableGate } from "../resources/gates/repository.js";

export interface PathChoice {
  ingressGateId: string;
  ingressGateName: string;
  ingressPublicEndpoint: string;
  egressGateId: string;
  egressGateName: string;
  egressPublicEndpoint: string;
}

export async function choosePath(client: Queryable, spec: Record<string, unknown>): Promise<PathChoice | null> {
  const ingressGateId = readOptionalString(spec, "ingressGateId");
  const egressGateId = readOptionalString(spec, "egressGateId");
  const ingressGateName = readOptionalString(spec, "ingressGateName");
  const egressGateName = readOptionalString(spec, "egressGateName");
  const ingress = await selectSchedulableGate(client, {
    gateId: ingressGateId,
    gateName: ingressGateName
  });
  if (!ingress) {
    return null;
  }

  const egress = await selectSchedulableGate(client, {
    excludeGateId: ingress.id,
    gateId: egressGateId,
    gateName: egressGateName
  });
  if (!egress) {
    return null;
  }

  return {
    ingressGateId: ingress.id,
    ingressGateName: ingress.name,
    ingressPublicEndpoint: ingress.publicEndpoint,
    egressGateId: egress.id,
    egressGateName: egress.name,
    egressPublicEndpoint: egress.publicEndpoint
  };
}

function readOptionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}
