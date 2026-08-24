const COOKIE_MAX_AGE_SECONDS = 600;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

interface SealedPayload<T> {
  readonly expiresAt: number;
  readonly value: T;
}

export async function sealSessionCookie<T>(
  name: `__Host-${string}`,
  value: T,
  secret: string,
  now: number,
): Promise<string> {
  assertCookieInputs(name, secret, now);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(
    JSON.stringify({ expiresAt: now + COOKIE_MAX_AGE_SECONDS * 1000, value } satisfies SealedPayload<T>),
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
    await deriveKey(secret),
    plaintext,
  );
  const encoded = base64Url(concat(iv, new Uint8Array(ciphertext)));
  return `${name}=${encoded}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

export async function openSessionCookie<T>(
  request: Request,
  name: `__Host-${string}`,
  secret: string,
  now: number,
): Promise<T> {
  assertCookieInputs(name, secret, now);
  const encoded = readSingleCookie(request.headers.get("cookie"), name);
  if (encoded === null) throw new Error("OAUTH_SESSION_INVALID");
  try {
    const bytes = fromBase64Url(encoded);
    if (bytes.byteLength <= 12) throw new Error("invalid ciphertext");
    const iv = bytes.slice(0, 12);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
      await deriveKey(secret),
      bytes.slice(12),
    );
    const parsed: unknown = JSON.parse(decoder.decode(plaintext));
    if (!isRecord(parsed) || typeof parsed.expiresAt !== "number" || !("value" in parsed)) {
      throw new Error("invalid payload");
    }
    if (!Number.isFinite(parsed.expiresAt) || now > parsed.expiresAt) {
      throw new Error("OAUTH_SESSION_EXPIRED");
    }
    return parsed.value as T;
  } catch (error) {
    if (error instanceof Error && error.message === "OAUTH_SESSION_EXPIRED") throw error;
    throw new Error("OAUTH_SESSION_INVALID");
  }
}

export function clearSessionCookie(name: `__Host-${string}`): string {
  if (!name.startsWith("__Host-")) throw new Error("INVALID_COOKIE_NAME");
  return `${name}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function readSingleCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && values[0] !== "" ? (values[0] ?? null) : null;
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const output = new Uint8Array(first.byteLength + second.byteLength);
  output.set(first);
  output.set(second, first.byteLength);
  return output;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function assertCookieInputs(name: string, secret: string, now: number): void {
  if (!name.startsWith("__Host-") || /[;=\s]/u.test(name)) throw new Error("INVALID_COOKIE_NAME");
  if (secret.trim().length === 0) throw new Error("COOKIE_KEY_MISSING");
  if (!Number.isFinite(now) || now < 0) throw new Error("INVALID_TIMESTAMP");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
