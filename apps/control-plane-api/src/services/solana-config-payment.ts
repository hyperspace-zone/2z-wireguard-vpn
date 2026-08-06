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
  | { status: "in_progress" }
  | { status: "failed"; reason: string };

export interface SolanaConfigPaymentService {
  charge(input: { paymentId: string; accountId: string; sessionId: string }): Promise<ConfigPaymentResult>;
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
        const confirmation = await connection.confirmTransaction({
          signature,
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight
        }, "finalized");
        if (confirmation.value.err) {
          const reason = `Solana config payment failed: ${JSON.stringify(confirmation.value.err)}`;
          await failSolanaConfigPayment(input.db, request.paymentId, "transaction_failed", reason);
          return { status: "failed", reason };
        }
        await confirmSolanaConfigPayment(input.db, request.paymentId);
        return { status: "confirmed", signature, feeLamports };
      } catch (error) {
        const current = await readSolanaConfigPayment(input.db, request.paymentId);
        if (current?.status !== "submitted") {
          const reason = error instanceof Error ? error.message : String(error);
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

async function recoverSubmittedPayment(
  connection: Connection,
  db: Database,
  payment: SolanaConfigPaymentRow
): Promise<ConfigPaymentResult | null> {
  if (payment.status === "confirmed" && payment.transactionSignature) {
    return { status: "confirmed", signature: payment.transactionSignature, feeLamports: BigInt(payment.feeLamports ?? 0) };
  }
  if (payment.status !== "submitted" || !payment.transactionSignature) return null;
  const response = await connection.getSignatureStatuses([payment.transactionSignature], { searchTransactionHistory: true });
  const status = response.value[0];
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
  await failSolanaConfigPayment(db, payment.id, "blockhash_expired", "Config payment blockhash expired before finalization");
  return null;
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
