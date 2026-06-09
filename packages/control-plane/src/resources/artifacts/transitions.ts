export function canDownloadArtifact(phase: string): boolean {
  return phase === "prepared" || phase === "available" || phase === "downloaded";
}
