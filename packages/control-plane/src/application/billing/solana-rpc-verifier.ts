export interface SolanaRpcVerifierConfig {
  rpcUrl: string;
  tokenMint: string;
  tokenBaseUnitsPerBillingMinor: number;
  fetchImpl?: typeof fetch;
}

export interface SolanaTopupExpectation {
  transactionSignature: string;
  treasuryAddress: string;
  reference: string;
  amountMinor: number;
  expectedSender?: string | null;
}

export type SolanaTopupVerification =
  | { status: "verified"; evidence: Record<string, unknown> }
  | { status: "pending"; reason: string }
  | { status: "invalid"; reason: string };

export interface SolanaAddressSignature {
  signature: string;
  blockTime: number | null;
}

export type SolanaDirectDepositVerification =
  | { status: "verified"; amountBaseUnits: bigint; references: string[]; evidence: Record<string, unknown> }
  | { status: "pending"; reason: string }
  | { status: "invalid"; reason: string };

export async function findFinalizedSolanaSignaturesForReference(
  reference: string,
  config: Pick<SolanaRpcVerifierConfig, "rpcUrl" | "fetchImpl">
): Promise<string[]> {
  if (!config.rpcUrl) {
    return [];
  }
  const result = await rpcCall(config.fetchImpl ?? fetch, config.rpcUrl, "getSignaturesForAddress", [
    reference,
    { limit: 10, commitment: "finalized" }
  ]);
  return asArray(result).flatMap((value) => {
    const record = asRecord(value);
    return typeof record.signature === "string" && record.err === null ? [record.signature] : [];
  });
}

export async function findSolanaTokenAccountsByOwner(
  owner: string,
  config: Pick<SolanaRpcVerifierConfig, "rpcUrl" | "tokenMint" | "fetchImpl">
): Promise<string[]> {
  if (!config.rpcUrl || !config.tokenMint) {
    return [];
  }
  const result = asRecord(await rpcCall(config.fetchImpl ?? fetch, config.rpcUrl, "getTokenAccountsByOwner", [
    owner,
    { mint: config.tokenMint },
    { encoding: "jsonParsed", commitment: "finalized" }
  ]));
  return asArray(result.value).flatMap((value) => {
    const publicKey = asRecord(value).pubkey;
    return typeof publicKey === "string" ? [publicKey] : [];
  });
}

export async function findFinalizedSolanaSignaturesForAddress(
  address: string,
  input: { until?: string; before?: string; limit?: number },
  config: Pick<SolanaRpcVerifierConfig, "rpcUrl" | "fetchImpl">
): Promise<SolanaAddressSignature[]> {
  if (!config.rpcUrl) {
    return [];
  }
  const options: Record<string, unknown> = {
    limit: Math.max(1, Math.min(1000, input.limit ?? 100)),
    commitment: "finalized"
  };
  if (input.until) options.until = input.until;
  if (input.before) options.before = input.before;
  const result = await rpcCall(config.fetchImpl ?? fetch, config.rpcUrl, "getSignaturesForAddress", [address, options]);
  return asArray(result).flatMap((value) => {
    const record = asRecord(value);
    return typeof record.signature === "string" && record.err === null
      ? [{
        signature: record.signature,
        blockTime: typeof record.blockTime === "number" ? record.blockTime : null
      }]
      : [];
  });
}

export async function readSolanaNativeBalance(
  address: string,
  config: Pick<SolanaRpcVerifierConfig, "rpcUrl" | "fetchImpl">
): Promise<bigint> {
  if (!config.rpcUrl) return 0n;
  const result = asRecord(await rpcCall(config.fetchImpl ?? fetch, config.rpcUrl, "getBalance", [
    address,
    { commitment: "finalized" }
  ]));
  const value = result.value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Solana RPC getBalance returned an invalid lamport balance");
  }
  return BigInt(value);
}

