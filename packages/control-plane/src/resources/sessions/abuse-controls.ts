import type { SessionCreateParsed } from "./validation.js";

export interface SessionAbuseControlConfig {
  maxActiveSessionsPerAccount: number;
  maxSessionCreatesPerWindow: number;
  sessionCreateWindowSeconds: number;
  requireSourceForFullTunnel: boolean;
  allowPrivateDestinations: boolean;
  allowPrivateSources: boolean;
}

export interface SessionAbuseControlError {
  error: string;
  message: string;
}

interface Ipv4Cidr {
  address: number;
  prefixLength: number;
  text: string;
}

export const defaultSessionAbuseControlConfig: SessionAbuseControlConfig = {
  maxActiveSessionsPerAccount: 5,
  maxSessionCreatesPerWindow: 20,
  sessionCreateWindowSeconds: 60 * 60,
  requireSourceForFullTunnel: true,
  allowPrivateDestinations: false,
  allowPrivateSources: false
};

const nonGlobalIpv4Ranges = [
  range("0.0.0.0/8"),
  range("10.0.0.0/8"),
  range("100.64.0.0/10"),
  range("127.0.0.0/8"),
  range("169.254.0.0/16"),
  range("172.16.0.0/12"),
  range("192.0.0.0/24"),
  range("192.0.2.0/24"),
  range("192.88.99.0/24"),
  range("192.168.0.0/16"),
  range("198.18.0.0/15"),
  range("198.51.100.0/24"),
  range("203.0.113.0/24"),
  range("224.0.0.0/4"),
  range("240.0.0.0/4")
];

export function mergeSessionAbuseControlConfig(
  input: Partial<SessionAbuseControlConfig> = {}
): SessionAbuseControlConfig {
  return {
    ...defaultSessionAbuseControlConfig,
    ...input
  };
}

export function validateSessionAbusePolicy(
  parsed: SessionCreateParsed,
  config: SessionAbuseControlConfig
): SessionAbuseControlError | null {
  const destinations = parsed.destinationCidrs.map((value) => parseIpv4Cidr(value));
  if (destinations.some((destination) => destination === null)) {
    return {
      error: "invalid_destination_cidr",
      message: "Destination must be a valid IPv4 CIDR."
    };
  }

  const destinationCidrs = destinations as Ipv4Cidr[];
  if (parsed.mode === "IpToIp") {
    const nonHostDestination = destinationCidrs.find((destination) => destination.prefixLength !== 32);
    if (nonHostDestination) {
      return {
        error: "invalid_destination_cidr",
        message: "Self-service IP-to-IP configs can target only a single IPv4 /32 destination."
      };
    }

    if (!config.allowPrivateDestinations) {
      const blockedDestination = destinationCidrs.find((destination) => !isGlobalIpv4Cidr(destination));
      if (blockedDestination) {
        return {
          error: "destination_not_allowed",
          message: `Destination ${blockedDestination.text} is not a public IPv4 /32 address.`
        };
      }
    }
  } else if (!isFullTunnelDestination(destinationCidrs)) {
    return {
      error: "invalid_destination_cidr",
      message: "Full-tunnel configs must use the managed 0.0.0.0/0 destination."
    };
  }

  if (parsed.mode === "FullTunnel" && config.requireSourceForFullTunnel && !parsed.sourceCidr) {
    return {
      error: "source_required",
      message: "Full-tunnel self-service configs require a source IPv4 /32 restriction."
    };
  }

  if (!parsed.sourceCidr) {
    return null;
  }

  const source = parseIpv4Cidr(parsed.sourceCidr);
  if (!source) {
    return {
      error: "invalid_source_cidr",
      message: "Source restriction must be a valid IPv4 CIDR."
    };
  }
  if (source.prefixLength !== 32) {
    return {
      error: "invalid_source_cidr",
      message: "Self-service source restrictions must be a single IPv4 /32 address."
    };
  }
  if (!config.allowPrivateSources && !isGlobalIpv4Cidr(source)) {
    return {
      error: "source_not_allowed",
      message: `Source ${source.text} is not a public IPv4 /32 address.`
    };
  }

  return null;
}

export function parseIpv4Cidr(value: string): Ipv4Cidr | null {
  const [addressPart, prefixPart, extra] = value.trim().split("/");
  if (!addressPart || !prefixPart || extra !== undefined) {
    return null;
  }

  const address = parseIpv4Address(addressPart);
  const prefixLength = parsePrefixLength(prefixPart);
  if (address === null || prefixLength === null) {
    return null;
  }

  return {
    address,
    prefixLength,
    text: `${addressPart}/${prefixLength}`
  };
}

function isFullTunnelDestination(destinations: Ipv4Cidr[]): boolean {
  return destinations.length === 1 && destinations[0]?.address === 0 && destinations[0].prefixLength === 0;
}

function isGlobalIpv4Cidr(cidr: Ipv4Cidr): boolean {
  return !nonGlobalIpv4Ranges.some((blocked) => cidrContains(blocked, cidr));
}

function cidrContains(container: Ipv4Cidr, candidate: Ipv4Cidr): boolean {
  const mask = prefixMask(container.prefixLength);
  return ((candidate.address & mask) >>> 0) === ((container.address & mask) >>> 0);
}

function range(value: string): Ipv4Cidr {
  const parsed = parseIpv4Cidr(value);
  if (!parsed) {
    throw new Error(`invalid built-in IPv4 range ${value}`);
  }
  return parsed;
}

function parseIpv4Address(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    octets.push(octet);
  }

  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return null;
  }
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function parsePrefixLength(value: string): number | null {
  if (!/^\d{1,2}$/.test(value)) {
    return null;
  }
  const prefix = Number(value);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32 ? prefix : null;
}

function prefixMask(prefixLength: number): number {
  if (prefixLength === 0) {
    return 0;
  }
  return (0xffffffff << (32 - prefixLength)) >>> 0;
}
