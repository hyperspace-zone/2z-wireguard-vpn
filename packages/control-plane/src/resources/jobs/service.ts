import type { Queryable } from "../../db/queryable.js";
import type { RevocableAssignmentRow } from "../gate-assignments/repository.js";
import { insertApplyAssignmentJob, insertRevokeAssignmentJob, type EnqueueApplyJobInput } from "./repository.js";

export async function enqueueApplyJob(
  db: Queryable,
  input: EnqueueApplyJobInput
): Promise<void> {
  await insertApplyAssignmentJob(db, input);
}

export async function enqueueRevokeAssignmentJob(
  db: Queryable,
  assignment: RevocableAssignmentRow
): Promise<void> {
  await insertRevokeAssignmentJob(db, assignment);
}
