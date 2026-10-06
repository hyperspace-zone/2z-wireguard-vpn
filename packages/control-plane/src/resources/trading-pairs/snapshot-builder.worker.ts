import { parentPort } from "node:worker_threads";
import { buildTradingPairsSnapshot } from "./service.js";
import type { PublicTradingLatencyResponse, PublicGateBenchmarkMatrixResponse } from "@hyperspace-zone/contracts";

parentPort?.on("message", (message: { id: number; latency: PublicTradingLatencyResponse; matrix: PublicGateBenchmarkMatrixResponse; now: number }) => {
  try {
    // Transfer bounded byte buffers rather than structured-cloning thousands
    // of nested rows. Encoding happens here; HTTP decoding yields between chunks.
    const { rows, ...metadata } = buildTradingPairsSnapshot(message.latency, message.matrix, message.now);
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
    const metadataBuffer = encode(metadata);
    const rowBuffers: ArrayBuffer[] = [];
    for (let offset = 0; offset < rows.length; offset += 64) rowBuffers.push(encode(rows.slice(offset, offset + 64)));
    parentPort!.postMessage({ id: message.id, metadataBuffer, rowBuffers }, [metadataBuffer, ...rowBuffers]);
  }
  catch { parentPort!.postMessage({ id: message.id, error: "calculation_failed" }); }
});
