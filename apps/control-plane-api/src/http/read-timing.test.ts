import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { createReadTiming } from "./read-timing.js";

test("read timing records only named stage durations, including errors and parallel reads", async () => {
  const app = Fastify();
  app.get("/fixture", async (_request, reply) => {
    const measure = createReadTiming(reply);
    const values = await Promise.all([measure("query", async () => "private value"), measure("rpc", async () => 1)]);
    await assert.rejects(measure("failed", async () => { throw new Error("private error"); }));
    return { count: values.length };
  });
  const response = await app.inject("/fixture");
  assert.equal(response.statusCode, 200);
  const timing = String(response.headers["server-timing"]);
  for (const stage of ["query", "rpc", "failed"]) assert.match(timing, new RegExp(`${stage};dur=\\d+\\.\\d{2}`));
  assert.doesNotMatch(timing, /private/);
  await app.close();
});
