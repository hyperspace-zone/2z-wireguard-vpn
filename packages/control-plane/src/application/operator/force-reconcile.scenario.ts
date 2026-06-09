import type { Queryable } from "../../db/queryable.js";
import { canOperateCluster } from "../../authz/policies.js";
import type { Principal } from "../../authz/principals.js";
import { enqueueReconcileJob } from "../../resources/jobs/service.js";

export async function forceReconcile(
  db: Queryable,
  principal: Principal,
  input: {
    gateId?: string;
    sessionId?: string;
    reason?: string;
  } = {}
): Promise<{ status: "queued"; jobId: string } | { status: "forbidden" }> {
  if (!canOperateCluster(principal)) {
    return { status: "forbidden" };
  }
  const jobId = await enqueueReconcileJob(db, {
    requestedBy: principal.id,
    ...(input.gateId ? { gateId: input.gateId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.reason ? { reason: input.reason } : {})
  });
  return { status: "queued", jobId };
}
