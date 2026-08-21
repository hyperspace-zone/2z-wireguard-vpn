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

test("deployment-configured billing admin requires a verified matching email", async () => {
  const queries: string[] = [];
  const db = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("FROM user_roles")) {
        return { rows: [{ allowed: false }] };
      }
      if (sql.includes("FROM identities")) {
        return { rows: [{ allowed: true }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  } as unknown as Database;
  const auth = createHttpAuth({
    db,
    adminToken: undefined,
    billingAdminEmails: ["admin@hyperspace.zone"]
  });

  const allowed = await auth.hasBillingAdminAccess({
    id: "user-1",
    accountId: "account-1",
    email: "Admin@Hyperspace.Zone",
    displayName: "Admin",
    avatarUrl: null
  });

  assert.equal(allowed, true);
  assert.equal(queries.filter((query) => query.includes("FROM user_roles")).length, 2);
  assert.equal(queries.filter((query) => query.includes("FROM identities")).length, 1);
});

test("deployment-configured billing admin rejects an unverified email", async () => {
  const db = {
    async query(sql: string) {
      if (sql.includes("FROM user_roles")) {
        return { rows: [{ allowed: false }] };
      }
      if (sql.includes("FROM identities")) {
        return { rows: [{ allowed: false }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  } as unknown as Database;
  const auth = createHttpAuth({
    db,
    adminToken: undefined,
    billingAdminEmails: ["admin@hyperspace.zone"]
  });

  const allowed = await auth.hasBillingAdminAccess({
    id: "user-1",
    accountId: "account-1",
    email: "admin@hyperspace.zone",
    displayName: "Admin",
    avatarUrl: null
  });

  assert.equal(allowed, false);
});
