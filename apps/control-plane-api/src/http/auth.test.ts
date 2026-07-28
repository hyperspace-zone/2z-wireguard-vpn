import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "@hyperspace-zone/db";
import { createHttpAuth, operatorTokenAdminId } from "./auth.js";

test("admin token uses a database-safe stable audit actor UUID", async () => {
  const auth = createHttpAuth({
    db: {} as Database,
    adminToken: "operator-secret"
  });
  const request = {
    headers: {
      "x-admin-token": "operator-secret"
    }
  } as unknown as FastifyRequest;

  const principal = await auth.requireAdmin(request, {} as FastifyReply);

  assert.deepEqual(principal, {
    kind: "admin",
    id: operatorTokenAdminId
  });
  assert.match(operatorTokenAdminId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});
