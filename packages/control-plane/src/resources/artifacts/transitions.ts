export type ArtifactPhase = "prepared" | "available" | "downloaded" | "invalidated";

export function preparedArtifactTransition(): ArtifactPhase {
  return "prepared";
}

export function artifactAvailableTransition(): ArtifactPhase {
  return "available";
}

export function artifactDownloadedTransition(): ArtifactPhase {
  return "downloaded";
}

export function artifactInvalidatedTransition(): ArtifactPhase {
  return "invalidated";
}

export function canDownloadArtifact(phase: string): boolean {
  return phase === "prepared" || phase === "available" || phase === "downloaded";
}
