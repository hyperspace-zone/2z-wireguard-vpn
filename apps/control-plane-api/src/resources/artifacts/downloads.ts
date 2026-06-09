import type { FastifyRequest } from "fastify";
import { headerValue, readQuery } from "../../http/request.js";

export function shouldReturnRawWireGuardConfig(request: FastifyRequest): boolean {
  if (readQuery(request, "format") === "conf") {
    return true;
  }
  return headerValue(request, "accept")
    .split(",")
    .some((entry) => entry.split(";", 1)[0]?.trim().toLowerCase() === "text/plain");
}
