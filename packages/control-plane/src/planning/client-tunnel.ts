import { createHash, randomBytes, randomInt } from "node:crypto";
import type { ClientProtocol } from "@hyperspace-zone/contracts";

export const amneziaWGCapability = "client-tunnel:amneziawg-3.1";

export function readSessionClientProtocol(value: unknown): ClientProtocol {
  if (value === undefined || value === "wireguard") return "wireguard";
  if (value === "amneziawg") return "amneziawg";
  throw new Error("unsupported client protocol");
}

export function sessionClientProtocolLabel(spec: Record<string, unknown>): string {
  return readSessionClientProtocol(spec.clientProtocol) === "amneziawg" ? "AmneziaWG 3.1" : "WireGuard";
}

export interface AmneziaWGParameters {
  Jc: number;
  Jmin: number;
  Jmax: number;
  S1: number;
  S2: number;
  S3: number;
  S4: number;
  H1: string;
  H2: string;
  H3: string;
  H4: string;
  ContentPaddingAddition: string;
  RekeyAfterTime: string;
  RekeyTimeout: string;
  KeepaliveTimeout: string;
  RandomTrailers: "on";
}

export type ClientTunnel = { protocol: "wireguard" } | {
  protocol: "amneziawg";
  version: "3.1";
  headerProtectionKeySha256: string;
  parameters: AmneziaWGParameters;
};

export function createClientTunnel(): { tunnel: ClientTunnel; headerProtectionKey: string } {
  const headerProtectionKey = randomBytes(32).toString("base64");
  // Equal prefixes are recommended by upstream when RandomTrailers is enabled.
  const prefix = randomInt(16, 49);
  return {
    headerProtectionKey,
    tunnel: {
      protocol: "amneziawg",
      version: "3.1",
      headerProtectionKeySha256: keyFingerprint(headerProtectionKey),
      parameters: {
        Jc: randomInt(4, 13), Jmin: 40, Jmax: 1000,
        S1: prefix, S2: prefix, S3: prefix, S4: prefix,
        // Header Protection conceals the standard message types.
        H1: "1", H2: "2", H3: "3", H4: "4",
        ContentPaddingAddition: "0-64",
        RekeyAfterTime: "100-140", RekeyTimeout: "4-7", KeepaliveTimeout: "8-15",
        RandomTrailers: "on"
      }
    }
  };
}

/** An absent field belongs to an immutable, previously issued WireGuard plan. */
export function readClientTunnel(value: unknown): ClientTunnel {
  if (value === undefined) return { protocol: "wireguard" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid client tunnel");
  const tunnel = value as Record<string, unknown>;
  if (tunnel.protocol === "wireguard") return { protocol: "wireguard" };
  if (tunnel.protocol !== "amneziawg" || tunnel.version !== "3.1") throw new Error("unsupported client tunnel protocol/version");
  if (typeof tunnel.headerProtectionKeySha256 !== "string" || !/^[a-f0-9]{64}$/.test(tunnel.headerProtectionKeySha256)) {
    throw new Error("invalid AmneziaWG key fingerprint");
  }
  const p = tunnel.parameters as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("missing AmneziaWG parameters");
  for (const [key, min, max] of [
    ["Jc", 1, 128], ["Jmin", 1, 1280], ["Jmax", 1, 1280],
    ["S1", 12, 64], ["S2", 12, 64], ["S3", 12, 64], ["S4", 12, 64]
  ] as const) {
    const v = p[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`invalid AmneziaWG ${key}`);
  }
  if (Number(p.Jmin) >= Number(p.Jmax)) throw new Error("invalid AmneziaWG junk size range");
  if (p.S1 !== p.S2 || p.S1 !== p.S3 || p.S1 !== p.S4) throw new Error("AmneziaWG prefixes must match for random trailers");
  for (const [key, expected] of [["H1", "1"], ["H2", "2"], ["H3", "3"], ["H4", "4"], ["RandomTrailers", "on"]] as const) {
    if (p[key] !== expected) throw new Error(`invalid AmneziaWG ${key}`);
  }
  for (const [key, min, max] of [
    ["ContentPaddingAddition", 0, 64], ["RekeyAfterTime", 60, 150],
    ["RekeyTimeout", 1, 15], ["KeepaliveTimeout", 1, 30]
  ] as const) {
    const v = p[key];
    if (typeof v !== "string" || !/^\d+-\d+$/.test(v)) throw new Error(`invalid AmneziaWG ${key}`);
    const [low = NaN, high = NaN] = v.split("-").map(Number);
    if (low < min || high > max || low > high || v !== `${low}-${high}`) throw new Error(`invalid AmneziaWG ${key}`);
  }
  // Return only supported fields; arbitrary input cannot inject config lines.
  return {
    protocol: "amneziawg", version: "3.1", headerProtectionKeySha256: tunnel.headerProtectionKeySha256,
    parameters: Object.fromEntries(amneziaWGParameterNames.map(key => [key, p[key]])) as unknown as AmneziaWGParameters
  };
}

const amneziaWGParameterNames = [
  "Jc", "Jmin", "Jmax", "S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4",
  "ContentPaddingAddition", "RekeyAfterTime", "RekeyTimeout", "KeepaliveTimeout", "RandomTrailers"
] as const;

export function validateHeaderProtectionKey(tunnel: ClientTunnel, value: unknown): string {
  if (tunnel.protocol !== "amneziawg") return "";
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
      Buffer.from(value, "base64").toString("base64") !== value || keyFingerprint(value) !== tunnel.headerProtectionKeySha256) {
    throw new Error("missing or mismatched AmneziaWG header protection key");
  }
  return value;
}

function keyFingerprint(key: string): string {
  return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
}
