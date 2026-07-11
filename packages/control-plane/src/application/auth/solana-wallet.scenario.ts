import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  consumeWalletLinkChallenge,
  findActiveWalletLinkOwner,
  findLatestWalletLinkChallengeForUpdate,
  insertWalletLink,
  insertWalletLinkChallenge,
  listWalletLinks,
  upsertIdentity,
  type PublicUser,
  type WalletLinkRow
} from "../../resources/users/repository.js";
import { newSecretToken } from "../../security/tokens.js";
import type { PublicSolanaWallet } from "./custodial-wallet.scenario.js";
import { hmacSha256Hex, verifyHash } from "./otp.js";

export interface WalletChallengeResult {
  chain: "solana";
  publicKey: string;
  nonce: string;
  message: string;
  expiresAt: string;
}

export type WalletLinkResult =
  | { status: "linked"; wallet: PublicSolanaWallet }
  | "invalid_public_key"
  | "invalid_signature"
  | "wallet_already_linked"
  | "challenge_not_found"
  | "challenge_expired";

export async function createSolanaWalletChallenge(
  db: TransactionalQueryable,
  user: PublicUser,
  input: {
    publicKey: string;
    nonceHashSecret: string;
    challengeTtlSeconds: number;
  }
): Promise<WalletChallengeResult | "invalid_public_key"> {
  const publicKey = normalizeSolanaPublicKey(input.publicKey);
  if (!publicKey) {
    return "invalid_public_key";
  }

  const nonce = newSecretToken(18);
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + input.challengeTtlSeconds * 1000).toISOString();
  const message = solanaWalletLinkMessage({
    accountId: user.accountId,
    userId: user.id,
    publicKey,
    nonce,
    issuedAt
  });
  await insertWalletLinkChallenge(db, {
    accountId: user.accountId,
    userId: user.id,
    chain: "solana",
    publicKey,
    nonceHash: hmacSha256Hex(input.nonceHashSecret, nonce),
    message,
    expiresAt,
    metadata: { issuedAt }
  });
  return { chain: "solana", publicKey, nonce, message, expiresAt };
}

export async function linkSolanaWallet(
  db: TransactionalQueryable,
  user: PublicUser,
  input: {
    publicKey: string;
    signature: string;
    nonce: string;
    nonceHashSecret: string;
  }
): Promise<WalletLinkResult> {
  const publicKey = normalizeSolanaPublicKey(input.publicKey);
  if (!publicKey) {
    return "invalid_public_key";
  }
  return db.transaction(async (client) => {
    const challenge = await findLatestWalletLinkChallengeForUpdate(client, {
      accountId: user.accountId,
      chain: "solana",
      publicKey
    });
    if (!challenge) {
      return "challenge_not_found";
    }
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      return "challenge_expired";
    }
    if (!verifyHash(hmacSha256Hex(input.nonceHashSecret, input.nonce), challenge.nonceHash)) {
      return "invalid_signature";
    }
    if (!verifySolanaSignature(publicKey, challenge.message, input.signature)) {
      return "invalid_signature";
    }
    const existingOwner = await findActiveWalletLinkOwner(client, "solana", publicKey);
    if (existingOwner && existingOwner !== user.accountId) {
      return "wallet_already_linked";
    }

    await consumeWalletLinkChallenge(client, challenge.id);
    const wallet = await insertWalletLink(client, {
      accountId: user.accountId,
      userId: user.id,
      chain: "solana",
      publicKey,
      metadata: { linkedBy: "self-service" }
    });
    await upsertIdentity(client, {
      accountId: user.accountId,
      provider: "wallet:solana",
      providerSubject: publicKey,
      metadata: { publicKey },
      verifiedAt: new Date().toISOString()
    });
    return { status: "linked", wallet: toExternalWallet(wallet) };
  });
}

export async function listSolanaWalletLinks(
  db: TransactionalQueryable,
  accountId: string
): Promise<PublicSolanaWallet[]> {
  return (await listWalletLinks(db, accountId)).map(toExternalWallet);
}

function toExternalWallet(wallet: WalletLinkRow): PublicSolanaWallet {
  return {
    ...wallet,
    chain: "solana",
    custody: "external",
    canReceive: true
  };
}

export function solanaWalletLinkMessage(input: {
  accountId: string;
  userId: string;
  publicKey: string;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    "Link this Solana wallet to your Hyperspace account.",
    `Account ID: ${input.accountId}`,
    `User ID: ${input.userId}`,
    `Public Key: ${input.publicKey}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`
  ].join("\n");
}

export function normalizeSolanaPublicKey(value: string): string {
  const publicKey = value.trim();
  const bytes = decodeBase58(publicKey);
  if (!bytes || bytes.length !== 32 || bytes.every((byte) => byte === 0)) {
    return "";
  }
  return publicKey;
}

export function verifySolanaSignature(publicKey: string, message: string, signature: string): boolean {
  const publicKeyBytes = decodeBase58(publicKey);
  const signatureBytes = decodeFlexibleSignature(signature);
  if (!publicKeyBytes || publicKeyBytes.length !== 32 || !signatureBytes || signatureBytes.length !== 64) {
    return false;
  }
  const keyObject = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(publicKeyBytes).toString("base64url")
    },
    format: "jwk"
  });
  return verifySignature(null, Buffer.from(message, "utf8"), keyObject, signatureBytes);
}

function decodeFlexibleSignature(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const base64 = Buffer.from(trimmed, "base64");
    if (base64.length === 64) {
      return base64;
    }
  } catch {
    // fall through to base58
  }
  const base58 = decodeBase58(trimmed);
  return base58 ? Buffer.from(base58) : null;
}

function decodeBase58(value: string): Uint8Array | null {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const char of value) {
    const valueIndex = alphabet.indexOf(char);
    if (valueIndex < 0) {
      return null;
    }
    let carry = valueIndex;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = (bytes[index] ?? 0) * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== "1") {
      break;
    }
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}
