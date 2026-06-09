export function hasStateDrift(desiredHash: string | null | undefined, actualHash: string | null | undefined): boolean {
  return Boolean(desiredHash && actualHash && desiredHash !== actualHash);
}

export interface ManagedHandleDrift {
  drifted: boolean;
  missingHandles: string[];
  orphanHandles: string[];
}

export function compareManagedHandles(desiredHandles: string[], actualHandles: string[]): ManagedHandleDrift {
  const desired = new Set(desiredHandles);
  const actual = new Set(actualHandles);
  const missingHandles = [...desired].filter((handle) => !actual.has(handle)).sort();
  const orphanHandles = [...actual].filter((handle) => !desired.has(handle)).sort();
  return {
    drifted: missingHandles.length > 0 || orphanHandles.length > 0,
    missingHandles,
    orphanHandles
  };
}
