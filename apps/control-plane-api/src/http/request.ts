import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import type { FastifyRequest } from "fastify";

export function bearerToken(request: FastifyRequest): string {
  const header = headerValue(request, "authorization");
  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return header.slice("bearer ".length).trim();
}

export function headerValue(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return typeof value === "string" ? value : "";
}

export function detectClientIpv4(request: FastifyRequest): string {
  // Fastify resolves the chain using the explicit trusted-proxy allowlist.
  // Never read arbitrary client-supplied forwarding headers here.
  return normalizeIpv4(request.ip);
}

export function clientIpForSecurity(request: FastifyRequest): string {
  const value = request.ip.replace(/^::ffff:/, "");
  return ipaddr.isValid(value) ? ipaddr.process(value).toString() : "unknown";
}

export function clientRateLimitIdentity(request: FastifyRequest): string {
  const ip = clientIpForSecurity(request);
  if (isIP(ip) !== 6) return ip;
  return `${ipaddr.parse(ip).toByteArray().slice(0, 8).map(byte => byte.toString(16).padStart(2, "0")).join("")}/64`;
}

export function normalizeIpv4(value: string): string {
  const candidate = value.trim().replace(/^::ffff:/, "");
  return isIP(candidate) === 4 ? candidate : "";
}

export function readParam(request: FastifyRequest, name: string): string {
  const params = asRecord(request.params);
  return readString(params, name);
}

export function readQuery(request: FastifyRequest, name: string): string {
  const query = asRecord(request.query);
  return readString(query, name);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

export function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}
