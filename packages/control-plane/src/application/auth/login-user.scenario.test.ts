import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { hashPassword } from "../../security/passwords.js";
import { loginUser } from "./login-user.scenario.js";

test("password login is blocked until the account email is verified", async () => {
  const email = "pending-login-unit@ostealmar.resend.app";
  const password = "unit-only-password-not-runtime";
  let sessionInsertAttempted = false;
  const db: Queryable = {
    async query<Row extends object>(sql: string): Promise<{ rows: Row[] }> {
      if (sql.includes("FROM users") && sql.includes("password_credentials")) {
        return { rows: [{
          id: "user-1",
          accountId: "account-1",
          email,
          displayName: "Pending",
          avatarUrl: null,
          passwordHash: hashPassword(password),
          emailVerified: false
        } as Row] };
      }
      if (sql.includes("INSERT INTO auth_sessions")) {
        sessionInsertAttempted = true;
      }
      return { rows: [] };
    }
  };

  const result = await loginUser(db, {
    email,
    password,
    authSessionTtlSeconds: 3600
  });

  assert.equal(result, "email_not_verified");
  assert.equal(sessionInsertAttempted, false);
});
