import type { FastifyReply } from "fastify";

// Names are fixed application stages, never SQL, wallet addresses or user data.
// Parallel stages overlap: their durations must not be added to calculate total time.
export function createReadTiming(reply: FastifyReply) {
  const stages = new Map<string, number>();
  return async function measure<T>(name: string, read: () => Promise<T>): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      return await read();
    } finally {
      stages.set(name, Number(process.hrtime.bigint() - start) / 1_000_000);
      reply.header("Server-Timing", Array.from(stages, ([stage, duration]) => `${stage};dur=${duration.toFixed(2)}`).join(", "));
    }
  };
}
