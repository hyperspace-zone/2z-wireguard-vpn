import assert from "node:assert/strict";
import test from "node:test";
import { artifactPhaseValues } from "@hyperspace-zone/contracts";
import {
  artifactAvailableTransition,
  artifactDownloadedTransition,
  artifactInvalidatedTransition,
  canDownloadArtifact,
  preparedArtifactTransition,
  type ArtifactPhase
} from "./transitions.js";

test("artifact transitions align with public contract phases", () => {
  const phases = [
    preparedArtifactTransition(),
    artifactAvailableTransition(),
    artifactDownloadedTransition(),
    artifactInvalidatedTransition()
  ] satisfies ArtifactPhase[];

  assert.deepEqual(phases, [...artifactPhaseValues]);
  assert.equal(canDownloadArtifact("prepared"), true);
  assert.equal(canDownloadArtifact("available"), true);
  assert.equal(canDownloadArtifact("downloaded"), true);
  assert.equal(canDownloadArtifact("invalidated"), false);
});
