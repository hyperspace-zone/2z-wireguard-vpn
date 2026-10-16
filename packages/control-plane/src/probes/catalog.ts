import type { GateSummary, TradingProbeTarget, PublicTradingLatencyResponse } from "@hyperspace-zone/contracts";
import { amneziaWGCapability } from "../planning/client-tunnel.js";

// These are JSON rows from a bounded, read-only core snapshot. They are never
// written back to core. No wallets, user data, gate tokens or encryption keys.
export type CatalogRow = Record<string, any>;
export type ProbeCatalog = Record<string, CatalogRow[]>;
export const catalogTables = ["gates", "gate_status", "gate_conditions", "gate_leases", "gate_agent_deployments",
  "trading_probe_nodes", "trading_probe_auth_tokens", "trading_probe_targets"] as const;
export const milliseconds = (value: unknown): number => value ? new Date(String(value)).getTime() : 0;

export function catalogGates(catalog: ProbeCatalog, now = Date.now()) {
  return (catalog.gates ?? []).map(gate => {
    const status = catalog.gate_status?.find(row => row.gate_id === gate.id) ?? {};
    const lease = catalog.gate_leases?.find(row => row.gate_id === gate.id);
    const condition = (type: string) => catalog.gate_conditions?.some(row => row.gate_id === gate.id && row.type === type && row.status === "True") ?? false;
    const connected = condition("AgentConnected") && milliseconds(lease?.lease_expires_at) > now;
    const deploying = catalog.gate_agent_deployments?.some(row => row.gate_id === gate.id && ["queued", "staging", "verifying", "rollback_requested", "rolling_back"].includes(row.phase));
    const dz = status.doublezero_status ?? {};
    const capabilities: string[] = status.observed_capabilities ?? [];
    const ready = connected && condition("Ready");
    const schedulable = gate.desired_state === "Enabled" && connected && condition("Schedulable") && !deploying;
    return { gate, status, connected, ready, schedulable, capabilities, dz, metro: String(dz.metro ?? "").trim(),
      benchmarkReady: ready && schedulable && capabilities.includes("doublezero0:up") && dz.tunnelStatus === "BGP Session Up"
        && dz.currentDeviceStatus !== "drained" && dz.network === (gate.spec?.doubleZeroEnv || "testnet") && dz.tunnelSrc === gate.public_ipv4 };
  });
}

export function publicCatalogGates(catalog: ProbeCatalog, includeNonEnabled = false): GateSummary[] {
  return catalogGates(catalog).filter(({gate}) => includeNonEnabled || ["Enabled", "Maintenance"].includes(gate.desired_state))
    .sort((a,b) => String(a.gate.country).localeCompare(String(b.gate.country)) || String(a.gate.city).localeCompare(String(b.gate.city)) || a.gate.name.localeCompare(b.gate.name))
    .map(({ gate, status, connected, ready, schedulable, capabilities, dz }) => {
      const result: GateSummary = { id: gate.id, name: gate.name, desiredState: gate.desired_state,
        publicIpv4: gate.public_ipv4, ready, schedulable, amneziaWGReady: connected && capabilities.includes(amneziaWGCapability) };
      Object.assign(result, Object.fromEntries(Object.entries({ city: gate.city, country: gate.country, probeUrl: gate.spec?.probeUrl,
        lastSeenAt: status.last_seen_at, agentVersion: status.agent_version, agentRevision: status.agent_revision,
        agentBuiltAt: status.agent_built_at, agentInstalledAt: status.agent_installed_at, agentArtifactSha256: status.agent_artifact_sha256
      }).filter(([,value]) => value != null && value !== "")));
      if (status.clock_error_ms != null) result.clockErrorMs = Number(status.clock_error_ms);
      const doubleZero = { ...dz };
      for (const [target, source] of [["currentDevice", "doublezero_current_device"], ["lowestLatencyDevice", "doublezero_lowest_latency_device"], ["lowestLatencyDeviceWarning", "doublezero_lowest_latency_device_warning"]] as const) {
        if (status[source] != null) doubleZero[target] = status[source];
      }
      if (Object.keys(doubleZero).length) result.doubleZero = doubleZero;
      return result;
    });
}

export function catalogNodes(catalog: ProbeCatalog): CatalogRow[] {
  return (catalog.trading_probe_nodes ?? []).map(node => {
    const gate = catalog.gates?.find(row => row.id === node.gate_id);
    return node.placement_kind === "gate_host" && node.gate_id && (!gate || gate.desired_state === "Disabled")
      ? { ...node, desired_state: "Disabled" } : node;
  });
}

export function jobTarget(row: CatalogRow): TradingProbeTarget {
  return { id: row.id, key: row.target_key, revision: Number(row.revision), category: row.category,
    displayName: row.display_name, product: row.product, protocol: row.protocol, scheme: row.scheme,
    hostname: row.hostname, port: Number(row.port), path: row.path, method: row.request_method,
    headers: row.request_headers ?? {}, ...(row.request_body == null ? {} : { body: row.request_body }),
    expectedStatus: Number(row.expected_status), ...(row.expected_body_contains ? { expectedBodyContains: row.expected_body_contains } : {}),
    responseKind: row.response_kind, timeoutMs: Number(row.timeout_ms), sampleCount: Number(row.sample_count),
    intervalSeconds: Number(row.interval_seconds), metadata: row.metadata ?? {} };
}

export function publicTarget(row: CatalogRow): PublicTradingLatencyResponse["targets"][number] {
  const category = row.category;
  return { id: row.id, key: row.target_key, category, revision: Number(row.revision), intervalSeconds: Number(row.interval_seconds),
    hostname: row.hostname, path: row.path, venueKey: row.metadata?.venueKey ?? (["cex", "prediction-markets"].includes(category) ? row.target_key.split("-")[0] : category),
    venueType: category === "cex" ? "cex" : ["hyperliquid", "variational", "extended", "rise", "lighter"].includes(category) ? "perpdex" : category === "prediction-markets" ? "prediction" : "infrastructure",
    endpointRole: row.metadata?.endpointRole ?? "public_api", displayName: row.display_name, product: row.product,
    protocol: row.protocol, measurement: row.metadata?.measurement ?? row.protocol, sortOrder: Number(row.sort_order) };
}
