import type { TransactionalQueryable } from "../../db/queryable.js";
import { ensureBillingAccount } from "../../resources/billing/repository.js";
import { enqueueBillingNotification } from "../../resources/billing/prepaid-repository.js";
import {
  findExhaustedSessionTrafficEntitlementForUpdate,
  markSessionTrafficEntitlementExhausted
} from "../../resources/billing/traffic-quota-repository.js";
import { requestSystemSessionRevocation } from "../../resources/sessions/service.js";

export interface TrafficQuotaEnforcementResult {
  exhausted: number;
  revocationsRequested: number;
}

export async function enforceSessionTrafficQuotas(
  db: TransactionalQueryable,
  batchSize = 100
): Promise<TrafficQuotaEnforcementResult> {
  const result: TrafficQuotaEnforcementResult = { exhausted: 0, revocationsRequested: 0 };
  const limit = Math.max(1, Math.min(1_000, Math.trunc(batchSize)));
  for (let index = 0; index < limit; index += 1) {
    const enforced = await db.transaction(async (client) => {
      const entitlement = await findExhaustedSessionTrafficEntitlementForUpdate(client);
      if (!entitlement) return null;
      const reason = {
        code: "traffic_quota_exhausted",
        includedBytes: entitlement.includedBytes,
        consumedBytes: entitlement.consumedBytes
      };
      const revoked = await requestSystemSessionRevocation(client, entitlement.sessionId, reason);
      await markSessionTrafficEntitlementExhausted(client, entitlement.sessionId);
      if (revoked) {
        await ensureBillingAccount(client, entitlement.accountId);
        await enqueueBillingNotification(client, {
          accountId: entitlement.accountId,
          notificationType: "traffic_quota_exhausted",
          dedupeKey: `traffic-quota-exhausted:${entitlement.sessionId}`,
          payload: {
            configs: [{ id: entitlement.sessionId, label: entitlement.sessionLabel ?? "" }],
            includedBytes: entitlement.includedBytes,
            consumedBytes: entitlement.consumedBytes
          }
        });
      }
      return { revoked };
    });
    if (!enforced) break;
    result.exhausted += 1;
    if (enforced.revoked) result.revocationsRequested += 1;
  }
  return result;
}
