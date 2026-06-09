import { runCleanupTasks } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";

export interface CleanupLoop {
  runOnce(): Promise<void>;
}

export function createCleanupLoop(db: Database): CleanupLoop {
  return {
    async runOnce(): Promise<void> {
      await runCleanupTasks(db);
    }
  };
}
