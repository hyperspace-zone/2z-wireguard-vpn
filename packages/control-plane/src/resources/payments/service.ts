import type { Queryable } from "../../db/queryable.js";
import { upsertPayment, type UpsertPaymentInput } from "./repository.js";

export function normalizePaymentProvider(value: string): string {
  return value.trim().toLowerCase();
}

export async function recordPayment(db: Queryable, input: UpsertPaymentInput): Promise<string> {
  return upsertPayment(db, {
    ...input,
    provider: normalizePaymentProvider(input.provider)
  });
}
