import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
test('origin installer refuses unproxied DNS, targets only web, and preserves unrelated firewall tables', () => {
  const installer = read('scripts/security/enable-cloudflare-web-origin');
  const nft = read('infra/security/cloudflare-web-origin.nft');
  const unit = read('infra/systemd/hyperspace-web-origin.service');
  assert.match(installer, /--proxy-verified/);
  assert.match(installer, /not all\(any\(ipaddress\.ip_address/);
  assert.match(installer, /84\[\.\]32\[\.\]83\[\.\]69/);
  assert.doesNotMatch(nft + installer + unit, /flush ruleset|ufw enable|dport 22/);
  assert.match(nft, /policy accept/);
  assert.match(nft, /10\.179\.228\.19/);
  assert.match(unit, /WantedBy=multi-user.target/);
});
test('Cloudflare ranges agree between web proxy trust and web origin allowlist', () => {
  const web = read('infra/caddy/Caddyfile.app.mainnet.example');
  const nft = read('infra/security/cloudflare-web-origin.nft');
  const ranges = web.match(/@from_cloudflare remote_ip ([^\n]+)/)[1].trim().split(/\s+/);
  const nftRanges = nft.match(/[0-9a-f:.]+\/\d+/g);
  assert.deepEqual(new Set(nftRanges), new Set(ranges));
});
