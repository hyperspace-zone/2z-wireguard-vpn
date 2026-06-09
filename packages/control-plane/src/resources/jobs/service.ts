import type { Queryable } from "../../db/queryable.js";
import { insertApplyAssignmentJob, type EnqueueApplyJobInput } from "./repository.js";

export async function enqueueApplyJob(
  db: Queryable,
  input: EnqueueApplyJobInput
): Promise<void> {
  await insertApplyAssignmentJob(db, input);
}
