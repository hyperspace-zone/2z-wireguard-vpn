import { Worker } from "node:worker_threads";
import type { PublicTradingLatencyResponse, PublicGateBenchmarkMatrixResponse } from "@hyperspace-zone/contracts";
import type { TradingPairsSnapshot } from "./service.js";

// The pair combinator is CPU-heavy. Keep it off the HTTP event loop, including
// forced fresh revalidation; a display snapshot is never authorization input.
export function createSnapshotBuilder() {
  let worker: Worker | undefined;
  let closed = false;
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: TradingPairsSnapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function fail(error: Error) {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
    pending.clear();
    const failed = worker; worker = undefined;
    void failed?.terminate();
  }
  function ensureWorker(): Worker {
    if (worker) return worker;
    const active = new Worker(new URL("./snapshot-builder.worker.js", import.meta.url), { execArgv: [] });
    worker = active;
    active.on("message", (message: { id: number; metadataBuffer?: ArrayBuffer; rowBuffers?: ArrayBuffer[]; error?: string }) => {
      const task = pending.get(message.id); if (!task) return;
      if (message.metadataBuffer && message.rowBuffers) {
        void decodeSnapshotParts(message.metadataBuffer, message.rowBuffers, () => pending.get(message.id) === task).then(snapshot => {
          if (pending.get(message.id) !== task) return;
          clearTimeout(task.timer); pending.delete(message.id); task.resolve(snapshot);
        }).catch(() => {
          if (pending.get(message.id) !== task) return;
          clearTimeout(task.timer); pending.delete(message.id); task.reject(new Error("Trading snapshot result is invalid"));
        });
      } else {
        clearTimeout(task.timer); pending.delete(message.id); task.reject(new Error("Trading snapshot calculation failed"));
      }
    });
    active.on("error", () => { if (worker === active) fail(new Error("Trading snapshot worker failed")); });
    active.on("exit", () => { if (worker === active) fail(new Error("Trading snapshot worker exited")); });
    active.unref();
    return active;
  }
  return {
    build(latency: PublicTradingLatencyResponse, matrix: PublicGateBenchmarkMatrixResponse, now = Date.now()): Promise<TradingPairsSnapshot> {
      if (closed) return Promise.reject(new Error("Trading snapshot builder is closed"));
      if (pending.size >= 4) return Promise.reject(new Error("Trading snapshot builder is busy"));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => fail(new Error("Trading snapshot calculation timed out")), 5000);
        pending.set(id, { resolve, reject, timer });
        try { ensureWorker().postMessage({ id, latency, matrix, now }); }
        catch { fail(new Error("Trading snapshot calculation could not start")); }
      });
    },
    async close() {
      closed = true;
      const active = worker;
      fail(new Error("Trading snapshot builder is closed"));
      await active?.terminate();
    }
  };
}

// Large snapshots must not turn result delivery into another HTTP event-loop
// pause. Decode bounded row chunks, yield between ~4ms work slices, and publish
// only the complete snapshot. Cancellation/timeout also cancels queued decoding.
export function decodeSnapshotParts(metadata: ArrayBuffer, chunks: ArrayBuffer[], active: () => boolean = () => true): Promise<TradingPairsSnapshot> {
  return new Promise((resolve, reject) => {
    let snapshot: TradingPairsSnapshot | undefined;
    let offset = 0;
    const step = () => {
      if (!active()) { reject(new Error("Trading snapshot decoding cancelled")); return; }
      try {
        const start = process.hrtime.bigint();
        if (!snapshot) snapshot = { ...JSON.parse(Buffer.from(metadata).toString("utf8")), rows: [] } as TradingPairsSnapshot;
        let decodedChunks = 0;
        while (offset < chunks.length && decodedChunks++ < 4 && process.hrtime.bigint() - start < 4_000_000n) {
          const rows = JSON.parse(Buffer.from(chunks[offset++]!).toString("utf8")) as TradingPairsSnapshot["rows"];
          if (!Array.isArray(rows)) throw new Error("Invalid snapshot rows");
          snapshot.rows.push(...rows);
        }
        if (offset === chunks.length) resolve(snapshot);
        else setImmediate(step);
      } catch { reject(new Error("Trading snapshot result is invalid")); }
    };
    setImmediate(step);
  });
}
