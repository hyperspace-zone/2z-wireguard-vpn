import type { FastifyReply } from "fastify";

export interface HttpErrorBody {
  error: string;
  message?: string;
}

export function sendHttpError(reply: FastifyReply, statusCode: number, body: HttpErrorBody): FastifyReply {
  return reply.code(statusCode).send(body);
}

export function sendForbidden(reply: FastifyReply): FastifyReply {
  return sendHttpError(reply, 403, { error: "forbidden" });
}

export function sendNotFound(reply: FastifyReply, error: string): FastifyReply {
  return sendHttpError(reply, 404, { error });
}
