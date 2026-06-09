import type { Queryable } from "../../db/queryable.js";
import { insertGateAuditEvent } from "./repository.js";

export function auditDetails(details: Record<string, unknown> = {}): string {
  return JSON.stringify(details);
}

export async function recordGateAuditEvent(
  db: Queryable,
  input: {
    eventType: string;
    gateId: string;
    details: Record<string, unknown>;
  }
): Promise<void> {
  await insertGateAuditEvent(db, input);
}
