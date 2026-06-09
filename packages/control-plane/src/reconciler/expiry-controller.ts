import type { TransactionalQueryable } from "../db/queryable.js";
import {
  listExpiredEntitlementSessionIds,
  revokeEntitlementsForSession
} from "../resources/entitlements/repository.js";
import { requestSystemSessionRevocation } from "../resources/sessions/service.js";

export async function reconcileExpiry(db: TransactionalQueryable): Promise<void> {
  await db.transaction(async (client) => {
    const sessionIds = await listExpiredEntitlementSessionIds(client);
    for (const sessionId of sessionIds) {
      await requestSystemSessionRevocation(client, sessionId, {
        code: "entitlement_expired",
        message: "Session entitlement expired"
      });
      await revokeEntitlementsForSession(client, sessionId);
    }
  });
}
