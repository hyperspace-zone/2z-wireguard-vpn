import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import {
  claimSolanaConfigPaymentProcessing,
  confirmSolanaConfigPayment,
  ensureCustodialSolanaWallet,
  ensureSolanaConfigPayment,
  failSolanaConfigPayment,
  readCustodialWalletEncryptedKey,
  readSolanaConfigPayment,
  recordSolanaConfigPaymentFeeEstimate,
  recordSolanaConfigPaymentSubmission,
  type SolanaConfigPaymentRow
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import { decryptJsonPayload } from "@hyperspace-zone/shared";

const memoProgram = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export type ConfigPaymentResult =
  | { status: "confirmed"; signature: string; feeLamports: bigint }
  | { status: "insufficient_funds"; availableLamports: bigint; requiredLamports: bigint }
  | { status: "treasury_unavailable"; availableLamports: bigint; requiredLamports: bigint }
  | { status: "in_progress" }
  | { status: "failed"; reason: string };

export interface SolanaConfigPaymentService {
  charge(input: { paymentId: string; accountId: string; sessionId: string }): Promise<ConfigPaymentResult>;
}

interface ConfigPaymentSignatureStatus {
  err: unknown;
  confirmationStatus?: string | null;
}

interface SignatureStatusReader {
  getSignatureStatuses(
    signatures: string[],
    config?: { searchTransactionHistory?: boolean }
  ): Promise<{ value: Array<ConfigPaymentSignatureStatus | null> }>;
}

export function createSolanaConfigPaymentService(input: {
  db: Database;
  rpcUrl: string;
  treasuryAddress: string;
  amountLamports: number;
  custodialEncryptionKey: Buffer;
}): SolanaConfigPaymentService {
  const connection = new Connection(input.rpcUrl, "confirmed");
  const treasury = new PublicKey(input.treasuryAddress);
  const amountLamports = BigInt(input.amountLamports);
  return {
    async charge(request) {
      await ensureCustodialSolanaWallet(input.db, request.accountId, input.custodialEncryptionKey);
      const keyRecord = await readCustodialWalletEncryptedKey(input.db, request.accountId);
      if (!keyRecord) return { status: "failed", reason: "custodial wallet key not found" };
      const payment = await ensureSolanaConfigPayment(input.db, {
        id: request.paymentId,
        accountId: request.accountId,
        sessionId: request.sessionId,
        sourceWalletAddress: keyRecord.wallet.publicKey,
        treasuryAddress: treasury.toBase58(),
        amountLamports
      });
      const recovered = await recoverSubmittedPayment(connection, input.db, payment);
      if (recovered) return recovered;
      if (!await claimSolanaConfigPaymentProcessing(input.db, request.paymentId)) {
        const current = await readSolanaConfigPayment(input.db, request.paymentId);
        if (current?.status === "confirmed" && current.transactionSignature) {
          return { status: "confirmed", signature: current.transactionSignature, feeLamports: BigInt(current.feeLamports ?? 0) };
        }
        return { status: "in_progress" };
      }

      const decrypted = decryptJsonPayload<{ seed: string; format: string }>(
        keyRecord.encryptedKey,
        input.custodialEncryptionKey
      );
      if (decrypted.format !== "ed25519-jwk-seed-v1") {
        await failSolanaConfigPayment(input.db, request.paymentId, "unsupported_wallet_key", "Unsupported custodial wallet key format");
        return { status: "failed", reason: "unsupported custodial wallet key format" };
      }
      const seed = Buffer.from(decrypted.seed, "base64url");
      try {
        const sourceWallet = Keypair.fromSeed(seed);
        if (sourceWallet.publicKey.toBase58() !== keyRecord.wallet.publicKey) {
          throw new Error("custodial wallet key does not match stored public key");
        }
        const [treasuryBalance, treasuryRentExemption] = await Promise.all([
          connection.getBalance(treasury, "finalized"),
          connection.getMinimumBalanceForRentExemption(0, "finalized")
        ]);
        if (!isSolanaTreasuryInitialized(BigInt(treasuryBalance), BigInt(treasuryRentExemption))) {
          await failSolanaConfigPayment(
            input.db,
            request.paymentId,
            "treasury_not_initialized",
            `Treasury has ${treasuryBalance} lamports; required ${treasuryRentExemption}`
          );
          return {
            status: "treasury_unavailable",
            availableLamports: BigInt(treasuryBalance),
            requiredLamports: BigInt(treasuryRentExemption)
          };
        }
        const blockhash = await connection.getLatestBlockhash("finalized");
        const transaction = new Transaction({
          feePayer: sourceWallet.publicKey,
          recentBlockhash: blockhash.blockhash
        }).add(
          SystemProgram.transfer({
            fromPubkey: sourceWallet.publicKey,
            toPubkey: treasury,
            lamports: input.amountLamports
          }),
          new TransactionInstruction({
            programId: memoProgram,
            keys: [],
            data: Buffer.from(`hyperspace-config:${request.paymentId}`, "utf8")
          })
        );
        const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
        if (fee.value === null) throw new Error("Solana RPC could not calculate the transaction fee");
        const feeLamports = BigInt(fee.value);
        await recordSolanaConfigPaymentFeeEstimate(input.db, request.paymentId, feeLamports);
        const availableLamports = BigInt(await connection.getBalance(sourceWallet.publicKey, "finalized"));
        const requiredLamports = requiredConfigPaymentLamports(amountLamports, feeLamports);
        if (availableLamports < requiredLamports) {
          await failSolanaConfigPayment(
            input.db,
            request.paymentId,
            "insufficient_funds",
            `Available ${availableLamports} lamports; required ${requiredLamports}`
          );
          return { status: "insufficient_funds", availableLamports, requiredLamports };
        }
        transaction.sign(sourceWallet);
        if (!transaction.signature) throw new Error("signed transaction has no signature");
        const signature = encodeBase58(transaction.signature);
        const rawTransaction = transaction.serialize();
        await recordSolanaConfigPaymentSubmission(input.db, {
          id: request.paymentId,
          signature,
          rawTransaction,
          recentBlockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
          feeLamports
        });
        const sentSignature = await connection.sendRawTransaction(rawTransaction, {
          preflightCommitment: "confirmed",
          maxRetries: 3
        });
        if (sentSignature !== signature) throw new Error("Solana RPC returned an unexpected transaction signature");
        const status = await waitForFinalizedSolanaConfigPayment(connection, signature);
        if (status?.err) {
          const reason = `Solana config payment failed: ${JSON.stringify(status.err)}`;
          await failSolanaConfigPayment(input.db, request.paymentId, "transaction_failed", reason);
          return { status: "failed", reason };
        }
        if (status?.confirmationStatus !== "finalized") return { status: "in_progress" };
        await confirmSolanaConfigPayment(input.db, request.paymentId);
        return { status: "confirmed", signature, feeLamports };
      } catch (error) {
        const current = await readSolanaConfigPayment(input.db, request.paymentId);
        const reason = error instanceof Error ? error.message : String(error);
        if (current?.status === "submitted" && isSolanaTransactionSimulationFailure(error)) {
          await failSolanaConfigPayment(input.db, request.paymentId, "transaction_simulation_failed", reason);
          return { status: "failed", reason };
        }
        if (current?.status !== "submitted") {
          await failSolanaConfigPayment(input.db, request.paymentId, "payment_error", reason);
          return { status: "failed", reason };
        }
        throw error;
      } finally {
        seed.fill(0);
      }
    }
  };
}

export function requiredConfigPaymentLamports(amountLamports: bigint, feeLamports: bigint): bigint {
  if (amountLamports <= 0n || feeLamports < 0n) {
    throw new Error("invalid SOL config payment amount or fee");
  }
  return amountLamports + feeLamports;
}

export function isSolanaTreasuryInitialized(balanceLamports: bigint, rentExemptionLamports: bigint): boolean {
  return balanceLamports >= rentExemptionLamports;
}

async function recoverSubmittedPayment(
  connection: Connection,
  db: Database,
  payment: SolanaConfigPaymentRow
): Promise<ConfigPaymentResult | null> {
  if (payment.status === "confirmed" && payment.transactionSignature) {
    return { status: "confirmed", signature: payment.transactionSignature, feeLamports: BigInt(payment.feeLamports ?? 0) };
  }
  if (payment.status !== "submitted" || !payment.transactionSignature) return null;
  const status = await readSolanaConfigPaymentSignatureStatus(connection, payment.transactionSignature);
  if (status?.err) {
    const reason = `Solana config payment failed: ${JSON.stringify(status.err)}`;
    await failSolanaConfigPayment(db, payment.id, "transaction_failed", reason);
    return { status: "failed", reason };
  }
  if (status?.confirmationStatus === "finalized") {
    await confirmSolanaConfigPayment(db, payment.id);
    return { status: "confirmed", signature: payment.transactionSignature, feeLamports: BigInt(payment.feeLamports ?? 0) };
  }
  if (payment.rawTransaction && payment.lastValidBlockHeight) {
    const blockHeight = await connection.getBlockHeight("confirmed");
    if (blockHeight <= Number(payment.lastValidBlockHeight)) {
      await connection.sendRawTransaction(payment.rawTransaction, { preflightCommitment: "confirmed", maxRetries: 3 });
      return { status: "in_progress" };
    }
  }
  // This RPC has no archival history. Keep an unknown submitted payment in
  // manual-review state instead of risking a second charge for the same config.
  return { status: "in_progress" };
}

export async function readSolanaConfigPaymentSignatureStatus(
  connection: SignatureStatusReader,
  signature: string
): Promise<ConfigPaymentSignatureStatus | null> {
  const recent = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
  if (recent.value[0]) return recent.value[0];
  try {
    const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    return response.value[0] ?? null;
  } catch (error) {
    if (!isTransactionHistoryUnavailable(error)) throw error;
    return null;
  }
}

export async function waitForFinalizedSolanaConfigPayment(
  connection: SignatureStatusReader,
  signature: string,
  options: {
    maxAttempts?: number;
    pollIntervalMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<ConfigPaymentSignatureStatus | null> {
  const maxAttempts = options.maxAttempts ?? 20;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  let latest: ConfigPaymentSignatureStatus | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
    latest = response.value[0] ?? null;
    if (latest?.err || latest?.confirmationStatus === "finalized") return latest;
    if (attempt + 1 < maxAttempts) await sleep(pollIntervalMs);
  }
  return latest;
}

export function isSolanaTransactionSimulationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown; transactionLogs?: unknown };
  return candidate.name === "SendTransactionError"
    || Array.isArray(candidate.transactionLogs)
    || (typeof candidate.message === "string" && candidate.message.includes("Transaction simulation failed"));
}

function isTransactionHistoryUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === -32011
    || (typeof candidate.message === "string" && candidate.message.includes("Transaction history is not available"));
}

function encodeBase58(value: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
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
    if (byte !== 0) break;
    prefix += "1";
  }
  return prefix + digits.reverse().map((digit) => alphabet[digit]).join("");
}
