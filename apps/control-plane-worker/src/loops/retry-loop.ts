export interface RetryLoop {
  runOnce(): Promise<void>;
}

export function createRetryLoop(): RetryLoop {
  return {
    async runOnce(): Promise<void> {
      // Retry policy currently runs inside the main reconciliation pass.
    }
  };
}
