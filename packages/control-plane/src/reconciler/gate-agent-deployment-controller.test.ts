import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../db/queryable.js";
import { readReleaseFailureCode, reconcileGateAgentDeployments } from "./gate-agent-deployment-controller.js";

const targetSha = "a".repeat(64);
const previousSha = "b".repeat(64);

test("deployment is verified only after the exact artifact reports a fresh successful host self-test", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db = deploymentDb(calls, deploymentRow({
    observedArtifactSha256: targetSha,
    observedCapabilities: ["agent-artifact-self-test:passed"],
    lastSeenAt: "2026-08-19T10:01:00Z",
    agentConnected: true
  }));

  const result = await reconcileGateAgentDeployments(db, new Date("2026-08-19T10:02:00Z"));

  assert.equal(result.verified, 1);
  assert.ok(calls.some((call) => /SET phase = 'succeeded'/.test(call.sql)));
  assert.ok(calls.some((call) => call.params[1] === "verified"));
});

test("matching SHA without the installed-host self-test is not accepted", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db = deploymentDb(calls, deploymentRow({
    observedArtifactSha256: targetSha,
    observedCapabilities: [],
    lastSeenAt: "2026-08-19T10:01:00Z",
    agentConnected: true
  }));

  const result = await reconcileGateAgentDeployments(db, new Date("2026-08-19T10:02:00Z"));

  assert.deepEqual(result, { verified: 0, rollbackRequested: 0, rolledBack: 0, failed: 0 });
  assert.equal(calls.length, 1);
});

test("verification timeout queues rollback to the previously observed immutable artifact", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (/ORDER BY deployments\.requested_at/.test(sql)) {
        return { rows: [deploymentRow({
          observedArtifactSha256: null,
          observedCapabilities: [],
          lastSeenAt: null,
          agentConnected: false,
          verificationDeadlineAt: "2026-08-19T09:59:00Z"
        })] as Row[], rowCount: 1 };
      }
      if (/SELECT\s+gate_id AS "gateId"/.test(sql)) {
        return { rows: [{ gateId: "gate-id", previousArtifactSha256: previousSha, phase: "verifying" }] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 1 };
    }
  };

  const result = await reconcileGateAgentDeployments(db, new Date("2026-08-19T10:02:00Z"));

  assert.equal(result.rollbackRequested, 1);
  assert.ok(calls.some((call) => /SELECT 'rollback_agent'/.test(call.sql)));
  assert.ok(calls.some((call) => call.params[1] === "rollback_requested"));
});

test("automatic rollback records the post-install failure reported by the restored agent", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db = deploymentDb(calls, deploymentRow({
    observedArtifactSha256: previousSha,
    observedCapabilities: [`agent-release-failure:post_install_self_test_failed:${targetSha}`],
    lastSeenAt: "2026-08-19T10:01:00Z",
    agentConnected: true
  }));

  const result = await reconcileGateAgentDeployments(db, new Date("2026-08-19T10:02:00Z"));

  assert.equal(result.rolledBack, 1);
  const update = calls.find((call) => /SET phase = 'rolled_back'/.test(call.sql));
  assert.equal(update?.params[1], "post_install_self_test_failed");
});

test("release failure capability must match the exact deployment artifact", () => {
  assert.equal(
    readReleaseFailureCode([`agent-release-failure:service_start_failed:${targetSha}`], targetSha),
    "service_start_failed"
  );
  assert.equal(
    readReleaseFailureCode([`agent-release-failure:service_start_failed:${previousSha}`], targetSha),
    null
  );
});

function deploymentDb(
  calls: Array<{ sql: string; params: readonly unknown[] }>,
  row: Record<string, unknown>
): Queryable {
  return {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (/ORDER BY deployments\.requested_at/.test(sql)) {
        return { rows: [row] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 1 };
    }
  };
}

function deploymentRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "deployment-id",
    gateId: "gate-id",
    gateName: "gate-eu-lon-01",
    phase: "verifying",
    targetArtifactSha256: targetSha,
    previousArtifactSha256: previousSha,
    stagedAt: "2026-08-19T10:00:00Z",
    verificationDeadlineAt: "2026-08-19T10:05:00Z",
    observedArtifactSha256: null,
    observedInstalledAt: "2026-08-19T10:00:30Z",
    lastSeenAt: null,
    observedCapabilities: [],
    agentConnected: false,
    rollbackAttemptCount: 0,
    ...overrides
  };
}
