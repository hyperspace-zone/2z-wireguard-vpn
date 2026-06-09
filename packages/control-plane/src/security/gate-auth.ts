import { sha256Hex } from "./tokens.js";

export function gateTokenHash(token: string): string {
  return sha256Hex(token);
}
