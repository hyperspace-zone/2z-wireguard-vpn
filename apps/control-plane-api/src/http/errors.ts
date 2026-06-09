import type { FastifyReply } from "fastify";

export interface HttpErrorBody {
  error: string;
  message?: string;
}

export function sendHttpError(reply: FastifyReply, statusCode: number, body: HttpErrorBody): FastifyReply {
  return reply.code(statusCode).send(body);
}
