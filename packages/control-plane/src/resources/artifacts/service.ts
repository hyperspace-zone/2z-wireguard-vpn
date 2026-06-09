import {
  decryptJsonPayload,
  encryptJsonPayload
} from "@hyperspace-zone/shared";
import type { Queryable } from "../../db/queryable.js";
import { renderClientConfig } from "./client-config.js";
import {
  attachArtifactToSessionStatus,
  invalidateArtifactsForSession,
  insertClientConfigArtifact,
  insertClientConfigArtifactPayload,
  listAssignmentMaterialsForArtifact,
  selectRenderedPlanForArtifact,
  selectRenderedPlanSecret
} from "./repository.js";
import { artifactInvalidatedTransition, preparedArtifactTransition } from "./transitions.js";

export async function prepareClientConfigArtifact(
  db: Queryable,
  sessionId: string,
  generation: number,
  artifactEncryptionKey: Buffer
): Promise<void> {
  const plan = await selectRenderedPlanForArtifact(db, sessionId, generation);
  if (!plan) {
    throw new Error(`missing rendered plan for session ${sessionId}`);
  }

  const assignments = await listAssignmentMaterialsForArtifact(db, sessionId);
  const ingress = assignments.find((assignment) => assignment.role === "Ingress");
  const egress = assignments.find((assignment) => assignment.role === "Egress");
  if (!ingress || !egress) {
    throw new Error(`missing applied assignment material for session ${sessionId}`);
  }

  const publicMaterial = asRecord(plan.publicMaterial);
  const destinationCidrs = readStringList(publicMaterial, "destinationCidrs");
  const clientAddress = readRequiredString(publicMaterial, "clientAddress");
  const mode = readRequiredString(publicMaterial, "mode");
  const clientKeyMode = readRequiredString(publicMaterial, "clientKeyMode");
  const clientPublicKey = readRequiredString(publicMaterial, "clientPublicKey");
  const ingressMaterial = asRecord(ingress.localMaterial);
  const ingressWireGuard = asRecord(ingressMaterial.wireGuard);
  const serverPublicKey = readRequiredString(ingressWireGuard, "clientPublicKey");
  const listenPort = readRequiredNumber(ingressWireGuard, "clientListenPort");

  const planSecret = await selectRenderedPlanSecret(db, String(plan.id));
  const secretPayload = planSecret
    ? decryptJsonPayload<Record<string, unknown>>(planSecret, artifactEncryptionKey)
    : {};
  const clientPrivateKey = typeof secretPayload.clientPrivateKey === "string"
    ? secretPayload.clientPrivateKey
    : "<client-private-key>";

  const fileName = `hyperspace-${sessionId.slice(0, 8)}.conf`;
  const configText = renderClientConfig({
    privateKey: clientPrivateKey,
    clientPublicKey,
    clientKeyMode,
    address: clientAddress,
    serverPublicKey,
    endpoint: `${String(ingress.publicEndpoint)}:${listenPort}`,
    allowedIps: destinationCidrs,
    persistentKeepaliveSeconds: 25
  });
  const encryptedArtifact = encryptJsonPayload(
    {
      fileName,
      configText,
      mode,
      clientKeyMode,
      clientAddress,
      destinationCidrs,
      ingressGateName: String(ingress.gateName),
      egressGateName: String(egress.gateName)
    },
    artifactEncryptionKey,
    `artifact:${sessionId}:${generation}`
  );

  const artifactId = await insertClientConfigArtifact(db, {
    sessionId,
    publicPayload: {
      status: "prepared",
      fileName,
      mode,
      clientKeyMode,
      clientAddress,
      destinationCidrs,
      ingressGateName: String(ingress.gateName),
      egressGateName: String(egress.gateName)
    },
    keyFingerprints: [serverPublicKey],
    encryptedArtifact,
    initialPhase: preparedArtifactTransition()
  });
  await insertClientConfigArtifactPayload(db, artifactId, encryptedArtifact);
  await attachArtifactToSessionStatus(db, sessionId, artifactId);
}

export async function invalidateSessionArtifacts(db: Queryable, sessionId: string): Promise<void> {
  await invalidateArtifactsForSession(db, {
    sessionId,
    invalidatedPhase: artifactInvalidatedTransition()
  });
}

function readOptionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);
  if (!value) {
    throw new Error(`missing required string ${key}`);
  }
  return value;
}

function readRequiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`missing required number ${key}`);
  }
  return value;
}

function readStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
