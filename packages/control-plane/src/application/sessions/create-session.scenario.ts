import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  mergeSessionAbuseControlConfig,
  validateSessionAbusePolicy,
  type SessionAbuseControlConfig
} from "../../resources/sessions/abuse-controls.js";
import type { SessionOwner } from "../../resources/sessions/repository.js";
import { createRequestedSessionWithAbuseControls } from "../../resources/sessions/service.js";
import { parseSessionCreateBody } from "../../resources/sessions/validation.js";
import { findSessionIdByCreateRequest } from "../../resources/sessions/repository.js";
import { resolveTradingRoute } from "../../resources/trading-pairs/service.js";

export type PublicSessionActor = SessionOwner;

export interface CreateSessionSuccess {
  status: "created";
  sessionId: string;
}

export interface CreateSessionFailure {
  status: "invalid";
  error: string;
  message?: string;
}

export async function createSession(
  db: TransactionalQueryable,
  actor: PublicSessionActor,
  body: Record<string, unknown>,
  abuseControls: Partial<SessionAbuseControlConfig> = {},
  options: { initialPhase?: "payment_pending" | "requested" } = {}
): Promise<CreateSessionSuccess | CreateSessionFailure> {
  const parsed = parseSessionCreateBody(body);
  if ("error" in parsed) {
    return {
      status: "invalid",
      error: parsed.error,
      ...(parsed.message ? { message: parsed.message } : {})
    };
  }

  if (body.tradingRouteId !== undefined) {
    // A retry of an already-created paid request must resume its original
    // session even if a newer benchmark now recommends a different route.
    if (parsed.createRequestId) {
      const existing = await findSessionIdByCreateRequest(db, actor.accountId, parsed.createRequestId);
      if (existing) return { status: "created", sessionId: existing };
    }
    const preset = typeof body.tradingRouteId === "string" ? await resolveTradingRoute(db, body.tradingRouteId, true) : null;
    if (!preset || parsed.mode !== "FullTunnel" || parsed.destinationCidrs.length !== 1 || parsed.destinationCidrs[0] !== "0.0.0.0/0"
      || parsed.spec.ingressGateName !== preset.route.ingressGateName || parsed.spec.egressGateName !== preset.route.egressGateName
      || (parsed.spec.ingressGateId !== undefined && parsed.spec.ingressGateId !== preset.source.gateId)
      || (parsed.spec.egressGateId !== undefined && parsed.spec.egressGateId !== preset.egress.gateId)) {
      return { status: "invalid", error: "route_policy_not_satisfied", message: "The selected Pair Routes preset is stale, unavailable, or differs from this config. Return to Pair Routes and select a current route. No payment has been taken." };
    }
    parsed.spec.pathPolicy = { ...(parsed.spec.pathPolicy as Record<string, unknown>), tradingRouteId: body.tradingRouteId };
  }

  const controls = mergeSessionAbuseControlConfig(abuseControls);
  const policyError = validateSessionAbusePolicy(parsed, controls);
  if (policyError) {
    return {
      status: "invalid",
      error: policyError.error,
      message: policyError.message
    };
  }

  const created = await createRequestedSessionWithAbuseControls(
    db,
    actor,
    parsed,
    controls,
    options.initialPhase ?? "requested"
  );
  if (created.status === "rejected") {
    return {
      status: "invalid",
      error: created.error,
      message: created.message
    };
  }

  return {
    status: "created",
    sessionId: created.sessionId
  };
}
