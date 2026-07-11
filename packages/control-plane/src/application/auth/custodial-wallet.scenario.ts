import { generateKeyPairSync } from "node:crypto";
import { encryptJsonPayload } from "@hyperspace-zone/shared";
import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  findCustodialWallet,
  insertCustodialWallet,
  type CustodialWalletRow
} from "../../resources/wallets/repository.js";

export interface PublicSolanaWallet {
  id: string;
  chain: "solana";
  publicKey: string;
  label: string | null;
  linkedAt: string;
  custody: "hyperspace" | "external";
  canReceive: boolean;
}

export async function ensureCustodialSolanaWallet(
  db: TransactionalQueryable,
  accountId: string,
  encryptionKey: Buffer
): Promise<PublicSolanaWallet> {
  return db.transaction(async (client) => {
    const existing = await findCustodialWallet(client, accountId);
    if (existing) {
      return toPublicWallet(existing);
    }

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateJwk = privateKey.export({ format: "jwk" });
    const publicJwk = publicKey.export({ format: "jwk" });
    if (!privateJwk.d || !publicJwk.x) {
      throw new Error("generated Ed25519 keypair is missing JWK key material");
    }
    const publicKeyBase58 = encodeBase58(Buffer.from(publicJwk.x, "base64url"));
    const encryptedKey = encryptJsonPayload(
      { seed: privateJwk.d, format: "ed25519-jwk-seed-v1" },
      encryptionKey,
      `custodial-wallet:${accountId}:solana:${publicKeyBase58}`
    );
    const inserted = await insertCustodialWallet(client, {
      accountId,
      chain: "solana",
      publicKey: publicKeyBase58,
      encryptedKey,
      metadata: { createdBy: "account-onboarding", keyFormat: "ed25519-jwk-seed-v1" }
    });
    const wallet = inserted ?? await findCustodialWallet(client, accountId);
    if (!wallet) {
      throw new Error("custodial Solana wallet was not persisted");
    }
    return toPublicWallet(wallet);
  });
}

function toPublicWallet(wallet: CustodialWalletRow): PublicSolanaWallet {
  return {
    id: wallet.id,
    chain: "solana",
    publicKey: wallet.publicKey,
    label: "Hyperspace deposit wallet",
    linkedAt: wallet.createdAt,
    custody: "hyperspace",
    canReceive: true
  };
}

export function encodeBase58(value: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (value.length === 0) {
    return "";
  }
  const digits = [0];
  for (const byte of value) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = (digits[index] ?? 0) * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let prefix = "";
  for (const byte of value) {
    if (byte !== 0) {
      break;
    }
    prefix += "1";
  }
  return prefix + digits.reverse().map((digit) => alphabet[digit]).join("");
}
