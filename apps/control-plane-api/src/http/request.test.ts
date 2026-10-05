import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { clientIpForSecurity, clientRateLimitIdentity, detectClientIpv4 } from "./request.js";

test("direct clients cannot spoof an IP with forwarded headers", async () => {
  const app = Fastify({ trustProxy: ["127.0.0.1", "84.32.83.69"] });
  app.get("/ip", async request => ({ ip: clientIpForSecurity(request), ipv4: detectClientIpv4(request) }));
  try {
    const response = await app.inject({ url: "/ip", remoteAddress: "198.51.100.10", headers: { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8", "cf-connecting-ip": "9.9.9.9" } });
    assert.deepEqual(response.json(), { ip: "198.51.100.10", ipv4: "198.51.100.10" });
  } finally { await app.close(); }
});
test("explicit proxy chain resolves from the right and ignores untrusted left entries", async () => {
  const app = Fastify({ trustProxy: ["127.0.0.1", "84.32.83.69"] });
  app.get("/ip", async request => ({ ip: clientIpForSecurity(request) }));
  try {
    assert.equal((await app.inject({ url: "/ip", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.123,198.51.100.10,84.32.83.69" } })).json().ip, "198.51.100.10");
  } finally { await app.close(); }
});
test("IPv6 privacy addresses in the same /64 share a counter", async () => {
  const app = Fastify(); app.get("/ip", async request => ({ identity: clientRateLimitIdentity(request) }));
  try {
    const a = await app.inject({ url: "/ip", remoteAddress: "2001:db8:abcd:1234::1" });
    const b = await app.inject({ url: "/ip", remoteAddress: "2001:0db8:abcd:1234::222" });
    const c = await app.inject({ url: "/ip", remoteAddress: "2001:db8:abcd:5678::1" });
    assert.equal(a.json().identity, b.json().identity); assert.notEqual(a.json().identity, c.json().identity);
  } finally { await app.close(); }
});
