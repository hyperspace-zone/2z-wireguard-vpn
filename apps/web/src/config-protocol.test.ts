import assert from "node:assert/strict";
import test from "node:test";
import { configProtocolFromSearch, createConfigPath, pendingConfigPath } from "./config-protocol.js";

test("only the explicit hidden URL opts into AWG; malformed URLs cannot downgrade", () => {
  assert.equal(configProtocolFromSearch(""), "wireguard");
  assert.equal(configProtocolFromSearch("?protocol=wireguard"), "wireguard");
  assert.equal(configProtocolFromSearch("?protocol=amnezia&tradingRoute=abc"), "amneziawg");
  for (const search of ["?protocol=", "?protocol=awg", "?protocol=amneziawg", "?protocol=Amnezia", "?protocol=amnezia&protocol=wireguard"]) {
    assert.equal(configProtocolFromSearch(search), null);
  }
  assert.equal(createConfigPath("wireguard"), "/create-config");
  assert.equal(createConfigPath("amneziawg"), "/create-config?protocol=amnezia");
});

test("the sign-in return path preserves protocol and route, expires and stays local", () => {
  const now = 123456789;
  const path = createConfigPath("amneziawg", "a".repeat(64));
  const stored = (path: string, createdAt = now - 1) => JSON.stringify({ path, createdAt });
  assert.equal(pendingConfigPath(stored(path), now), path);
  assert.equal(pendingConfigPath(stored(path, now - 86400000), now), null);
  assert.equal(pendingConfigPath(stored(path, now + 1), now), null);
  for (const path of ["https://evil.example/create-config", "//evil.example/create-config", "/create-config/../login", "/login", "/create-config#token=bad"]) {
    assert.equal(pendingConfigPath(stored(path), now), null);
  }
  assert.equal(pendingConfigPath("bad", now), null);
});
