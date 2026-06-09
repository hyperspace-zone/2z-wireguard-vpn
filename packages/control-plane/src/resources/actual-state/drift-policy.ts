export function hasStateDrift(desiredHash: string | null | undefined, actualHash: string | null | undefined): boolean {
  return Boolean(desiredHash && actualHash && desiredHash !== actualHash);
}
