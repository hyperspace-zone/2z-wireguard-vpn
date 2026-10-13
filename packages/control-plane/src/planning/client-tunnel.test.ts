import assert from "node:assert/strict";
import test from "node:test";
import { decryptJsonPayload } from "@hyperspace-zone/shared";
import { readClientTunnel, validateHeaderProtectionKey, type ClientTunnel } from "./client-tunnel.js";
import { renderWireGuardPlan } from "./render-plan.js";
import { renderClientConfig } from "../resources/artifacts/client-config.js";
import { withClientTunnelSecret } from "../resources/jobs/client-tunnel-secret.js";
import { prepareClientConfigArtifact } from "../resources/artifacts/service.js";
import type { Queryable } from "../db/queryable.js";

const encryptionKey = Buffer.alloc(32, 7);
const path = { ingressGateId: "in", ingressGateName: "ingress", ingressPublicIpv4: "192.0.2.1", egressGateId: "out", egressGateName: "egress", egressPublicIpv4: "192.0.2.2" };
const session = { id: "session", generation: 1, mode: "FullTunnel", destinationCidrs: ["0.0.0.0/0"], sourceCidr: null, clientPublicKey: null, spec: { clientProtocol: "amneziawg" } };

for (const ownKey of [false, true]) {
  test(`AmneziaWG secrets reach only ingress and encrypted client artifact (own key: ${ownKey})`, async () => {
    const plan = renderWireGuardPlan({ ...session, clientPublicKey: ownKey ? "client-public-key" : null }, path, "10.42.0.2/32", encryptionKey);
    const tunnel = readClientTunnel(plan.publicMaterial.clientTunnel);
    assert.equal(tunnel.protocol, "amneziawg");
    assert.ok(plan.secretPayload);
    const secret = decryptJsonPayload<Record<string, unknown>>(plan.secretPayload, encryptionKey);
    assert.ok(validateHeaderProtectionKey(tunnel, secret.headerProtectionKey));
    assert.ok(!JSON.stringify(plan.publicMaterial).includes(String(secret.headerProtectionKey)));
    const writes: Array<{ sql: string; params: readonly unknown[] }> = [];
    const ingressMaterial: { clientTunnel: ClientTunnel; wireGuard: Record<string, unknown> } = { clientTunnel: tunnel, wireGuard: { clientPublicKey: "server-public-key", clientListenPort: 51820 } };
    const db: Queryable = {
      async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
        let rows: unknown[] = [];
        if (sql.includes("FROM rendered_plans")) rows = [{ id: "plan", publicMaterial: plan.publicMaterial }];
        else if (sql.includes("FROM rendered_plan_secrets")) rows = [plan.secretPayload];
        else if (sql.includes("FROM gate_assignments")) rows = [
          { role: "Ingress", gateName: "ingress", publicIpv4: "192.0.2.1", localMaterial: ingressMaterial },
          { role: "Egress", gateName: "egress", publicIpv4: "192.0.2.2", localMaterial: { wireGuard: { transitPublicKey: "egress-key" } } }
        ];
        else { writes.push({ sql, params }); if (sql.includes("INSERT INTO artifacts")) rows = [{ id: "artifact" }]; }
        return { rows: rows as Row[], rowCount: rows.length };
      }
    };
    const payload = { role: "Ingress", operation: "prepare", plan: { planId: "plan", publicMaterial: plan.publicMaterial } };
    const delivered = await withClientTunnelSecret(db, { type: "apply_assignment", payload }, encryptionKey) as Record<string, unknown>;
    assert.deepEqual(delivered.clientTunnelSecret, { headerProtectionKey: secret.headerProtectionKey });
    assert.ok(!("clientTunnelSecret" in payload));
    assert.ok(!JSON.stringify(delivered).includes(String(secret.clientPrivateKey ?? "never-present-private-key")));
    const egressPayload = { ...payload, role: "Egress" };
    assert.equal(await withClientTunnelSecret(db, { type: "apply_assignment", payload: egressPayload }, encryptionKey), egressPayload);
    await assert.rejects(withClientTunnelSecret(db, { type: "apply_assignment", payload }), /not configured/);

    await prepareClientConfigArtifact(db, "session", 1, encryptionKey);
    const publicWrite = writes.find(w => w.sql.includes("INSERT INTO artifacts"))!;
    assert.ok(!JSON.stringify(publicWrite).includes(String(secret.headerProtectionKey)));
    const encryptedWrite = writes.find(w => w.sql.includes("INSERT INTO artifact_payloads"))!;
    const [, encryptionMethod, nonce, ciphertext, authTag, aad, keyFingerprint] = encryptedWrite.params;
    const artifact = decryptJsonPayload<{ configText: string }>({
      encryptionMethod: "aes-256-gcm", nonce: String(nonce), ciphertext: String(ciphertext),
      authTag: String(authTag), aad: String(aad), keyFingerprint: String(keyFingerprint)
    }, encryptionKey);
    assert.equal(encryptionMethod, "aes-256-gcm");
    assert.match(artifact.configText, /MTU = 1280/);
    assert.match(artifact.configText, /RandomTrailers = on/);
    assert.ok(artifact.configText.includes(`HeaderProtectionKey = ${secret.headerProtectionKey}`));
    assert.match(artifact.configText, /Endpoint = 192\.0\.2\.1:51820/);
    const [interfaceSection, peerSection] = artifact.configText.split("[Peer]");
    assert.match(interfaceSection!, /S4 = /);
    assert.doesNotMatch(peerSection!, /HeaderProtection|Jc|RandomTrailers/);
    if (ownKey) assert.match(artifact.configText, /<replace-with-matching-client-private-key>/);
    else assert.ok(artifact.configText.includes(`PrivateKey = ${secret.clientPrivateKey}`));

    // A stale/old ingress must never produce an apparently usable extended WireGuard artifact.
    ingressMaterial.clientTunnel = { protocol: "wireguard" };
    await assert.rejects(prepareClientConfigArtifact(db, "session", 1, encryptionKey), /does not match/);
  });
}

