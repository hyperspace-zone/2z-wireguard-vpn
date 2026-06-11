import { isIP } from "node:net";

export interface GateSeed {
  name: string;
  /**
   * DoubleZero user_payer identity for this gate. This should match
   * `doublezero address` on the gate host and the identity authorized by the
   * gate's access-pass.
   */
  identity: string;
  city: string;
  country: string;
  publicIpv4: string;
  probeUrl?: string;
  doubleZeroEnv?: "testnet" | "mainnet-beta";
}

export interface NormalizedGateSeed extends GateSeed {
  doubleZeroEnv: "testnet" | "mainnet-beta";
}

export function normalizeGateSeeds(input: unknown): NormalizedGateSeed[] {
  if (!Array.isArray(input) || input.length < 2) {
    throw new Error("gate seed file must contain at least two gates");
  }

  const names = new Set<string>();
  const identities = new Set<string>();
  const publicIpv4s = new Set<string>();
  const probeUrls = new Set<string>();
  return input.map((value, index) => {
    if (typeof value !== "object" || value === null) {
      throw new Error(`gate seed at index ${index} must be an object`);
    }
    const seed = value as Partial<GateSeed>;
    const label = seed?.name ? `gate ${seed.name}` : `gate seed at index ${index}`;
    const name = readRequiredToken(seed.name, `${label}.name`);
    const identity = readRequiredToken(seed.identity, `${label}.identity`);
    const city = readRequiredText(seed.city, `${label}.city`);
    const country = readRequiredText(seed.country, `${label}.country`);
    const publicIpv4 = readRequiredToken(seed.publicIpv4, `${label}.publicIpv4`);
    const probeUrl = seed.probeUrl ? readHttpsUrl(seed.probeUrl, `${label}.probeUrl`) : "";
    if (isIP(publicIpv4) !== 4) {
      throw new Error(`${label}.publicIpv4 must be a public IPv4 address`);
    }
    if (seed.doubleZeroEnv && seed.doubleZeroEnv !== "testnet" && seed.doubleZeroEnv !== "mainnet-beta") {
      throw new Error(`${label}.doubleZeroEnv must be testnet or mainnet-beta`);
    }
    if (names.has(name)) {
      throw new Error(`duplicate gate name ${name}`);
    }
    if (identities.has(identity)) {
      throw new Error(`duplicate gate identity ${identity}`);
    }
    if (publicIpv4s.has(publicIpv4)) {
      throw new Error(`duplicate gate publicIpv4 ${publicIpv4}`);
    }
    if (probeUrl && probeUrls.has(probeUrl)) {
      throw new Error(`duplicate gate probeUrl ${probeUrl}`);
    }
    names.add(name);
    identities.add(identity);
    publicIpv4s.add(publicIpv4);
    if (probeUrl) {
      probeUrls.add(probeUrl);
    }

    return {
      name,
      identity,
      city,
      country,
      publicIpv4,
      ...(probeUrl ? { probeUrl } : {}),
      doubleZeroEnv: seed.doubleZeroEnv ?? "testnet"
    };
  });
}

function readRequiredToken(value: unknown, field: string): string {
  const text = readRequiredText(value, field);
  if (/\s/.test(text)) {
    throw new Error(`${field} must not contain whitespace`);
  }
  return text;
}

function readHttpsUrl(value: unknown, field: string): string {
  const text = readRequiredText(value, field);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${field} must use https`);
  }
  return url.toString();
}

function readRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}
