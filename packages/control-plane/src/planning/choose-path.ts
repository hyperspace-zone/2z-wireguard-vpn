import type { Queryable } from "../db/queryable.js";
import { selectSchedulableGate } from "../resources/gates/repository.js";

export interface PathChoice {
  ingressGateId: string;
  ingressGateName: string;
  ingressPublicIpv4: string;
  egressGateId: string;
  egressGateName: string;
  egressPublicIpv4: string;
}

export async function choosePath(client: Queryable, spec: Record<string, unknown>): Promise<PathChoice | null> {
  const ingressGateId = readOptionalString(spec, "ingressGateId");
  const egressGateId = readOptionalString(spec, "egressGateId");
  const ingressGateName = readOptionalString(spec, "ingressGateName");
  const egressGateName = readOptionalString(spec, "egressGateName");
  const excludedCountries = readExcludedCountries(spec);
  const ingress = await selectSchedulableGate(client, {
    gateId: ingressGateId,
    gateName: ingressGateName,
    excludedCountries
  });
  if (!ingress) {
    return null;
  }

  const egress = await selectSchedulableGate(client, {
    excludeGateId: ingress.id,
    gateId: egressGateId,
    gateName: egressGateName,
    excludedCountries
  });
  if (!egress) {
    return null;
  }

  return {
    ingressGateId: ingress.id,
    ingressGateName: ingress.name,
    ingressPublicIpv4: ingress.publicIpv4,
    egressGateId: egress.id,
    egressGateName: egress.name,
    egressPublicIpv4: egress.publicIpv4
  };
}

function readOptionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readExcludedCountries(spec: Record<string, unknown>): string[] {
  const policy = spec.pathPolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return [];
  }
  const record = policy as Record<string, unknown>;
  const values = [
    ...readStringArray(record.excludeCountries),
    ...readStringArray(record.excludedCountries),
    ...readStringArray(record.avoidCountries)
  ];
  return [...new Set(values.map(normalizeCountry).filter(Boolean))];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function normalizeCountry(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "de" || normalized === "deu" || normalized === "germany") {
    return "germany";
  }
  return normalized;
}
