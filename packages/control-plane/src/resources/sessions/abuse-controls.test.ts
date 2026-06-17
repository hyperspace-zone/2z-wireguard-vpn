import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultSessionAbuseControlConfig,
  validateSessionAbusePolicy
} from "./abuse-controls.js";
import { parseSessionCreateBody, type SessionCreateParsed } from "./validation.js";

test("self-service IP-to-IP configs allow public IPv4 /32 destinations", () => {
  const parsed = parseValidSession({
    mode: "IpToIp",
    targetIp: "1.1.1.1",
    ingressGateName: "gate-a",
    egressGateName: "gate-b"
  });

  assert.equal(validateSessionAbusePolicy(parsed, defaultSessionAbuseControlConfig), null);
});

test("self-service IP-to-IP configs reject private destinations", () => {
  const parsed = parseValidSession({
    mode: "IpToIp",
    targetIp: "10.0.0.10",
    ingressGateName: "gate-a",
    egressGateName: "gate-b"
  });

  const error = validateSessionAbusePolicy(parsed, defaultSessionAbuseControlConfig);
  assert.equal(error?.error, "destination_not_allowed");
});

test("self-service IP-to-IP configs reject broad destination CIDRs", () => {
  const parsed = parseValidSession({
    mode: "IpToIp",
    destinationCidrs: ["8.8.8.0/24"],
    ingressGateName: "gate-a",
    egressGateName: "gate-b"
  });

  const error = validateSessionAbusePolicy(parsed, defaultSessionAbuseControlConfig);
  assert.equal(error?.error, "invalid_destination_cidr");
});

test("full-tunnel self-service configs allow unrestricted source access", () => {
  const parsed = parseValidSession({
    mode: "FullTunnel",
    ingressGateName: "gate-a",
    egressGateName: "gate-b"
  });

  assert.equal(validateSessionAbusePolicy(parsed, defaultSessionAbuseControlConfig), null);
});

test("source restrictions may be private or broad when explicitly requested", () => {
  const parsed = parseValidSession({
    mode: "FullTunnel",
    sourceCidr: "192.168.0.0/16",
    ingressGateName: "gate-a",
    egressGateName: "gate-b"
  });

  assert.equal(validateSessionAbusePolicy(parsed, defaultSessionAbuseControlConfig), null);
});

test("source restrictions must still be valid IPv4 CIDRs", () => {
  const parsed = parseValidSession({
    mode: "FullTunnel",
    sourceCidr: "999.0.0.1/32",
    ingressGateName: "gate-a",
    egressGateName: "gate-b"
  });

  const error = validateSessionAbusePolicy(parsed, defaultSessionAbuseControlConfig);
  assert.equal(error?.error, "invalid_source_cidr");
});

function parseValidSession(body: Record<string, unknown>): SessionCreateParsed {
  const parsed = parseSessionCreateBody(body);
  if ("error" in parsed) {
    assert.fail(`expected valid session body, got ${parsed.error}`);
  }
  return parsed;
}
