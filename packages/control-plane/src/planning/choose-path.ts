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
  const excludedCities = readPathPolicyValues(spec, ["excludeCities", "excludedCities", "avoidCities"]);
  const preferredRegions = readPreferredRegions(spec);
  const ingress = await selectSchedulableGate(client, {
    gateId: ingressGateId,
    gateName: ingressGateName,
    excludedCountries,
    excludedCities
  });
  if (!ingress) {
    return null;
  }

  const egress = await selectSchedulableGate(client, {
    excludeGateId: ingress.id,
    gateId: egressGateId,
    gateName: egressGateName,
    excludedCountries,
    excludedCities,
    preferredRegions
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
  const values = readPathPolicyValues(spec, ["excludeCountries", "excludedCountries", "avoidCountries"]);
  return [...new Set(values.map(normalizeCountry).filter(Boolean))];
}

function readPreferredRegions(spec: Record<string, unknown>): string[] {
  return [...new Set(readPathPolicyValues(spec, ["preferredRegions", "egressRegions"])
    .flatMap(normalizeRegion)
    .filter(Boolean))];
}

function readPathPolicyValues(spec: Record<string, unknown>, keys: string[]): string[] {
  const policy = spec.pathPolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return [];
  }
  const record = policy as Record<string, unknown>;
  return keys.flatMap((key) => readStringArray(record[key])).map((value) => value.toLowerCase());
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

function normalizeRegion(value: string): string[] {
  switch (value.trim().toLowerCase()) {
    case "eu":
    case "europe":
      return ["eu"];
    case "na":
    case "north america":
    case "us":
      return ["na"];
    case "ap":
    case "apac":
    case "asia pacific":
      return ["ap"];
    case "sa":
    case "latam":
    case "south america":
      return ["sa"];
    case "emea":
      return ["eu", "me", "af"];
    default:
      return [];
  }
}
