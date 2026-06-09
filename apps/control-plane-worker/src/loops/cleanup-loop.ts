export interface CleanupLoop {
  runOnce(): Promise<void>;
}

export function createCleanupLoop(): CleanupLoop {
  return {
    async runOnce(): Promise<void> {
      return;
    }
  };
}
