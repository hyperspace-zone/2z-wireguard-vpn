export interface WireGuardClientConfigInput {
  privateKey: string;
  clientPublicKey: string;
  clientKeyMode: string;
  address: string;
  serverPublicKey: string;
  endpoint: string;
  allowedIps: string[];
  persistentKeepaliveSeconds: number;
}

export function renderClientConfig(input: WireGuardClientConfigInput): string {
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
    "",
    "[Peer]",
    `PublicKey = ${input.serverPublicKey}`,
    `Endpoint = ${input.endpoint}`,
    `AllowedIPs = ${input.allowedIps.join(", ")}`,
    `PersistentKeepalive = ${input.persistentKeepaliveSeconds}`,
    ""
  ].join("\n");
}
