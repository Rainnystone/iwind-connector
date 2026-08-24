import type {
  AuthRequest,
  AuthorizationErrorCode,
  ClientInfo,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import { exchangeAndVerifyAccessCode, type AccessOidcDependencies } from "./access-oidc";
import { clearSessionCookie, openSessionCookie, sealSessionCookie } from "./state-cookie";
import type { AccessFlowSession, ConsentFlowSession } from "./types";

const ACCESS_COOKIE = "__Host-iwind-access";
const CONSENT_COOKIE = "__Host-iwind-consent";
const encoder = new TextEncoder();

export interface IWindAuthorizationEnvironment {
  readonly PUBLIC_ORIGIN: string;
  readonly COOKIE_ENCRYPTION_KEY: string;
  readonly ACCESS_CLIENT_ID: string;
  readonly ACCESS_CLIENT_SECRET: string;
  readonly ACCESS_AUTHORIZATION_URL: string;
  readonly ACCESS_TOKEN_URL: string;
  readonly ACCESS_JWKS_URL: string;
  readonly ACCESS_ISSUER: string;
  readonly ACCESS_AUDIENCE: string;
  readonly ALLOWED_USER_EMAIL: string;
  readonly KEY_POOL: Cloudflare.Env["KEY_POOL"];
  readonly OAUTH_PROVIDER: Pick<
    OAuthHelpers,
    "parseAuthRequest" | "lookupClient" | "completeAuthorization"
  >;
}

export async function handleAuthorizationRequest(
  request: Request,
  env: IWindAuthorizationEnvironment,
  dependencies: AccessOidcDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  const now = dependencies.now?.() ?? Date.now();
  if (url.pathname === "/authorize" && request.method === "GET") {
    return startAuthorization(request, env, now);
  }
  if (url.pathname === "/callback" && request.method === "GET") {
    return completeAccessCallback(request, env, dependencies, now);
  }
  if (url.pathname === "/callback" && request.method === "POST") {
    return completeConsent(request, env, now);
  }
  if (url.pathname === "/authorize" || url.pathname === "/callback") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return new Response("Not Found", { status: 404 });
}

async function startAuthorization(
  request: Request,
  env: IWindAuthorizationEnvironment,
  now: number,
): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    return authorizationErrorResponse(error);
  }
  let client: ClientInfo | null;
  try {
    client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  } catch {
    return localOAuthError("OAuth client could not be resolved");
  }
  if (client === null) return localOAuthError("Unknown OAuth client");
  const state = randomToken();
  const nonce = randomToken();
  await env.KEY_POOL.getByName("private-key-pool").setOAuthReplayMarker({
    markerId: await markerId(state),
    kind: "access",
    now,
  });
  const session: AccessFlowSession = {
    phase: "access",
    oauthRequest,
    client: safeClient(client),
    state,
    nonce,
  };
  const setCookie = await sealSessionCookie(
    ACCESS_COOKIE,
    session,
    env.COOKIE_ENCRYPTION_KEY,
    now,
  );
  const callback = canonicalCallback(env.PUBLIC_ORIGIN);
  const location = new URL(env.ACCESS_AUTHORIZATION_URL);
  if (location.protocol !== "https:") return localOAuthError("Identity provider is unavailable");
  location.search = new URLSearchParams({
    client_id: env.ACCESS_CLIENT_ID,
    response_type: "code",
    redirect_uri: callback,
    scope: "openid email",
    state,
    nonce,
  }).toString();
  return redirectWithCookies(location.toString(), [setCookie]);
}

async function completeAccessCallback(
  request: Request,
  env: IWindAuthorizationEnvironment,
  dependencies: AccessOidcDependencies,
  now: number,
): Promise<Response> {
  try {
    const session = await openSessionCookie<AccessFlowSession>(
      request,
      ACCESS_COOKIE,
      env.COOKIE_ENCRYPTION_KEY,
      now,
    );
    if (session.phase !== "access") throw new Error("invalid phase");
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code === null || state === null || !(await digestEqual(state, session.state))) {
      throw new Error("invalid callback");
    }
    const consumed = await env.KEY_POOL.getByName("private-key-pool").consumeOAuthReplayMarker({
      markerId: await markerId(state),
      kind: "access",
      now,
    });
    if (!consumed) throw new Error("replayed callback");

    const authProps = await exchangeAndVerifyAccessCode(
      {
        code,
        nonce: session.nonce,
        redirectUri: canonicalCallback(env.PUBLIC_ORIGIN),
        clientId: env.ACCESS_CLIENT_ID,
        clientSecret: env.ACCESS_CLIENT_SECRET,
        tokenUrl: env.ACCESS_TOKEN_URL,
        jwksUrl: env.ACCESS_JWKS_URL,
        issuer: env.ACCESS_ISSUER,
        audience: env.ACCESS_AUDIENCE,
        allowedEmail: env.ALLOWED_USER_EMAIL,
      },
      dependencies,
    );
    const csrf = randomToken();
    const marker = randomToken();
    await env.KEY_POOL.getByName("private-key-pool").setOAuthReplayMarker({
      markerId: await markerId(marker),
      kind: "consent",
      now,
    });
    const consentSession: ConsentFlowSession = {
      phase: "consent",
      oauthRequest: session.oauthRequest,
      client: session.client,
      authProps,
      csrf,
      marker,
    };
    const consentCookie = await sealSessionCookie(
      CONSENT_COOKIE,
      consentSession,
      env.COOKIE_ENCRYPTION_KEY,
      now,
    );
    return htmlResponse(renderConsent(consentSession), [
      consentCookie,
      clearSessionCookie(ACCESS_COOKIE),
    ]);
  } catch {
    return localOAuthError("Authorization callback was rejected", [
      clearSessionCookie(ACCESS_COOKIE),
      clearSessionCookie(CONSENT_COOKIE),
    ]);
  }
}

