import type { Queryable } from "../../db/queryable.js";
import {
  findActiveClientAddressLease,
  listWireGuardAddressPoolsForUpdate,
  markClientAddressLeaseReleased,
  tryInsertClientAddressLease,
  updateAddressPoolNextOffset
} from "./repository.js";

export type AddressAllocatorLogger = (payload: Record<string, unknown>) => void;

export async function ensureClientAddressLease(
  client: Queryable,
  sessionId: string,
  log?: AddressAllocatorLogger
): Promise<string | null> {
  const existingAddress = await findActiveClientAddressLease(client, sessionId);
  if (existingAddress) {
    return toClientAddressCidr(existingAddress);
  }

  const pools = await listWireGuardAddressPoolsForUpdate(client);

  for (const pool of pools) {
    const parsed = parseIpv4Cidr(pool.cidr);
    if (!parsed) {
      log?.({ event: "address_pool_invalid", poolId: pool.id, cidr: pool.cidr });
      continue;
    }

    const startOffset = Number(BigInt(pool.nextOffset) % BigInt(parsed.size));
    for (let attempt = 0; attempt < parsed.size; attempt += 1) {
      const offset = (startOffset + attempt) % parsed.size;
      const clientAddress = intToIpv4(parsed.base + offset);
      const insertedAddress = await tryInsertClientAddressLease(client, {
        poolId: pool.id,
        sessionId,
        clientAddress
      });
      if (insertedAddress) {
        await updateAddressPoolNextOffset(client, pool.id, String((offset + 1) % parsed.size));
        return toClientAddressCidr(insertedAddress);
      }
    }
  }

  return null;
}

export async function releaseClientAddressLease(client: Queryable, sessionId: string, reason: string): Promise<void> {
  await markClientAddressLeaseReleased(client, sessionId, reason);
}

function parseIpv4Cidr(cidr: string): { base: number; prefix: number; size: number } | null {
  const [address, prefixRaw] = cidr.split("/");
  const prefix = Number(prefixRaw);
  const base = ipv4ToInt(address ?? "");
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32 || base === null) {
    return null;
  }
  const size = 2 ** (32 - prefix);
  return {
    base: Math.floor(base / size) * size,
    prefix,
    size
  };
}

function ipv4ToInt(value: string): number | null {
  const parts = value.trim().split(".");
  if (parts.length !== 4) {
    return null;
  }
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet < 0 || octet > 255) {
      return null;
    }
    result = result * 256 + octet;
  }
  return result;
}

function intToIpv4(value: number): string {
  return [
    Math.floor(value / 16_777_216) % 256,
    Math.floor(value / 65_536) % 256,
    Math.floor(value / 256) % 256,
    value % 256
  ].join(".");
}

function toClientAddressCidr(value: string): string {
  return value.includes("/") ? value : `${value}/32`;
}
