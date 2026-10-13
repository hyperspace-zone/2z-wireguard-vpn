import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "@hyperspace-zone/db";
import type { SolanaConfigPaymentService } from "../../services/solana-config-payment.js";
import { registerPublicSessionsRoutes } from "./sessions.routes.js";

const sessionId = "26df9140-2f08-4c64-b270-429e4d74fb97";
const requestId = "a286e955-fd9f-4cad-811f-b48a451507f8";
const payload = { mode: "FullTunnel", ingressGateName: "gate-a", egressGateName: "gate-b", paymentRequestId: requestId };

for (const clientProtocol of ["wireguard", "amneziawg"]) {
  test(`administrators issue ${clientProtocol} with a traffic allowance and no wallet or payment service`, async (t) => {
    const fixture = setup({ admin: true, enforceBalance: true, paymentService: false });
    t.after(() => fixture.app.close());
    const response = await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload: { ...payload, clientProtocol } });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().session.phase, "requested");
    assert.equal(response.json().session.trafficLimitBytes, "50000000000");
    assert.equal(fixture.state.chargeCalls, 0);
    assert.equal(fixture.state.grantWrites, 1);
    assert.equal(fixture.state.entitlementWrites, 1);
    assert.equal(fixture.state.grantAudits, 1);
    assert.equal(fixture.state.protocol, clientProtocol);

    fixture.state.usedBytes = "1024";
    const retried = await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload });
    assert.equal(retried.statusCode, 201, retried.body);
    assert.equal(retried.json().session.id, sessionId);
    assert.equal(retried.json().session.trafficUsedBytes, "1024");
    assert.equal(fixture.state.sessionWrites, 1);
    assert.equal(fixture.state.grantWrites, 1);
    assert.equal(fixture.state.entitlementWrites, 1);
  });
}

test("client-supplied administrator and grant fields cannot bypass payment", async (t) => {
  const fixture = setup({ admin: false });
  t.after(() => fixture.app.close());
  const response = await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload: {
    ...payload, billingAdmin: true, configPaymentExempt: true, configGrant: { includedBytes: 50_000_000_000 }
  } });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, "config_payment_in_progress");
  assert.equal(fixture.state.chargeCalls, 1);
  assert.equal(fixture.state.phase, "payment_pending");
  assert.equal(fixture.state.grantWrites, 0);
  assert.equal(fixture.state.entitlementWrites, 0);
});

test("ordinary users still need a payment request and a configured payment service", async (t) => {
  const fixture = setup({ admin: false, paymentService: false });
  t.after(() => fixture.app.close());
  const { paymentRequestId: _requestId, ...withoutId } = payload;
  const missingId = await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload: withoutId });
  assert.equal(missingId.statusCode, 400);
  assert.equal(missingId.json().error, "config_payment_request_required");
  const missingService = await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload });
  assert.equal(missingService.statusCode, 503);
  assert.equal(missingService.json().error, "config_payment_not_configured");
  assert.equal(fixture.state.sessionWrites, 0);
});

test("removing administrator access never charges a retry of a granted config", async (t) => {
  const fixture = setup({ admin: true });
  t.after(() => fixture.app.close());
  assert.equal((await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload })).statusCode, 201);
  fixture.state.admin = false;
  const response = await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(fixture.state.chargeCalls, 0);
  assert.equal(fixture.state.grantWrites, 1);
});

test("promotion does not convert an existing paid request or trigger another payment", async (t) => {
  const fixture = setup({ admin: false });
  t.after(() => fixture.app.close());
  assert.equal((await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload })).statusCode, 409);
  fixture.state.admin = true;
  const response = await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, "config_payment_request_conflict");
  assert.equal(fixture.state.chargeCalls, 1);
  assert.equal(fixture.state.grantWrites, 0);
});

test("administrator free issuance still enforces the active config quota", async (t) => {
  const fixture = setup({ admin: true, activeCount: 5 });
  t.after(() => fixture.app.close());
  const response = await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, "session_quota_exceeded");
  assert.equal(fixture.state.sessionWrites, 0);
  assert.equal(fixture.state.grantWrites, 0);
});

test("an entitlement failure rolls back the config and grant together", async (t) => {
  const fixture = setup({ admin: true, failEntitlement: true });
  t.after(() => fixture.app.close());
  const response = await fixture.app.inject({ method: "POST", url: "/v1/public/sessions", payload });
  assert.equal(response.statusCode, 500);
  assert.equal(fixture.state.sessionWrites, 0);
  assert.equal(fixture.state.grantWrites, 0);
  assert.equal(fixture.state.chargeCalls, 0);
});

