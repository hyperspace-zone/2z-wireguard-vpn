import { decryptJsonPayload } from "@hyperspace-zone/shared";
import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  claimCashSweepRequest,
  listSubmittedCashSweeps,
  markCashSweepConfirmed,
  markCashSweepFailed,
  markCashSweepSubmitted,
  type CashSweepRequestRow
} from "../../resources/billing/prepaid-repository.js";
import { readCustodialWalletEncryptedKey } from "../../resources/wallets/repository.js";

export interface CashSweepSigningJob {
  sweep: CashSweepRequestRow;
  sourceWalletAddress: string;
  sourceWalletSeed: Uint8Array;
}

export async function claimCashSweepSigningJob(
  db: TransactionalQueryable,
  encryptionKey: Buffer
): Promise<CashSweepSigningJob | null> {
  return db.transaction(async (client) => {
    const sweep = await claimCashSweepRequest(client);
    if (!sweep) return null;
    const keyRecord = await readCustodialWalletEncryptedKey(client, sweep.accountId);
    if (!keyRecord) {
      await markCashSweepFailed(client, sweep.id, "custodial wallet key not found");
      return null;
    }
    const decrypted = decryptJsonPayload<{ seed: string; format: string }>(keyRecord.encryptedKey, encryptionKey);
    if (decrypted.format !== "ed25519-jwk-seed-v1") {
      await markCashSweepFailed(client, sweep.id, "unsupported custodial wallet key format");
      return null;
    }
    return {
      sweep,
      sourceWalletAddress: keyRecord.wallet.publicKey,
      sourceWalletSeed: Buffer.from(decrypted.seed, "base64url")
    };
  });
}

export async function recordCashSweepSubmission(
  db: TransactionalQueryable,
  sweepId: string,
  transactionSignature: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await markCashSweepSubmitted(db, sweepId, transactionSignature, metadata);
}

export async function failCashSweep(db: TransactionalQueryable, sweepId: string, error: string): Promise<void> {
  await markCashSweepFailed(db, sweepId, error);
}

export async function listCashSweepConfirmations(db: TransactionalQueryable): Promise<CashSweepRequestRow[]> {
  return listSubmittedCashSweeps(db);
}

export async function confirmCashSweep(db: TransactionalQueryable, sweepId: string): Promise<void> {
  await markCashSweepConfirmed(db, sweepId);
}
