export interface GateReadiness {
  ready: boolean;
  reason: string;
  message: string;
}

export function evaluateGateReadiness(input: {
  capabilities: string[];
  doubleZero: Record<string, unknown>;
  publicEndpoint: string;
  doubleZeroEnv: string;
  hostReady: boolean;
}): GateReadiness {
  if (!input.hostReady) {
    return {
      ready: false,
      reason: "HostToolsMissing",
      message: "Gate host is missing required WireGuard, iproute2, or nft tools"
    };
  }
  if (!input.capabilities.includes("doublezero0:up")) {
    return {
      ready: false,
      reason: "DoubleZeroInterfaceDown",
      message: "doublezero0 is not up"
    };
  }
  const tunnelStatus = readString(input.doubleZero, "tunnelStatus");
  if (tunnelStatus !== "BGP Session Up") {
    return {
      ready: false,
      reason: "DoubleZeroTunnelDown",
      message: `DoubleZero tunnel is not BGP Session Up${tunnelStatus ? `: ${tunnelStatus}` : ""}`
    };
  }
  const network = readString(input.doubleZero, "network");
  if (network !== input.doubleZeroEnv) {
    return {
      ready: false,
      reason: "DoubleZeroEnvMismatch",
      message: `DoubleZero network ${network || "unknown"} does not match catalog environment ${input.doubleZeroEnv}`
    };
  }
  const tunnelSrc = readString(input.doubleZero, "tunnelSrc");
  if (tunnelSrc !== input.publicEndpoint) {
    return {
      ready: false,
      reason: "DoubleZeroTunnelSourceMismatch",
      message: `DoubleZero tunnel source ${tunnelSrc || "unknown"} does not match gate public endpoint ${input.publicEndpoint}`
    };
  }
  return {
    ready: true,
    reason: "DoubleZeroReady",
    message: "Gate host tools and DoubleZero tunnel are ready"
  };
}

export function readGateDoubleZeroEnv(spec: Record<string, unknown>): string {
  const value = readString(spec, "doubleZeroEnv");
  return value || "testnet";
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}
