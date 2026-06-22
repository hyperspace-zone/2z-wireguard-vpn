import assert from "node:assert/strict";
import test from "node:test";
import { gateAlertProbeHost } from "./control-plane-snapshot.js";

test("gate alert probe host comes from explicit probe URL host", () => {
  assert.equal(
    gateAlertProbeHost("https://gate-na-chi-02.hyperspace.zone/.well-known/hyperspace-probe", "152.44.43.130"),
    "gate-na-chi-02.hyperspace.zone"
  );
});

test("gate alert probe host supports IP-address probe URLs", () => {
  assert.equal(
    gateAlertProbeHost("https://203.0.113.20/.well-known/hyperspace-probe", "203.0.113.20"),
    "203.0.113.20"
  );
});

test("gate alert probe host falls back to public IPv4 when probe URL is missing or invalid", () => {
  assert.equal(gateAlertProbeHost(null, "203.0.113.20"), "203.0.113.20");
  assert.equal(gateAlertProbeHost("not-a-url", "203.0.113.20"), "203.0.113.20");
});
