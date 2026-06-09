import { requeueExpiredJobs } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";

export interface RetryLoop {
  runOnce(): Promise<void>;
}

export function createRetryLoop(db: Database): RetryLoop {
  return {
    async runOnce(): Promise<void> {
      await requeueExpiredJobs(db);
    }
  };
}
