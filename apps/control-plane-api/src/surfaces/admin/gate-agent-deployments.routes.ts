import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  adminCreateGateAgentReleaseRequestSchema,
  adminGateAgentDeploymentResponseSchema,
  adminGateAgentDeploymentsResponseSchema,
  adminGateAgentReleaseResponseSchema,
  adminGateAgentReleasesResponseSchema,
  adminRequestGateAgentDeploymentRequestSchema,
  errorResponseSchema
} from "@hyperspace-zone/contracts";
import {
  createGateAgentRelease,
  readGateAgentDeploymentHistory,
  readGateAgentReleaseForGate,
  readGateAgentReleases,
  requestGateAgentDeployment,
  requestGateAgentRollback
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { AdminAuthContext, GateAuthContext } from "../../http/auth.js";
import { sendApplicationError } from "../../http/errors.js";
import { asRecord, readParam, readQuery, readString } from "../../http/request.js";
import { encodeGateAgentArtifact } from "../../resources/gate-agent-artifact-delivery.js";

const execFileAsync = promisify(execFile);
const maxAgentArtifactBytes = 64 * 1024 * 1024;

export function registerGateAgentDeploymentRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    releaseDir: string;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => AdminAuthContext | null | Promise<AdminAuthContext | null>;
    requireGate: (request: FastifyRequest, reply: FastifyReply) => Promise<GateAuthContext | null>;
  }
): void {
  app.post("/v1/admin/gate-agent/releases", {
    schema: {
      body: adminCreateGateAgentReleaseRequestSchema,
      response: { 200: adminGateAgentReleaseResponseSchema, 400: errorResponseSchema, 403: errorResponseSchema, 409: errorResponseSchema }
    }
  }, async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const body = asRecord(request.body);
    const input = {
      version: readString(body, "version"),
      revision: readString(body, "revision"),
      builtAt: readString(body, "builtAt"),
      artifactSha256: readString(body, "artifactSha256")
    };
    const artifact = await validateReleaseArtifact(deps.releaseDir, input);
    if (artifact === "missing") return sendApplicationError(reply, "agent_release_artifact_missing");
    if (artifact === "invalid") return sendApplicationError(reply, "agent_release_artifact_invalid");
    try {
      const release = await createGateAgentRelease(deps.db, admin, input);
      if (release === "forbidden") return sendApplicationError(reply, "forbidden");
      return reply.send({ release });
    } catch (error) {
      return sendApplicationError(reply, "agent_release_artifact_invalid", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/v1/admin/gate-agent/releases", {
    schema: { response: { 200: adminGateAgentReleasesResponseSchema, 403: errorResponseSchema } }
  }, async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const releases = await readGateAgentReleases(deps.db, admin);
    if (releases === "forbidden") return sendApplicationError(reply, "forbidden");
    return reply.send({ releases });
  });

  app.post("/v1/admin/gates/:gateId/agent-deployments", {
    schema: {
      body: adminRequestGateAgentDeploymentRequestSchema,
      response: { 200: adminGateAgentDeploymentResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema }
    }
  }, async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const result = await requestGateAgentDeployment(deps.db, admin, {
      gateId: readParam(request, "gateId"),
      releaseId: readString(asRecord(request.body), "releaseId")
    });
    if (result === "forbidden") return sendApplicationError(reply, "forbidden");
    if (result === "gate_not_found") return sendApplicationError(reply, "gate_not_found");
    if (result === "gate_not_bootstrapped") return sendApplicationError(reply, "gate_agent_not_bootstrapped");
    if (result === "release_not_found") return sendApplicationError(reply, "agent_release_not_found");
    if (result === "deployment_active") return sendApplicationError(reply, "gate_agent_deployment_active");
    return reply.send({ deployment: result });
  });

  app.get("/v1/admin/gate-agent/deployments", {
    schema: { response: { 200: adminGateAgentDeploymentsResponseSchema, 403: errorResponseSchema } }
  }, async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const deployments = await readGateAgentDeploymentHistory(deps.db, admin, readQuery(request, "gateId") || undefined);
    if (deployments === "forbidden") return sendApplicationError(reply, "forbidden");
    return reply.send({ deployments });
  });

  app.post("/v1/admin/gate-agent/deployments/:deploymentId/rollback", {
    schema: { response: { 200: adminGateAgentDeploymentResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema } }
  }, async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const reason = readString(asRecord(request.body), "reason") || "operator_requested";
    const result = await requestGateAgentRollback(deps.db, admin, {
      deploymentId: readParam(request, "deploymentId"),
      reason
    });
    if (result === "forbidden") return sendApplicationError(reply, "forbidden");
    if (result === "not_found") return sendApplicationError(reply, "gate_agent_deployment_not_found");
    if (result === "no_previous_release") return sendApplicationError(reply, "gate_agent_no_previous_release");
    if (result === "not_rollbackable") return sendApplicationError(reply, "gate_agent_not_rollbackable");
    return reply.send({ deployment: result });
  });

  app.get("/v1/gate/agent-releases/:releaseId/artifact", async (request, reply) => {
    const gate = await deps.requireGate(request, reply);
    if (!gate) return;
    const release = await readGateAgentReleaseForGate(deps.db, readParam(request, "releaseId"), gate.id);
    if (!release) return sendApplicationError(reply, "agent_release_not_found");
    const path = join(deps.releaseDir, release.artifactSha256);
    const data = await readValidatedArtifact(path, release.artifactSha256);
    if (!data) return sendApplicationError(reply, "agent_release_artifact_missing");
    const artifact = await encodeGateAgentArtifact(data, request.headers["accept-encoding"]);
    if (artifact.contentEncoding) reply.header("content-encoding", artifact.contentEncoding);
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-length", String(artifact.data.length))
      .header("cache-control", "private, no-store")
      .header("vary", "Accept-Encoding")
      .send(artifact.data);
  });
}

async function validateReleaseArtifact(
  releaseDir: string,
  expected: { version: string; revision: string; builtAt: string; artifactSha256: string }
): Promise<"valid" | "missing" | "invalid"> {
  const path = join(releaseDir, expected.artifactSha256);
  const data = await readValidatedArtifact(path, expected.artifactSha256);
  if (!data) return "missing";
  try {
    const metadata = JSON.parse((await execFileAsync(path, ["--build-info"], { timeout: 10_000 })).stdout) as Record<string, unknown>;
    return metadata.version === expected.version
      && metadata.revision === expected.revision
      && metadata.builtAt === expected.builtAt
      && metadata.artifactSha256 === expected.artifactSha256
      ? "valid"
      : "invalid";
  } catch {
    return "invalid";
  }
}

async function readValidatedArtifact(path: string, expectedSha256: string): Promise<Buffer | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > maxAgentArtifactBytes) return null;
    const data = await readFile(path);
    const actual = createHash("sha256").update(data).digest("hex");
    return actual === expectedSha256 ? data : null;
  } catch {
    return null;
  }
}
