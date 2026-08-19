import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { insertGateAgentDeployment } from "./repository.js";

test("control-plane rollout rejects an agent that has not been bootstrapped for managed releases", async () => {
  const db: Queryable = {
    async query<Row extends object>() {
      return { rows: [{
        id: "gate-id",
        agentVersion: "0.2.2",
        agentRevision: "a".repeat(40),
        artifactSha256: "b".repeat(64),
        observedCapabilities: ["agent-artifact-self-test:passed"]
      }] as Row[], rowCount: 1 };
    }
  };

  assert.equal(await insertGateAgentDeployment(db, {
    gateId: "gate-id",
    releaseId: "release-id",
    requestedBy: "admin-id"
  }), "gate_not_bootstrapped");
});

test("control-plane rollout stores previous artifact identity and creates a gate job", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (/FROM gates\s+LEFT JOIN gate_status/.test(sql)) {
        return { rows: [{
          id: "gate-id",
          agentVersion: "0.2.1",
          agentRevision: "a".repeat(40),
          artifactSha256: "b".repeat(64),
          observedCapabilities: ["control-plane-agent-rollout:v1"]
        }] as Row[], rowCount: 1 };
      }
      if (/FROM gate_agent_releases/.test(sql)) {
        return { rows: [{
          id: "release-id",
          version: "0.2.2",
          revision: "c".repeat(40),
          builtAt: "2026-08-19T10:00:00Z",
          artifactSha256: "d".repeat(64),
          createdAt: "2026-08-19T10:01:00Z"
        }] as Row[], rowCount: 1 };
      }
      if (/INSERT INTO gate_agent_deployments/.test(sql)) {
        return { rows: [{ id: "deployment-id" }] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 1 };
    }
  };

  const result = await insertGateAgentDeployment(db, {
    gateId: "gate-id",
    releaseId: "release-id",
    requestedBy: "admin-id"
  });

  assert.equal(result, "deployment-id");
  const deploymentInsert = calls.find((call) => /INSERT INTO gate_agent_deployments/.test(call.sql));
  assert.ok(deploymentInsert);
  assert.equal(deploymentInsert.params[4], "b".repeat(64));
  const jobInsert = calls.find((call) => /INSERT INTO jobs/.test(call.sql));
  assert.ok(jobInsert);
  assert.match(String(jobInsert.params[1]), /"artifactSha256":"d{64}"/);
});
