import assert from "node:assert/strict";
import test from "node:test";
import { requestPathForLog } from "./app.js";

test("request logging removes OAuth codes and all other query values", () => {
  assert.equal(
    requestPathForLog("/v1/public/auth/google/callback?code=secret-code&state=secret-state"),
    "/v1/public/auth/google/callback"
  );
});
