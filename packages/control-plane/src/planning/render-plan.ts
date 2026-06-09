import { createHash } from "node:crypto";
import {
  encryptJsonPayload,
  generateWireGuardKeyPair,
  type EncryptedJsonPayload
} from "@hyperspace-zone/shared";
import type { PathChoice } from "./choose-path.js";

export interface WireGuardRenderedPlan {
  planHash: string;
  publicMaterial: Record<string, unknown>;
  routingModel: Record<string, unknown>;
  firewallModel: Record<string, unknown>;
  secretRefs: Record<string, unknown>;
  secretPayload: EncryptedJsonPayload | null;
}

export function renderWireGuardPlan(
  session: {
    id: string;
    generation: number;
    mode: string;
    destinationCidrs: string[];
    sourceCidr: string | null;
    clientPublicKey: string | null;
  },
  path: PathChoice,
  clientAddress: string,
  artifactEncryptionKey: Buffer
): WireGuardRenderedPlan {
  const generatedClientKey = session.clientPublicKey ? null : generateWireGuardKeyPair();
  const clientPublicKey = session.clientPublicKey ?? generatedClientKey?.publicKey;
  if (!clientPublicKey) {
    throw new Error(`missing client public key for session ${session.id}`);
  }
  const model = {
    sessionId: session.id,
    generation: session.generation,
    mode: session.mode,
    destinationCidrs: session.destinationCidrs,
    sourceCidr: session.sourceCidr,
    clientAddress,
    clientPublicKey,
    clientKeyMode: generatedClientKey ? "ServerGenerated" : "BringYourOwnPublicKey",
    path
  };
  const secretPayload = generatedClientKey
    ? encryptJsonPayload(
        {
          clientPrivateKey: generatedClientKey.privateKey,
          clientPublicKey: generatedClientKey.publicKey
        },
        artifactEncryptionKey,
        `rendered-plan:${session.id}:${session.generation}`
      )
    : null;

  return {
    planHash: createHash("sha256").update(JSON.stringify(model)).digest("hex"),
    publicMaterial: {
      sessionId: session.id,
      generation: session.generation,
      mode: session.mode,
      destinationCidrs: session.destinationCidrs,
      clientAddress,
      clientPublicKey,
      clientKeyMode: generatedClientKey ? "ServerGenerated" : "BringYourOwnPublicKey",
      persistentKeepaliveSeconds: 25,
      mtu: 1420,
      path
    },
    routingModel: {
      transitInterface: "doublezero0",
      destinationCidrs: session.destinationCidrs,
      sourceCidr: session.sourceCidr,
      clientAddress,
      path
    },
    firewallModel: {
      mode: session.mode,
      sourceCidr: session.sourceCidr,
      destinationCidrs: session.destinationCidrs,
      clientAddress
    },
    secretRefs: generatedClientKey ? { clientPrivateKey: "rendered_plan_secrets" } : {},
    secretPayload
  };
}
