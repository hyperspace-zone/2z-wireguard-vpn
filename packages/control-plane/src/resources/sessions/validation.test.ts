import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionCreateBody } from "./validation.js";

test("paid config request ID is retained for database idempotency and excluded from network spec", () => {
  const paymentRequestId = "a286e955-fd9f-4cad-811f-b48a451507f8";
  const parsed = parseSessionCreateBody({
    mode: "FullTunnel",
    ingressGateName: "gate-a",
    egressGateName: "gate-b",
    paymentRequestId
  });

  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.createRequestId, paymentRequestId);
  assert.equal(parsed.spec.createRequestId, undefined);
});

test("paid config request ID must be a UUID", () => {
  assert.deepEqual(parseSessionCreateBody({
    mode: "FullTunnel",
    ingressGateName: "gate-a",
    egressGateName: "gate-b",
    paymentRequestId: "not-a-uuid"
  }), {
    error: "invalid_create_request_id",
    message: "Config creation request ID must be a UUID."
  });
});
