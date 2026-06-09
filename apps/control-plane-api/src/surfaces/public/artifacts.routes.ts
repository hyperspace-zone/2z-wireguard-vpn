import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  attachmentFileName,
  issueClientConfigDownloadToken,
  redeemArtifactDownloadToken
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { PublicAuthUser } from "../../http/auth.js";
import { readParam, readString } from "../../http/request.js";
import { shouldReturnRawWireGuardConfig } from "../../resources/artifacts/downloads.js";

export function registerPublicArtifactRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    downloadTokenTtlSeconds: number;
    artifactEncryptionKey: Buffer | null;
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<PublicAuthUser | null>;
  }
): void {
  app.post("/v1/public/sessions/:sessionId/artifacts/client-config/download-token", async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }

    const token = await issueClientConfigDownloadToken(
      deps.db,
      user,
      readParam(request, "sessionId"),
      deps.downloadTokenTtlSeconds
    );
    if (token === "not_ready") {
      return reply.code(409).send({ error: "artifact_not_ready" });
    }

    return reply.send(token);
  });

  app.get("/v1/public/artifacts/download/:token", async (request, reply) => {
    const result = await redeemArtifactDownloadToken(
      deps.db,
      readParam(request, "token"),
      deps.artifactEncryptionKey
    );

    if (result === "not_found") {
      return reply.code(404).send({ error: "download_token_not_found" });
    }
    if (result === "encryption_not_configured") {
      return reply.code(503).send({ error: "artifact_encryption_not_configured" });
    }

    if (shouldReturnRawWireGuardConfig(request)) {
      const configText = readString(result.payload, "configText");
      if (!configText) {
        return reply.code(406).send({ error: "raw_config_not_available" });
      }
      const fileName = attachmentFileName(readString(result.payload, "fileName") || undefined, result.artifactId);
      return reply
        .type("text/plain; charset=utf-8")
        .header("content-disposition", `attachment; filename="${fileName}"`)
        .send(configText);
    }

    return reply.send({
      artifactId: result.artifactId,
      metadata: result.metadata,
      payload: result.payload,
      ...(result.payloadType ? { payloadType: result.payloadType } : {}),
      encryptedPayloadRef: result.encryptedPayloadRef
    });
  });
}
