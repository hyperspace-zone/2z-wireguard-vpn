import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

export type GateAgentArtifactResponse = {
  data: Buffer;
  contentEncoding?: "gzip";
};

export async function encodeGateAgentArtifact(
  data: Buffer,
  acceptEncoding: string | string[] | undefined
): Promise<GateAgentArtifactResponse> {
  if (!acceptsGzip(acceptEncoding)) return { data };
  const compressed = await gzipAsync(data, { level: 6 });
  return compressed.length < data.length
    ? { data: compressed, contentEncoding: "gzip" }
    : { data };
}

function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  return value.split(",").some((entry) => {
    const [coding, ...parameters] = entry.trim().toLowerCase().split(";");
    if (coding !== "gzip") return false;
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    if (!quality) return true;
    const parsed = Number(quality.slice(2));
    return Number.isFinite(parsed) && parsed > 0;
  });
}
