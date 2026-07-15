import {
  claimWithdrawalSigningJob,
  confirmWithdrawal,
  failWithdrawalSubmission,
  listWithdrawalConfirmations,
  recordWithdrawalSubmission
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import type { ControlPlaneWorkerConfig } from "../config.js";

const memoProgram = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const associatedTokenProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export function createSolanaWithdrawalLoop(db: Database, config: ControlPlaneWorkerConfig): {
  due(): boolean;
  runOnce(): Promise<{ signed: number; confirmed: number; failed: number }>;
} {
  let nextRunAt = 0;
  const connection = config.solanaWithdrawals.enabled
    ? new Connection(config.billing.solanaRpcUrl, "confirmed")
    : null;
  return {
    due() {
      return Boolean(connection) && Date.now() >= nextRunAt;
    },
    async runOnce() {
      nextRunAt = Date.now() + Math.max(10, config.solanaWithdrawals.intervalSeconds) * 1000;
      const result = { signed: 0, confirmed: 0, failed: 0 };
      if (!connection || !config.solanaWithdrawals.custodialEncryptionKey || !config.solanaWithdrawals.feePayer) {
        return result;
      }

      const submitted = await listWithdrawalConfirmations(db);
      if (submitted.length > 0) {
        const statuses = await connection.getSignatureStatuses(
          submitted.map((withdrawal) => withdrawal.transactionSignature ?? ""),
          { searchTransactionHistory: true }
        );
        for (let index = 0; index < submitted.length; index += 1) {
          const withdrawal = submitted[index];
          const status = statuses.value[index];
          if (!withdrawal) continue;
          if (status?.err) {
            await failWithdrawalSubmission(db, withdrawal.id, `Solana transaction failed: ${JSON.stringify(status.err)}`);
            result.failed += 1;
          } else if (status?.confirmationStatus === "finalized") {
            await confirmWithdrawal(db, withdrawal);
            result.confirmed += 1;
          } else if (!status && withdrawal.submittedAt && Date.now() - Date.parse(withdrawal.submittedAt) > 10 * 60 * 1000) {
            await failWithdrawalSubmission(db, withdrawal.id, "Signed Solana transaction was not observed before blockhash expiry");
            result.failed += 1;
          }
        }
      }

      const job = await claimWithdrawalSigningJob(db, config.solanaWithdrawals.custodialEncryptionKey);
      if (!job) return result;
      let submissionRecorded = false;
      try {
        const sourceWallet = Keypair.fromSeed(job.sourceWalletSeed);
        if (sourceWallet.publicKey.toBase58() !== job.sourceWalletAddress) {
          throw new Error("custodial wallet key does not match stored public key");
        }
        const mint = new PublicKey(job.withdrawal.tokenMint);
        const destinationOwner = new PublicKey(job.withdrawal.destinationAddress);
        const sourceTokenAccount = associatedTokenAddress(mint, sourceWallet.publicKey);
        const destinationTokenAccount = associatedTokenAddress(mint, destinationOwner);
        const blockhash = await connection.getLatestBlockhash("finalized");
        const transaction = new Transaction({
          feePayer: config.solanaWithdrawals.feePayer.publicKey,
          recentBlockhash: blockhash.blockhash
        }).add(
          createAssociatedTokenAccountIdempotentInstruction(
            config.solanaWithdrawals.feePayer.publicKey,
            destinationTokenAccount,
            destinationOwner,
            mint
          ),
          createTransferCheckedInstruction(
            sourceTokenAccount,
            mint,
            destinationTokenAccount,
            sourceWallet.publicKey,
            BigInt(job.withdrawal.tokenAmountBaseUnits),
            config.billing.solanaTokenDecimals
          ),
          new TransactionInstruction({
            programId: memoProgram,
            keys: [],
            data: Buffer.from(`hyperspace-withdrawal:${job.withdrawal.id}`, "utf8")
          })
        );
        transaction.sign(config.solanaWithdrawals.feePayer, sourceWallet);
        if (!transaction.signature) throw new Error("signed transaction is missing fee-payer signature");
        const signature = encodeBase58(transaction.signature);
        await recordWithdrawalSubmission(db, job.withdrawal.id, signature, {
          recentBlockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
          sourceWalletAddress: job.sourceWalletAddress,
          sourceTokenAccount: sourceTokenAccount.toBase58(),
          destinationTokenAccount: destinationTokenAccount.toBase58()
        });
        submissionRecorded = true;
        const sentSignature = await connection.sendRawTransaction(transaction.serialize(), {
          preflightCommitment: "confirmed",
          maxRetries: 3
        });
        if (sentSignature !== signature) throw new Error("Solana RPC returned an unexpected transaction signature");
        result.signed += 1;
      } catch (error) {
        if (!submissionRecorded) {
          await failWithdrawalSubmission(db, job.withdrawal.id, error instanceof Error ? error.message : String(error));
        }
        result.failed += 1;
      } finally {
        job.sourceWalletSeed.fill(0);
      }
      return result;
    }
  };
}

export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    associatedTokenProgram
  )[0];
}

export function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  associatedAccount: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: associatedTokenProgram,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false }
    ],
    data: Buffer.from([1])
  });
}

export function createTransferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number
): TransactionInstruction {
  if (amount < 0n || amount > 0xffff_ffff_ffff_ffffn) {
    throw new Error("withdrawal token amount does not fit SPL Token u64");
  }
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false }
    ],
    data
  });
}

export function encodeBase58(value: Uint8Array): string {
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
