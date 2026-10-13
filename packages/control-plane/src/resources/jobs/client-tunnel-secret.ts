import { decryptJsonPayload } from "@hyperspace-zone/shared";
import type { Queryable } from "../../db/queryable.js";
import { readClientTunnel, validateHeaderProtectionKey } from "../../planning/client-tunnel.js";
import { selectRenderedPlanSecret } from "../artifacts/repository.js";

/** Add the obfuscation secret only to the authenticated ingress claim response.
 * Stored jobs, egress jobs, public material and result summaries never contain it.
 */
export async function withClientTunnelSecret(
  db: Queryable,
  job: { type: string; payload: unknown },
  encryptionKey?: Buffer | null
): Promise<unknown> {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) return job.payload;
  const payload = job.payload as Record<string, unknown>;
  if (job.type !== "apply_assignment" || payload.role !== "Ingress") return payload;
  const plan = (payload.operation === "prepare" ? payload.plan : payload.networkPlan) as Record<string, unknown> | undefined;
  const material = plan?.publicMaterial as Record<string, unknown> | undefined;
  const tunnel = readClientTunnel(material?.clientTunnel);
  if (tunnel.protocol === "wireguard") return payload;
  if (!encryptionKey || typeof plan?.planId !== "string") throw new Error("AmneziaWG secret delivery is not configured");
  const encrypted = await selectRenderedPlanSecret(db, plan.planId);
  if (!encrypted) throw new Error("missing AmneziaWG plan secret");
  const secret = decryptJsonPayload<Record<string, unknown>>(encrypted, encryptionKey);
  const headerProtectionKey = validateHeaderProtectionKey(tunnel, secret.headerProtectionKey);
  return { ...payload, clientTunnelSecret: { headerProtectionKey } };
}
