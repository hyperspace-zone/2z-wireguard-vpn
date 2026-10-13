import { readClientTunnel, validateHeaderProtectionKey, type ClientTunnel } from "../../planning/client-tunnel.js";

export interface WireGuardClientConfigInput {
  privateKey: string;
  clientPublicKey: string;
  clientKeyMode: string;
  address: string;
  serverPublicKey: string;
  endpoint: string;
  allowedIps: string[];
  persistentKeepaliveSeconds: number;
  clientTunnel?: ClientTunnel;
  headerProtectionKey?: string;
  mtu?: number;
}

export function renderClientConfig(input: WireGuardClientConfigInput): string {
  const tunnel = readClientTunnel(input.clientTunnel);
  const headerProtectionKey = validateHeaderProtectionKey(tunnel, input.headerProtectionKey);
  const obfuscation = tunnel.protocol === "amneziawg"
    ? ["# Requires a client supporting the extended WireGuard profile 3.1.", ...Object.entries(tunnel.parameters).map(([key, value]) => `${key} = ${value}`), `HeaderProtectionKey = ${headerProtectionKey}`]
    : [];
  const interfaceLines = input.clientKeyMode === "BringYourOwnPublicKey"
    ? [
        "[Interface]",
        "# Bring-your-own-key mode.",
        "# Replace the placeholder below with the private key that matches this client public key:",
        `# ${input.clientPublicKey}`,
        "PrivateKey = <replace-with-matching-client-private-key>"
      ]
    : [
        "[Interface]",
        `PrivateKey = ${input.privateKey}`
      ];

  return [
    ...interfaceLines,
    `Address = ${input.address}`,
    "DNS = 1.1.1.1",
    ...(input.mtu ? [`MTU = ${input.mtu}`] : []),
    ...obfuscation,
    "",
    "[Peer]",
    `PublicKey = ${input.serverPublicKey}`,
    `Endpoint = ${input.endpoint}`,
    `AllowedIPs = ${input.allowedIps.join(", ")}`,
    `PersistentKeepalive = ${input.persistentKeepaliveSeconds}`,
    ""
  ].join("\n");
}
