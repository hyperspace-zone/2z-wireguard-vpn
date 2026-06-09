import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  createArtifactDownloadToken,
  findLatestClientConfigArtifactForSession,
  type ArtifactDownloadToken
} from "../../resources/artifacts/download-tokens.js";

export interface PublicArtifactActor {
  id: string;
  accountId: string;
}

export async function issueClientConfigDownloadToken(
  db: TransactionalQueryable,
  actor: PublicArtifactActor,
  sessionId: string,
  ttlSeconds: number
): Promise<ArtifactDownloadToken | "not_ready"> {
  const artifact = await findLatestClientConfigArtifactForSession(db, actor.accountId, sessionId);
  if (!artifact) {
    return "not_ready";
  }
  return createArtifactDownloadToken(db, artifact.id, actor.id, ttlSeconds);
}