test("legacy plans/configs stay WireGuard; unknown or malformed profiles never downgrade", () => {
  assert.deepEqual(readClientTunnel(undefined), { protocol: "wireguard" });
  const config = renderClientConfig({ privateKey: "private", clientPublicKey: "public", clientKeyMode: "ServerGenerated", address: "10.42.0.2/32", serverPublicKey: "server", endpoint: "192.0.2.1:51820", allowedIps: ["0.0.0.0/0"], persistentKeepaliveSeconds: 25 });
  assert.doesNotMatch(config, /AmneziaWG|HeaderProtection|Jc|S4/);
  for (const value of [null, {}, { protocol: "unknown" }, { protocol: "amneziawg", version: "1" }]) {
    assert.throws(() => readClientTunnel(value));
  }
  const plan = renderWireGuardPlan(session, path, "10.42.0.2/32", encryptionKey);
  const tunnel = readClientTunnel(plan.publicMaterial.clientTunnel);
  assert.equal(tunnel.protocol, "amneziawg");
  if (tunnel.protocol !== "amneziawg") return;
  assert.throws(() => readClientTunnel({ ...tunnel, parameters: { ...tunnel.parameters, S4: 1500 } }));
  assert.throws(() => readClientTunnel({ ...tunnel, parameters: { ...tunnel.parameters, H1: "1\nPostUp = bad" } }));
  assert.throws(() => validateHeaderProtectionKey(tunnel, Buffer.alloc(32).toString("base64")), /mismatched/);
});

for (const clientProtocol of [undefined, "wireguard"]) {
  for (const ownKey of [false, true]) {
    test(`new ${clientProtocol ?? "default WG"} plans issue ordinary configs (own key: ${ownKey})`, async () => {
      const plan = renderWireGuardPlan({ ...session, spec: { clientProtocol }, clientPublicKey: ownKey ? "client-public-key" : null }, path, "10.42.0.2/32", encryptionKey);
      assert.deepEqual(plan.publicMaterial.clientTunnel, { protocol: "wireguard" });
      assert.equal(plan.publicMaterial.mtu, 1420);
      assert.deepEqual(Object.keys(plan.secretRefs), ownKey ? [] : ["clientPrivateKey"]);
      assert.equal(Boolean(plan.secretPayload), !ownKey);
      const secret = plan.secretPayload ? decryptJsonPayload<Record<string, unknown>>(plan.secretPayload, encryptionKey) : {};
      assert.equal(secret.headerProtectionKey, undefined);
      const writes: Array<{ sql: string; params: readonly unknown[] }> = [];
      const db: Queryable = { async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
        let rows: unknown[] = [];
        if (sql.includes("FROM rendered_plans")) rows = [{ id: "plan", publicMaterial: plan.publicMaterial }];
        else if (sql.includes("FROM rendered_plan_secrets")) rows = plan.secretPayload ? [plan.secretPayload] : [];
        else if (sql.includes("FROM gate_assignments")) rows = [
          // Old agents omit clientTunnel. A newly rendered WG plan must work with them.
          { role: "Ingress", gateName: "ingress", publicIpv4: "192.0.2.1", localMaterial: { wireGuard: { clientPublicKey: "server-key", clientListenPort: 51820 } } },
          { role: "Egress", gateName: "egress", publicIpv4: "192.0.2.2", localMaterial: {} }
        ];
        else { writes.push({ sql, params }); if (sql.includes("INSERT INTO artifacts")) rows = [{ id: "artifact" }]; }
        return { rows: rows as Row[], rowCount: rows.length };
      } };
      const payload = { role: "Ingress", operation: "prepare", plan: { planId: "plan", publicMaterial: plan.publicMaterial } };
      assert.equal(await withClientTunnelSecret(db, { type: "apply_assignment", payload }), payload);
      await prepareClientConfigArtifact(db, "session", 1, encryptionKey);
      const [, , nonce, ciphertext, authTag, aad, keyFingerprint] = writes.find(w => w.sql.includes("INSERT INTO artifact_payloads"))!.params;
      const artifact = decryptJsonPayload<{ configText: string; clientProtocol: string }>({
        encryptionMethod: "aes-256-gcm", nonce: String(nonce), ciphertext: String(ciphertext),
        authTag: String(authTag), aad: String(aad), keyFingerprint: String(keyFingerprint)
      }, encryptionKey);
      assert.equal(artifact.clientProtocol, "wireguard");
      assert.doesNotMatch(artifact.configText, /AmneziaWG|HeaderProtectionKey|RandomTrailers|Jc|S4/);
      assert.match(artifact.configText, /Endpoint = 192\.0\.2\.1:51820/);
      assert.ok(artifact.configText.includes(ownKey ? "<replace-with-matching-client-private-key>" : String(secret.clientPrivateKey)));
    });
  }
}
