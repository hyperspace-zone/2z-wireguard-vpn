import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
test('public read rollout stages a backup, verifies imports and dashboard health, and leaves core worker/SQL data untouched', () => {
  const s = readFileSync(new URL('./deploy-public-read-snapshots', import.meta.url), 'utf8');
  assert.ok(s.indexOf('await import(') < s.indexOf('changed=true'));
  assert.ok(s.indexOf('cp -a "$live"') < s.indexOf('changed=true'));
  assert.match(s, /trap on_exit EXIT/);
  assert.match(s, /v1\/public\/benchmarks\/gate-matrix v1\/public\/trading\/latency/);
  assert.doesNotMatch(s, /TRUNCATE|seed-mongo|db:migrate|systemctl (?:restart|stop) hyperspace-control-plane-worker/);
});
