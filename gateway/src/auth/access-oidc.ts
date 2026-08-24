import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

import type { AuthProps } from "../mcp/create-server";

const MAX_TOKEN_RESPONSE_BYTES = 16 * 1024;
const encoder = new TextEncoder();

export interface AccessCodeInput {
  readonly code: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly allowedEmail: string;
}

export interface AccessOidcDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export async function exchangeAndVerifyAccessCode(
  input: AccessCodeInput,
  dependencies: AccessOidcDependencies = {},
): Promise<AuthProps> {
  validateInput(input);
  const fetchImplementation = dependencies.fetch ?? fetch;
  const response = await fetchImplementation(input.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }),
  });
  if (!response.ok) throw new Error("ACCESS_IDENTITY_REJECTED");
  const body = await readBoundedJson(response, MAX_TOKEN_RESPONSE_BYTES);
  if (!isRecord(body) || typeof body.id_token !== "string") {
    throw new Error("ACCESS_IDENTITY_REJECTED");
  }

  try {
    const jwks = createRemoteJWKSet(new URL(input.jwksUrl), {
      timeoutDuration: 5_000,
      [customFetch]: (url, options) => fetchImplementation(url, options),
    });
    const now = dependencies.now?.() ?? Date.now();
    const verified = await jwtVerify(body.id_token, jwks, {
      issuer: input.issuer,
      audience: input.audience,
      currentDate: new Date(now),
      algorithms: ["RS256"],
    });
    const email = normalizeEmail(verified.payload.email);
    if (
      verified.payload.nonce !== input.nonce ||
      email === null ||
      email !== normalizeEmail(input.allowedEmail)
    ) {
      throw new Error("identity mismatch");
    }
    const [emailHash, userHash] = await Promise.all([
      sha256Hex(email),
      sha256Hex(`iwind-user\u0000${verified.payload.sub ?? ""}\u0000${email}`),
    ]);
    if (typeof verified.payload.sub !== "string" || verified.payload.sub.length === 0) {
      throw new Error("missing subject");
    }
    return { userId: `u_${userHash}`, emailHash, scopes: ["mcp:read"] };
  } catch {
    throw new Error("ACCESS_IDENTITY_REJECTED");
  }
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximum) throw new Error("response too large");
  if (response.body === null) throw new Error("empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
      if (result.done) break;
      const value = result.value;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function validateInput(input: AccessCodeInput): void {
  const values: readonly string[] = [
    input.code,
    input.nonce,
    input.redirectUri,
    input.clientId,
    input.clientSecret,
    input.tokenUrl,
    input.jwksUrl,
    input.issuer,
    input.audience,
    input.allowedEmail,
  ];
  for (const value of values) {
    if (value.trim().length === 0) throw new Error("ACCESS_CONFIGURATION_INVALID");
  }
  for (const value of [input.tokenUrl, input.jwksUrl, input.issuer]) {
    if (new URL(value).protocol !== "https:") throw new Error("ACCESS_CONFIGURATION_INVALID");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
