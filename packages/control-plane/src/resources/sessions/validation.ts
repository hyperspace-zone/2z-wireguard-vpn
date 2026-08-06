import type { SessionMode } from "@hyperspace-zone/contracts";

export interface SessionCreateParsed {
  mode: SessionMode;
  destinationCidrs: string[];
  createRequestId?: string;
  sourceCidr?: string;
  clientPublicKey?: string;
  label?: string;
  spec: Record<string, unknown>;
}

const wireGuardCanonicalBase64Pattern = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

export function parseSessionCreateBody(body: Record<string, unknown>): SessionCreateParsed | { error: string; message?: string } {
  const mode = readString(body, "mode");
  if (mode !== "IpToIp" && mode !== "FullTunnel") {
    return { error: "invalid_mode" };
  }

  const destinationCidrs = normalizeDestinationCidrs(body, mode);
  if (destinationCidrs.length === 0) {
    return { error: "destination_required" };
  }

  const sourceCidr = normalizeOptionalCidr(readString(body, "sourceCidr") || ipToCidr(readString(body, "sourceIp")));
  const clientPublicKey = readString(body, "clientPublicKey") || undefined;
  const label = readString(body, "label") || undefined;
  const createRequestId = readString(body, "paymentRequestId") || readString(body, "requestId") || undefined;
  const ingressGateName = readString(body, "ingressGateName") || undefined;
  const egressGateName = readString(body, "egressGateName") || undefined;
  const ingressGateId = readString(body, "ingressGateId") || undefined;
  const egressGateId = readString(body, "egressGateId") || undefined;

  if (!ingressGateName && !ingressGateId) {
    return { error: "ingress_gate_required" };
  }
  if (!egressGateName && !egressGateId) {
    return { error: "egress_gate_required" };
  }
  if ((ingressGateName && ingressGateName === egressGateName) || (ingressGateId && ingressGateId === egressGateId)) {
    return { error: "distinct_gates_required", message: "Ingress and egress must be different gates." };
  }
  if (clientPublicKey && !isWireGuardPublicKey(clientPublicKey)) {
    return { error: "invalid_client_public_key", message: "Client public key must be a canonical 44-character WireGuard public key." };
  }
  if (createRequestId && !isUuid(createRequestId)) {
    return { error: "invalid_create_request_id", message: "Config creation request ID must be a UUID." };
  }

  const spec = {
    desiredState: "Active",
    mode,
    destinationCidrs,
    ...(sourceCidr ? { sourceCidr } : {}),
    ...(clientPublicKey ? { clientPublicKey } : {}),
    ...(ingressGateName ? { ingressGateName } : {}),
    ...(egressGateName ? { egressGateName } : {}),
    ...(ingressGateId ? { ingressGateId } : {}),
    ...(egressGateId ? { egressGateId } : {}),
    pathPolicy: asRecord(body.pathPolicy ?? {}),
    artifactPolicy: asRecord(body.artifactPolicy ?? {})
  };

  return {
    mode,
    destinationCidrs,
    ...(createRequestId ? { createRequestId } : {}),
    ...(sourceCidr ? { sourceCidr } : {}),
    ...(clientPublicKey ? { clientPublicKey } : {}),
    ...(label ? { label } : {}),
    spec
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeDestinationCidrs(body: Record<string, unknown>, mode: SessionMode): string[] {
  const rawCidrs = readStringArray(body, "destinationCidrs");
  const targetIp = readString(body, "targetIp");
  if (rawCidrs.length > 0) {
    return rawCidrs.map(normalizeRequiredCidr).filter(Boolean);
  }
  if (mode === "IpToIp" && targetIp) {
    return [ipToCidr(targetIp)];
  }
  if (mode === "FullTunnel") {
    return ["0.0.0.0/0"];
  }
  return [];
}

function normalizeRequiredCidr(value: string): string {
  return value.includes("/") ? value : `${value}/32`;
}

function normalizeOptionalCidr(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return normalizeRequiredCidr(value);
}

function ipToCidr(value: string): string {
  if (!value) {
    return "";
  }
  return value.includes("/") ? value : `${value}/32`;
}

function isWireGuardPublicKey(value: string): boolean {
  const trimmed = value.trim();
  if (!wireGuardCanonicalBase64Pattern.test(trimmed)) {
    return false;
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    return decoded.length === 32 && !decoded.every((byte) => byte === 0);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}
