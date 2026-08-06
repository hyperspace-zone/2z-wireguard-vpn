import type { FastifyReply } from "fastify";

interface HttpErrorBody {
  error: string;
  message?: string;
}

function sendHttpError(reply: FastifyReply, statusCode: number, body: HttpErrorBody): FastifyReply {
  return reply.code(statusCode).send(body);
}

export type ApplicationErrorCode =
  | "admin_auth_required"
  | "admin_surface_not_configured"
  | "agent_surface_disabled"
  | "artifact_encryption_not_configured"
  | "artifact_not_ready"
  | "auth_required"
  | "config_payment_in_progress"
  | "config_payment_not_configured"
  | "config_payment_request_required"
  | "config_payment_unavailable"
  | "credentials_required"
  | "destination_not_allowed"
  | "destination_required"
  | "download_token_not_found"
  | "distinct_gates_required"
  | "egress_gate_required"
  | "email_code_expired"
  | "email_already_registered"
  | "email_not_verified"
  | "forbidden"
  | "gate_auth_required"
  | "gate_not_found"
  | "ingress_gate_required"
  | "invalid_auth_session"
  | "invalid_client_public_key"
  | "invalid_create_request_id"
  | "invalid_credentials"
  | "invalid_destination_cidr"
  | "invalid_email_code"
  | "invalid_email"
  | "invalid_gate_credentials"
  | "invalid_job_status"
  | "invalid_mode"
  | "invalid_oauth_state"
  | "invalid_source_cidr"
  | "job_not_found"
  | "oauth_email_not_verified"
  | "oauth_exchange_failed"
  | "oauth_not_configured"
  | "raw_config_not_available"
  | "rate_limited"
  | "route_policy_not_satisfied"
  | "session_create_rate_limited"
  | "insufficient_solana_funds"
  | "session_requires_positive_balance"
  | "session_not_found"
  | "session_not_revoked"
  | "session_quota_exceeded"
  | "too_many_attempts"
  | "weak_password";

export function sendApplicationError(
  reply: FastifyReply,
  code: ApplicationErrorCode,
  input: {
    message?: string;
  } = {}
): FastifyReply {
  return sendHttpError(reply, applicationErrorStatus(code), {
    error: code,
    ...(input.message ? { message: input.message } : {})
  });
}

function applicationErrorStatus(code: ApplicationErrorCode): number {
  switch (code) {
    case "admin_surface_not_configured":
    case "agent_surface_disabled":
    case "artifact_encryption_not_configured":
    case "oauth_not_configured":
    case "config_payment_not_configured":
    case "config_payment_unavailable":
      return 503;
    case "artifact_not_ready":
    case "email_already_registered":
    case "session_requires_positive_balance":
    case "session_quota_exceeded":
    case "session_not_revoked":
    case "config_payment_in_progress":
      return 409;
    case "insufficient_solana_funds":
      return 402;
    case "rate_limited":
    case "session_create_rate_limited":
      return 429;
    case "raw_config_not_available":
      return 406;
    case "auth_required":
    case "admin_auth_required":
    case "gate_auth_required":
    case "invalid_auth_session":
    case "invalid_credentials":
    case "invalid_gate_credentials":
      return 401;
    case "forbidden":
    case "destination_not_allowed":
    case "email_not_verified":
    case "oauth_email_not_verified":
      return 403;
    case "download_token_not_found":
    case "gate_not_found":
    case "job_not_found":
    case "session_not_found":
      return 404;
    case "credentials_required":
    case "config_payment_request_required":
    case "destination_required":
    case "distinct_gates_required":
    case "egress_gate_required":
    case "email_code_expired":
    case "ingress_gate_required":
    case "invalid_client_public_key":
    case "invalid_create_request_id":
    case "invalid_destination_cidr":
    case "invalid_email_code":
    case "invalid_email":
    case "invalid_job_status":
    case "invalid_mode":
    case "invalid_oauth_state":
    case "invalid_source_cidr":
    case "oauth_exchange_failed":
    case "route_policy_not_satisfied":
    case "too_many_attempts":
    case "weak_password":
      return 400;
  }
}
