import type { Queryable } from "../../db/queryable.js";
import {
  ensureGateAssignmentQueuedStatus,
  upsertGateAssignment,
  type CreateGateAssignmentInput
} from "./repository.js";

export async function createAssignment(
  db: Queryable,
  input: CreateGateAssignmentInput
): Promise<string> {
  const assignmentId = await upsertGateAssignment(db, input);
  await ensureGateAssignmentQueuedStatus(db, assignmentId);
  return assignmentId;
}
