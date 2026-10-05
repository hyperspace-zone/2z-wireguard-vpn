import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

for (const role of ["app", "control-plane"]) {
  const config = readFileSync(new URL(`../../infra/caddy/Caddyfile.${role}.mainnet.example`, import.meta.url), "utf8");
  test(`${role}: access and error logs remove credentials and bound disk use`, () => {
    assert.equal(config.match(/request>headers delete/g)?.length, 2);
    assert.equal(config.match(/resp_headers delete/g)?.length, 2);
    assert.match(config, /roll_size 10MiB/); assert.match(config, /roll_keep 10/); assert.match(config, /roll_keep_for 168h/);
    const pattern = config.match(/request>uri regexp "([^"]+)" "\[redacted\]"/)[1];
    const redact = uri => uri.replace(new RegExp(pattern, "g"), "[redacted]");
    assert.equal(redact("/api/v1/public/artifacts/download/private-token?secret=private-query"), "/api/v1/public[redacted][redacted]");
    assert.equal(redact("/v1/public/auth/google/callback?code=private-code&state=private-state"), "/v1/public/auth/google/callback[redacted]");
    assert.match(config, /http:\/\/[^\s]+ \{\s*(?:#[^\n]*\n\s*)?skip_log\s+redir /);
    assert.match(config, /skip_log @non_auth/);
  });
}
test("proxy policy rejects arbitrary forwarding headers and trusts only the web host", () => {
  const web = readFileSync(new URL("../../infra/caddy/Caddyfile.app.mainnet.example", import.meta.url), "utf8");
  const api = readFileSync(new URL("../../infra/caddy/Caddyfile.control-plane.mainnet.example", import.meta.url), "utf8");
  assert.match(web, /header_up X-Forwarded-For \{remote_host\}/);
  assert.match(api, /trusted_proxies 84\.32\.83\.69 10\.179\.228\.36/);
  for (const config of [web, api]) { assert.match(config, /header_up -X-Real-IP/); assert.match(config, /header_up -CF-Connecting-IP/); }
});