function setup(options: { admin: boolean; enforceBalance?: boolean; paymentService?: boolean; activeCount?: number; failEntitlement?: boolean }) {
  const state = { admin: options.admin, sessionWrites: 0, grantWrites: 0, entitlementWrites: 0, grantAudits: 0,
    chargeCalls: 0, phase: "", usedBytes: "0", protocol: "" };
  let inTransaction = false;
  async function query(sql: string, params?: unknown[]) {
    const rows = (values: object[]) => ({ rows: values, rowCount: values.length });
    if (/SELECT id\s+FROM accounts/.test(sql)) return rows([{ id: "account-1" }]);
    if (/SELECT id\s+FROM sessions/.test(sql) && /create_request_id/.test(sql)) return rows(state.sessionWrites ? [{ id: sessionId }] : []);
    if (/COUNT\(\*\)::int AS count/.test(sql)) return rows([{ count: options.activeCount ?? 0 }]);
    if (/SELECT gates.id, gates.name/.test(sql)) return rows([{ id: params?.[2] + "-id", name: params?.[2], publicIpv4: "192.0.2.1" }]);
    if (/INSERT INTO/.test(sql)) assert.equal(inTransaction, true, "session and allowance writes must share one transaction");
    if (/INSERT INTO sessions\s*\(/.test(sql)) {
      state.sessionWrites++;
      state.protocol = JSON.parse(String(params?.[7])).clientProtocol;
      return rows([{ id: sessionId }]);
    }
    if (/INSERT INTO session_status/.test(sql)) { state.phase = String(params?.[1]); return rows([]); }
    if (/INSERT INTO session_config_grants/.test(sql)) {
      assert.deepEqual(params, [sessionId, "user-1", "50000000000"]);
      state.grantWrites++; return rows([]);
    }
    if (/INSERT INTO session_traffic_entitlements/.test(sql)) {
      if (options.failEntitlement) throw new Error("fixture entitlement failure");
      assert.deepEqual(params, [sessionId, "50000000000"]);
      state.entitlementWrites++; return rows([]);
    }
    if (/INSERT INTO (session_conditions|audit_events)/.test(sql)) {
      if (/session_config_granted/.test(sql)) state.grantAudits++;
      return rows([]);
    }
    if (/AS granted/.test(sql)) {
      assert.deepEqual(params, [sessionId, "account-1"]);
      return rows([{ granted: state.grantWrites > 0 }]);
    }
    if (/sessions.mode::text/.test(sql)) return rows([{
      id: sessionId, mode: "FullTunnel", desiredState: "Active", phase: state.phase,
      destinationCidrs: ["0.0.0.0/0"], trafficLimitBytes: "50000000000", trafficUsedBytes: state.usedBytes,
      trafficRemainingBytes: String(50_000_000_000 - Number(state.usedBytes)), trafficLimitReachedAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]);
    assert.fail(`unexpected query: ${sql}`);
  }
  const db = { query, async transaction<T>(fn: (client: { query: typeof query }) => Promise<T>) {
    const before = { ...state };
    inTransaction = true;
    try { return await fn({ query }); }
    catch (error) { Object.assign(state, before); throw error; }
    finally { inTransaction = false; }
  } } as unknown as Database;
  const paymentService = { async charge(input: { paymentId: string; sessionId: string; accountId: string }) {
    assert.deepEqual(input, { paymentId: requestId, sessionId, accountId: "account-1" });
    state.chargeCalls++;
    return { status: "in_progress" };
  } } as unknown as SolanaConfigPaymentService;
  const app = Fastify();
  registerPublicSessionsRoutes(app, {
    db, requireUser: async () => ({ id: "user-1", accountId: "account-1", email: "fixture@example.invalid", displayName: "Fixture", avatarUrl: null }),
    hasBillingAdminAccess: async () => state.admin,
    billing: { enforcePositiveBalance: options.enforceBalance ?? false, requiredMinBalanceMinor: 1, configPaymentEnabled: true, configTrafficLimitBytes: 50_000_000_000 },
    configPaymentService: options.paymentService === false ? null : paymentService,
    selfServiceAbuseControls: { maxActiveSessionsPerAccount: 5, maxSessionCreatesPerWindow: 20, sessionCreateWindowSeconds: 3600, allowPrivateDestinations: false }
  });
  return { app, state };
}
