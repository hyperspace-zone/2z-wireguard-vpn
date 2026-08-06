export function normalizeSolanaPublicKey(value: string): string {
  const publicKey = value.trim();
  const bytes = decodeBase58(publicKey);
  if (!bytes || bytes.length !== 32 || bytes.every((byte) => byte === 0)) {
    return "";
  }
  return publicKey;
}

function decodeBase58(value: string): Uint8Array | null {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const char of value) {
    const valueIndex = alphabet.indexOf(char);
    if (valueIndex < 0) return null;
    let carry = valueIndex;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = (bytes[index] ?? 0) * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let index = 0; index < value.length - 1 && value[index] === "1"; index += 1) {
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}
