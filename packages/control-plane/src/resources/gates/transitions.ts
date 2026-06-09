export function isGateSchedulable(ready: boolean, desiredState: string): boolean {
  return ready && desiredState === "Enabled";
}
