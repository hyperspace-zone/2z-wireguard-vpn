import type { Queryable } from "../db/queryable.js";
import { requeueExpiredJobLeases } from "../resources/jobs/service.js";

export async function requeueExpiredJobs(db: Queryable): Promise<void> {
  await requeueExpiredJobLeases(db);
}
