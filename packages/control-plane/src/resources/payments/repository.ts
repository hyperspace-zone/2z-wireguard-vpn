import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export interface UpsertPaymentInput {
  accountId?: string;
  provider: string;
  providerPaymentId: string;
  status: string;
  amount: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export async function upsertPayment(db: Queryable, input: UpsertPaymentInput): Promise<string> {
  const result = await db.query<{ id: string }>(
    `
      INSERT INTO payments (
        account_id,
        provider,
        provider_payment_id,
        status,
        amount,
        metadata
      )
      VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb)
      ON CONFLICT (provider, provider_payment_id) DO UPDATE
      SET status = EXCLUDED.status,
          amount = EXCLUDED.amount,
          metadata = EXCLUDED.metadata
      RETURNING id
    `,
    [
      input.accountId || null,
      input.provider,
      input.providerPaymentId,
      input.status,
      JSON.stringify(input.amount),
      JSON.stringify(input.metadata)
    ]
  );
  return mustRow(result).id;
}
