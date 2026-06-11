import { isIP } from "node:net";

export interface GateSeed {
  name: string;
  /**
   * DoubleZero user_payer identity for this gate. This should match
   * `doublezero address` on the gate host and the identity authorized by the
   * gate's access-pass.
   */
  identity: string;
  region?: string;
  city: string;
  country: string;
  countryCode: string;
  publicEndpoint: string;
  probeUrl?: string;
  doubleZeroEnv?: "testnet" | "mainnet-beta";
}

export interface NormalizedGateSeed extends GateSeed {
  region: string;
  countryCode: string;
  doubleZeroEnv: "testnet" | "mainnet-beta";
}

const regionCountryCodes: Record<string, ReadonlySet<string>> = {
  eu: new Set([
    "AT", "BE", "BG", "CH", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB", "GR", "HR", "HU",
    "IE", "IS", "IT", "LT", "LU", "LV", "NL", "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK"
  ]),
  na: new Set(["BM", "CA", "MX", "US"]),
  ap: new Set([
    "AU", "CN", "HK", "ID", "IN", "JP", "KR", "MY", "NZ", "PH", "SG", "TH", "TW", "VN"
  ]),
  sa: new Set(["AR", "BO", "BR", "CL", "CO", "EC", "PE", "PY", "UY", "VE"]),
  af: new Set(["EG", "KE", "MA", "NG", "ZA"]),
  me: new Set(["AE", "BH", "IL", "KW", "OM", "QA", "SA", "TR"])
};

export function normalizeGateSeeds(input: unknown): NormalizedGateSeed[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("gate seed file must contain a non-empty JSON array");
  }

  const names = new Set<string>();
  const identities = new Set<string>();
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
    const countryCode = readRequiredToken(seed.countryCode, `${label}.countryCode`).toUpperCase();
    const publicEndpoint = readRequiredToken(seed.publicEndpoint, `${label}.publicEndpoint`);
    const region = seed.region === undefined ? "" : readRequiredToken(seed.region, `${label}.region`);
    if (isIP(publicEndpoint) !== 4) {
      throw new Error(`${label}.publicEndpoint must be an IPv4 address`);
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
    names.add(name);
    identities.add(identity);

    return {
      name,
      identity,
      city,
      country,
      countryCode,
      publicEndpoint,
      ...(seed.probeUrl ? { probeUrl: seed.probeUrl } : {}),
      region: region || inferRegionFromCountryCode(countryCode),
      doubleZeroEnv: seed.doubleZeroEnv ?? "testnet"
    };
  });
}

export function inferRegionFromCountryCode(countryCode: string): string {
  const normalized = countryCode.trim().toUpperCase();
  for (const [region, countryCodes] of Object.entries(regionCountryCodes)) {
    if (countryCodes.has(normalized)) {
      return region;
    }
  }
  return "xx";
}

function readRequiredToken(value: unknown, field: string): string {
  const text = readRequiredText(value, field);
  if (/\s/.test(text)) {
    throw new Error(`${field} must not contain whitespace`);
  }
  return text;
}

function readRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}