export async function readSolanaMinimumBalanceForRentExemption(
  config: Pick<SolanaRpcVerifierConfig, "rpcUrl" | "fetchImpl">
): Promise<bigint> {
  if (!config.rpcUrl) return 0n;
  const result = await rpcCall(config.fetchImpl ?? fetch, config.rpcUrl, "getMinimumBalanceForRentExemption", [
    0,
    { commitment: "finalized" }
  ]);
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new Error("Solana RPC getMinimumBalanceForRentExemption returned an invalid lamport balance");
  }
  return BigInt(result);
}

export async function verifySolanaTopupTransaction(
  expectation: SolanaTopupExpectation,
  config: SolanaRpcVerifierConfig
): Promise<SolanaTopupVerification> {
  if (!config.rpcUrl || !config.tokenMint || !Number.isSafeInteger(config.tokenBaseUnitsPerBillingMinor) || config.tokenBaseUnitsPerBillingMinor <= 0) {
    throw new Error("Solana RPC verification is not configured");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const statuses = await rpcCall(fetchImpl, config.rpcUrl, "getSignatureStatuses", [
    [expectation.transactionSignature],
    { searchTransactionHistory: true }
  ]);
  const signatureStatus = asRecord(asArray(asRecord(statuses).value)[0]);
  if (Object.keys(signatureStatus).length === 0) {
    return { status: "pending", reason: "transaction_not_found" };
  }
  if (signatureStatus.err !== null && signatureStatus.err !== undefined) {
    return { status: "invalid", reason: "transaction_failed" };
  }
  if (signatureStatus.confirmationStatus !== "finalized") {
    return { status: "pending", reason: "transaction_not_finalized" };
  }

  const transaction = asRecord(await rpcCall(fetchImpl, config.rpcUrl, "getTransaction", [
    expectation.transactionSignature,
    { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }
  ]));
  if (Object.keys(transaction).length === 0) {
    return { status: "pending", reason: "finalized_transaction_unavailable" };
  }
  const meta = asRecord(transaction.meta);
  if (meta.err !== null && meta.err !== undefined) {
    return { status: "invalid", reason: "transaction_failed" };
  }
  const message = asRecord(asRecord(transaction.transaction).message);
  const accountKeys = asArray(message.accountKeys).map(asRecord);
  if (expectation.expectedSender) {
    const senderSigned = accountKeys.some((entry) => readPublicKey(entry) === expectation.expectedSender && entry.signer === true);
    if (!senderSigned) {
      return { status: "invalid", reason: "expected_sender_did_not_sign" };
    }
  }

  const instructions = [
    ...asArray(message.instructions),
    ...asArray(meta.innerInstructions).flatMap((entry) => asArray(asRecord(entry).instructions))
  ].map(asRecord);
  if (!instructions.some((instruction) => instructionMemo(instruction) === expectation.reference)) {
    return { status: "invalid", reason: "topup_reference_memo_missing" };
  }

  const expectedBaseUnits = BigInt(expectation.amountMinor) * BigInt(config.tokenBaseUnitsPerBillingMinor);
  const treasuryDelta = tokenBalanceDelta(
    asArray(meta.preTokenBalances),
    asArray(meta.postTokenBalances),
    expectation.treasuryAddress,
    config.tokenMint
  );
  if (treasuryDelta !== expectedBaseUnits) {
    return { status: "invalid", reason: "token_amount_or_recipient_mismatch" };
  }

  if (expectation.expectedSender) {
    const senderAuthorizedTransfer = instructions.some((instruction) => {
      const parsed = asRecord(instruction.parsed);
      const info = asRecord(parsed.info);
      return (parsed.type === "transfer" || parsed.type === "transferChecked") && info.authority === expectation.expectedSender;
    });
    if (!senderAuthorizedTransfer) {
      return { status: "invalid", reason: "expected_sender_not_transfer_authority" };
    }
  }

  return {
    status: "verified",
    evidence: {
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      confirmationStatus: signatureStatus.confirmationStatus,
      tokenMint: config.tokenMint,
      treasuryAddress: expectation.treasuryAddress,
      amountBaseUnits: expectedBaseUnits.toString(),
      reference: expectation.reference,
      expectedSender: expectation.expectedSender ?? null
    }
  };
}

export async function verifySolanaDirectDepositTransaction(
  input: { transactionSignature: string; recipientOwner: string },
  config: Pick<SolanaRpcVerifierConfig, "rpcUrl" | "tokenMint" | "fetchImpl">
): Promise<SolanaDirectDepositVerification> {
  if (!config.rpcUrl || !config.tokenMint) {
    throw new Error("Solana RPC direct deposit verification is not configured");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const statuses = await rpcCall(fetchImpl, config.rpcUrl, "getSignatureStatuses", [
    [input.transactionSignature],
    { searchTransactionHistory: true }
  ]);
  const signatureStatus = asRecord(asArray(asRecord(statuses).value)[0]);
  if (Object.keys(signatureStatus).length === 0) {
    return { status: "pending", reason: "transaction_not_found" };
  }
  if (signatureStatus.err !== null && signatureStatus.err !== undefined) {
    return { status: "invalid", reason: "transaction_failed" };
  }
  if (signatureStatus.confirmationStatus !== "finalized") {
    return { status: "pending", reason: "transaction_not_finalized" };
  }

  const transaction = asRecord(await rpcCall(fetchImpl, config.rpcUrl, "getTransaction", [
    input.transactionSignature,
    { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }
  ]));
  if (Object.keys(transaction).length === 0) {
    return { status: "pending", reason: "finalized_transaction_unavailable" };
  }
  const meta = asRecord(transaction.meta);
  if (meta.err !== null && meta.err !== undefined) {
    return { status: "invalid", reason: "transaction_failed" };
  }
  const message = asRecord(asRecord(transaction.transaction).message);
  const instructions = [
    ...asArray(message.instructions),
    ...asArray(meta.innerInstructions).flatMap((entry) => asArray(asRecord(entry).instructions))
  ].map(asRecord);
  const references = instructions.map(instructionMemo).filter(Boolean);
  const amountBaseUnits = tokenBalanceDelta(
    asArray(meta.preTokenBalances),
    asArray(meta.postTokenBalances),
    input.recipientOwner,
    config.tokenMint
  );
  if (amountBaseUnits <= 0n) {
    return { status: "invalid", reason: "no_positive_recipient_token_delta" };
  }
  return {
    status: "verified",
    amountBaseUnits,
    references,
    evidence: {
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      confirmationStatus: signatureStatus.confirmationStatus,
      tokenMint: config.tokenMint,
      recipientOwner: input.recipientOwner,
      amountBaseUnits: amountBaseUnits.toString(),
      references
    }
  };
}

export async function verifyNativeSolDirectDepositTransaction(
  input: { transactionSignature: string; recipientOwner: string },
  config: Pick<SolanaRpcVerifierConfig, "rpcUrl" | "fetchImpl">
): Promise<SolanaDirectDepositVerification> {
  if (!config.rpcUrl) {
    throw new Error("Solana RPC native deposit verification is not configured");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const statuses = await rpcCall(fetchImpl, config.rpcUrl, "getSignatureStatuses", [
    [input.transactionSignature],
    { searchTransactionHistory: true }
  ]);
  const signatureStatus = asRecord(asArray(asRecord(statuses).value)[0]);
  if (Object.keys(signatureStatus).length === 0) return { status: "pending", reason: "transaction_not_found" };
  if (signatureStatus.err !== null && signatureStatus.err !== undefined) return { status: "invalid", reason: "transaction_failed" };
  if (signatureStatus.confirmationStatus !== "finalized") return { status: "pending", reason: "transaction_not_finalized" };

  const transaction = asRecord(await rpcCall(fetchImpl, config.rpcUrl, "getTransaction", [
    input.transactionSignature,
    { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }
  ]));
  if (Object.keys(transaction).length === 0) return { status: "pending", reason: "finalized_transaction_unavailable" };
  const meta = asRecord(transaction.meta);
  if (meta.err !== null && meta.err !== undefined) return { status: "invalid", reason: "transaction_failed" };
  const message = asRecord(asRecord(transaction.transaction).message);
  const accountKeys = asArray(message.accountKeys).map(asRecord);
  const recipientIndex = accountKeys.findIndex((entry) => readPublicKey(entry) === input.recipientOwner);
  if (recipientIndex < 0) return { status: "invalid", reason: "recipient_account_not_found" };
  const preBalance = readLamportBalance(asArray(meta.preBalances), recipientIndex);
  const postBalance = readLamportBalance(asArray(meta.postBalances), recipientIndex);
  const amountBaseUnits = postBalance - preBalance;
  if (amountBaseUnits <= 0n) return { status: "invalid", reason: "no_positive_recipient_sol_delta" };
  const instructions = [
    ...asArray(message.instructions),
    ...asArray(meta.innerInstructions).flatMap((entry) => asArray(asRecord(entry).instructions))
  ].map(asRecord);
  const references = instructions.map(instructionMemo).filter(Boolean);
  return {
    status: "verified",
    amountBaseUnits,
    references,
    evidence: {
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      confirmationStatus: signatureStatus.confirmationStatus,
      tokenMint: "native",
      recipientOwner: input.recipientOwner,
      amountBaseUnits: amountBaseUnits.toString(),
      references
    }
  };
}

async function rpcCall(fetchImpl: typeof fetch, rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const text = await response.text();
  const payload = text ? asRecord(JSON.parse(text)) : {};
  if (!response.ok || payload.error) {
    const message = asRecord(payload.error).message;
    throw new Error(`Solana RPC ${method} failed: ${typeof message === "string" ? message : response.status}`);
  }
  return payload.result;
}

function tokenBalanceDelta(preValue: unknown[], postValue: unknown[], owner: string, mint: string): bigint {
  const pre = tokenBalancesByAccount(preValue, owner, mint);
  const post = tokenBalancesByAccount(postValue, owner, mint);
  const accountIndexes = new Set([...pre.keys(), ...post.keys()]);
  let delta = 0n;
  for (const accountIndex of accountIndexes) {
    delta += (post.get(accountIndex) ?? 0n) - (pre.get(accountIndex) ?? 0n);
  }
  return delta;
}

function readLamportBalance(values: unknown[], index: number): bigint {
  const value = values[index];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Solana transaction contains an invalid lamport balance");
  }
  return BigInt(value);
}

function tokenBalancesByAccount(values: unknown[], owner: string, mint: string): Map<number, bigint> {
  const balances = new Map<number, bigint>();
  for (const value of values) {
    const record = asRecord(value);
    if (record.owner !== owner || record.mint !== mint || typeof record.accountIndex !== "number") {
      continue;
    }
    const amount = asRecord(record.uiTokenAmount).amount;
    if (typeof amount === "string" && /^\d+$/.test(amount)) {
      balances.set(record.accountIndex, BigInt(amount));
    }
  }
  return balances;
}

function instructionMemo(instruction: Record<string, unknown>): string {
  const program = typeof instruction.program === "string" ? instruction.program : "";
  const programId = typeof instruction.programId === "string" ? instruction.programId : "";
  if (program !== "spl-memo" && !programId.startsWith("Memo")) {
    return "";
  }
  return typeof instruction.parsed === "string" ? instruction.parsed : "";
}

function readPublicKey(record: Record<string, unknown>): string {
  if (typeof record.pubkey === "string") {
    return record.pubkey;
  }
  return typeof record.publicKey === "string" ? record.publicKey : "";
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
