const encoder = new TextEncoder();

export type AdminAuthentication = "authorized" | "missing_or_malformed" | "rejected";

export async function authenticateAdmin(
  authorization: string | null,
  expectedToken: string | undefined,
): Promise<AdminAuthentication> {
  const match = authorization?.match(/^Bearer ([^\s]+)$/u);
  if (match === undefined || match === null) return "missing_or_malformed";
  const provided = match[1] ?? "";
  const expected = expectedToken ?? "";
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const matches = timingSafeDigestEqual(providedHash, expectedHash);
  return expected.trim().length > 0 && matches ? "authorized" : "rejected";
}

function timingSafeDigestEqual(first: ArrayBuffer, second: ArrayBuffer): boolean {
  const platformComparison = Reflect.get(crypto.subtle, "timingSafeEqual");
  if (typeof platformComparison === "function") {
    return Boolean(Reflect.apply(platformComparison, crypto.subtle, [first, second]));
  }
  const left = new Uint8Array(first);
  const right = new Uint8Array(second);
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