async function completeConsent(
  request: Request,
  env: IWindAuthorizationEnvironment,
  now: number,
): Promise<Response> {
  try {
    if (request.headers.get("content-type") !== "application/x-www-form-urlencoded") {
      throw new Error("invalid media type");
    }
    const session = await openSessionCookie<ConsentFlowSession>(
      request,
      CONSENT_COOKIE,
      env.COOKIE_ENCRYPTION_KEY,
      now,
    );
    if (session.phase !== "consent") throw new Error("invalid phase");
    const text = await readBoundedText(request, 4096);
    if (text === null) throw new Error("form too large");
    const form = new URLSearchParams(text);
    const entries = [...form.entries()];
    if (
      entries.length !== 2 ||
      form.getAll("action").length !== 1 ||
      form.getAll("csrf").length !== 1 ||
      entries.some(([key]) => key !== "action" && key !== "csrf")
    ) {
      throw new Error("unexpected form field");
    }
    if (!(await digestEqual(form.get("csrf") ?? "", session.csrf))) throw new Error("csrf mismatch");
    const action = form.get("action");
    if (action !== "approve" && action !== "deny") throw new Error("invalid action");
    const consumed = await env.KEY_POOL.getByName("private-key-pool").consumeOAuthReplayMarker({
      markerId: await markerId(session.marker),
      kind: "consent",
      now,
    });
    if (!consumed) throw new Error("replayed consent");
    if (action === "deny") {
      return redirectWithCookies(oauthDeniedRedirect(session.oauthRequest), [
        clearSessionCookie(CONSENT_COOKIE),
      ]);
    }
    if (!session.oauthRequest.scope.includes("mcp:read")) throw new Error("required scope missing");
    const scope = ["mcp:read"];
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: session.oauthRequest,
      userId: session.authProps.userId,
      metadata: { clientId: session.client.clientId },
      scope,
      props: session.authProps,
    });
    return redirectWithCookies(redirectTo, [clearSessionCookie(CONSENT_COOKIE)]);
  } catch {
    return localOAuthError("Consent was rejected", [clearSessionCookie(CONSENT_COOKIE)]);
  }
}

async function readBoundedText(request: Request, maximum: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
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
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function authorizationErrorResponse(error: unknown): Response {
  if (!isAuthorizationError(error)) return localOAuthError("Authorization request failed");
  if (error.redirectUri === undefined) return localOAuthError(error.description);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state !== undefined) redirect.searchParams.set("state", error.state);
  if (error.issuer !== undefined) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect.toString(), 302);
}

function isAuthorizationError(value: unknown): value is {
  readonly code: AuthorizationErrorCode;
  readonly description: string;
  readonly redirectUri?: string;
  readonly state?: string;
  readonly issuer?: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const error = value as Record<string, unknown>;
  return (
    typeof error.code === "string" &&
    [
      "invalid_request",
      "invalid_target",
      "unauthorized_client",
      "access_denied",
      "unsupported_response_type",
      "invalid_scope",
      "server_error",
      "temporarily_unavailable",
    ].includes(error.code) &&
    typeof error.description === "string" &&
    (error.redirectUri === undefined || typeof error.redirectUri === "string") &&
    (error.state === undefined || typeof error.state === "string") &&
    (error.issuer === undefined || typeof error.issuer === "string")
  );
}

function oauthDeniedRedirect(request: AuthRequest): string {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", "The user denied the request");
  redirect.searchParams.set("state", request.state);
  if (request.issuer !== undefined) redirect.searchParams.set("iss", request.issuer);
  return redirect.toString();
}

function renderConsent(session: ConsentFlowSession): string {
  const name = escapeHtml(session.client.clientName ?? session.client.clientId);
  const scopes = session.oauthRequest.scope
    .filter((scope) => scope === "mcp:read")
    .map(escapeHtml)
    .join(", ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorize iWind</title></head><body><main><h1>Authorize ${name}</h1><p>Requested access: ${scopes}</p><form method="post" action="/callback"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><button type="submit" name="action" value="approve">Approve</button><button type="submit" name="action" value="deny">Deny</button></form></main></body></html>`;
}

function htmlResponse(html: string, cookies: readonly string[]): Response {
  const headers = securityHeaders("text/html; charset=utf-8");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(html, { status: 200, headers });
}

function localOAuthError(message: string, cookies: readonly string[] = []): Response {
  const headers = securityHeaders("text/plain; charset=utf-8");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(message, { status: 400, headers });
}

function securityHeaders(contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "content-security-policy": "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
}

function redirectWithCookies(location: string, cookies: readonly string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function safeClient(client: ClientInfo): AccessFlowSession["client"] {
  return {
    clientId: client.clientId,
    ...(client.clientName === undefined ? {} : { clientName: client.clientName }),
    ...(client.clientUri === undefined ? {} : { clientUri: client.clientUri }),
  };
}

function canonicalCallback(publicOrigin: string): string {
  return `${new URL(publicOrigin).origin}/callback`;
}

async function markerId(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function digestEqual(first: string, second: string): Promise<boolean> {
  const [leftBuffer, rightBuffer] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(first)),
    crypto.subtle.digest("SHA-256", encoder.encode(second)),
  ]);
  const left = new Uint8Array(leftBuffer);
  const right = new Uint8Array(rightBuffer);
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
