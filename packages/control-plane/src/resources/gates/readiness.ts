export interface GateReadiness {
  ready: boolean;
  reason: string;
  message: string;
  doubleZeroReady: boolean;
  doubleZeroReason: string;
  doubleZeroMessage: string;
}

export function evaluateGateReadiness(input: {
  capabilities: string[];
  doubleZero: Record<string, unknown>;
  publicIpv4: string;
  doubleZeroEnv: string;
  hostReady: boolean;
}): GateReadiness {
  if (!input.hostReady) {
    return {
      ready: false,
      reason: "HostToolsMissing",
      message: "Gate host is missing required WireGuard, iproute2, or nft tools",
      doubleZeroReady: false,
      doubleZeroReason: "HostToolsMissing",
      doubleZeroMessage: "Gate host must be ready before DoubleZero can be used for scheduling"
    };
  }
  if (!input.capabilities.includes("doublezero0:up")) {
    return {
      ready: true,
      reason: "HostReady",
      message: "Gate agent heartbeat is fresh and required host tools are present",
      doubleZeroReady: false,
      doubleZeroReason: "DoubleZeroInterfaceDown",
      doubleZeroMessage: "doublezero0 is not up"
    };
  }
  const tunnelStatus = readString(input.doubleZero, "tunnelStatus");
  if (tunnelStatus !== "BGP Session Up") {
    return {
      ready: true,
      reason: "HostReady",
      message: "Gate agent heartbeat is fresh and required host tools are present",
      doubleZeroReady: false,
      doubleZeroReason: "DoubleZeroTunnelDown",
      doubleZeroMessage: `DoubleZero tunnel is not BGP Session Up${tunnelStatus ? `: ${tunnelStatus}` : ""}`
    };
  }
  const network = readString(input.doubleZero, "network");
  if (network !== input.doubleZeroEnv) {
    return {
      ready: true,
      reason: "HostReady",
      message: "Gate agent heartbeat is fresh and required host tools are present",
      doubleZeroReady: false,
      doubleZeroReason: "DoubleZeroEnvMismatch",
      doubleZeroMessage: `DoubleZero network ${network || "unknown"} does not match catalog environment ${input.doubleZeroEnv}`
    };
  }
  const tunnelSrc = readString(input.doubleZero, "tunnelSrc");
  if (tunnelSrc !== input.publicIpv4) {
    return {
      ready: true,
      reason: "HostReady",
      message: "Gate agent heartbeat is fresh and required host tools are present",
      doubleZeroReady: false,
      doubleZeroReason: "DoubleZeroTunnelSourceMismatch",
      doubleZeroMessage: `DoubleZero tunnel source ${tunnelSrc || "unknown"} does not match gate public IPv4 ${input.publicIpv4}`
    };
  }
  return {
    ready: true,
    reason: "HostReady",
    message: "Gate agent heartbeat is fresh and required host tools are present",
    doubleZeroReady: true,
    doubleZeroReason: "DoubleZeroReady",
    doubleZeroMessage: "DoubleZero tunnel is connected and matches the gate catalog"
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
