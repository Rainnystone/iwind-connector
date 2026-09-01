import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import registrationFixture from "../fixtures/access/client-registration.json";
import resourceMetadataFixture from "../fixtures/access/protected-resource-metadata.json";
import { exchangeAndVerifyAccessCode } from "../../src/auth/access-oidc";
import {
  handleAuthorizationRequest,
  type IWindAuthorizationEnvironment,
} from "../../src/auth/authorization-handler";
import { createOAuthProvider, createOAuthProviderOptions } from "../../src/auth/provider";
import {
  clearSessionCookie,
  openSessionCookie,
  sealSessionCookie,
} from "../../src/auth/state-cookie";

const ORIGIN = "http://localhost:8787";
const MCP_RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT_URI = "https://client.example.test/callback";
const CODE_VERIFIER = "task-10-s256-verifier-012345678901234567890123456789";
const TEST_ENV = {
  ...env,
  PUBLIC_ORIGIN: ORIGIN,
  DEPLOYMENT_STAGE: "local" as const,
  WIND_API_KEY_01: "task-10-worker-key-one",
  WIND_API_KEY_02: "task-10-worker-key-two",
  WIND_API_KEY_03: "task-10-worker-key-three",
  ADMIN_TOKEN: "task-10-admin-only-token",
  COOKIE_ENCRYPTION_KEY: "task-10-cookie-encryption-key",
  ACCESS_CLIENT_ID: "task-10-access-client",
  ACCESS_CLIENT_SECRET: "task-10-access-client-secret",
  ACCESS_AUTHORIZATION_URL: "https://access.example.test/authorize",
  ACCESS_TOKEN_URL: "https://access.example.test/token",
  ACCESS_JWKS_URL: "https://access.example.test/jwks",
  ACCESS_ISSUER: "https://access.example.test",
  ACCESS_AUDIENCE: "task-10-access-audience",
  ALLOWED_USER_EMAIL: "integration@example.test",
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

describe("OAuth-protected local Worker and MCP integration", () => {
  it("rejects unauthenticated MCP and publishes the exact OAuth/S256 metadata fixtures", async () => {
    const provider = createOAuthProvider(ORIGIN, "local");
    const unauthenticated = await gatewayFetch(provider, new Request(MCP_RESOURCE));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );

    const resource = await gatewayFetch(
      provider,
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(await resource.json()).toEqual(resourceMetadataFixture);

    const authorization = await gatewayFetch(
      provider,
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    );
    expect(await authorization.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      scopes_supported: ["mcp:read"],
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    });
  });

  it("completes Access-backed S256 authorization, rejects replay, and calls six domains through authenticated /mcp", async () => {
    const upstream = await upstreamFixture();
    vi.stubGlobal("fetch", upstream.fetch);
    const provider = createOAuthProvider(ORIGIN, "local");

    const registration = await gatewayFetch(
      provider,
      new Request(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registrationFixture),
      }),
    );
    expect(registration.status).toBe(201);
    const registered = (await registration.json()) as { client_id: string };
    const challenge = await sha256Base64Url(CODE_VERIFIER);
    const authorize = new URL(`${ORIGIN}/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: REDIRECT_URI,
      scope: "mcp:read",
      state: "task-10-client-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_RESOURCE,
    }).toString();

    const started = await gatewayFetch(provider, new Request(authorize));
    expect(started.status).toBe(302);
    const accessRedirect = new URL(started.headers.get("location") ?? "");
    expect(accessRedirect.origin).toBe("https://access.example.test");
    upstream.idToken = await signedAccessToken(accessRedirect.searchParams.get("nonce") ?? "");

    const callback = new URL(`${ORIGIN}/callback`);
    callback.searchParams.set("code", "task-10-access-code");
    callback.searchParams.set("state", accessRedirect.searchParams.get("state") ?? "");
    const consent = await gatewayFetch(
      provider,
      new Request(callback, { headers: { cookie: firstCookie(started) } }),
    );
    expect(consent.status).toBe(200);
    const consentHtml = await consent.text();
    const csrf = consentHtml.match(/name="csrf" value="([^"]+)"/u)?.[1] ?? "";
    expect(csrf).not.toBe("");

    const approved = await gatewayFetch(
      provider,
      new Request(`${ORIGIN}/callback`, {
        method: "POST",
        headers: {
          cookie: firstCookie(consent),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ action: "approve", csrf }),
      }),
    );
    expect(approved.status).toBe(302);
    const authorizationCode = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
    expect(authorizationCode).not.toBe("");

    const tokenRequest = () =>
      new Request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: registered.client_id,
          redirect_uri: REDIRECT_URI,
          code: authorizationCode,
          code_verifier: CODE_VERIFIER,
          resource: MCP_RESOURCE,
        }),
      });
    const issued = await gatewayFetch(provider, tokenRequest());
    expect(issued.status).toBe(200);
    const token = (await issued.json()) as {
      access_token: string;
      resource: string;
      scope: string;
    };
    expect(token.resource).toBe(MCP_RESOURCE);
    expect(token.scope).toBe("mcp:read");

    const transport = new StreamableHTTPClientTransport(new URL(MCP_RESOURCE), {
      authProvider: { token: async () => token.access_token },
      fetch: (input, init) => gatewayFetch(provider, new Request(input, init)),
    });
    const client = new Client({ name: "task-10-local-agent", version: "1.0.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(31);
    expect(new Set(listed.tools.map(({ name }) => name))).toHaveLength(31);

    const representatives = [
      ["get_risk_metrics", { question: "synthetic stock query" }],
      ["get_fund_company_info", { question: "synthetic fund query" }],
      ["get_index_basicinfo", { question: "synthetic index query" }],
      ["get_economic_data", { metricIdsStr: "synthetic economic metric" }],
      ["get_company_announcements", { query: "synthetic disclosure query" }],
      ["get_financial_data", { question: "synthetic analytics query" }],
    ] as const;
    for (const [name, argumentsValue] of representatives) {
      const result = await client.callTool({ name, arguments: argumentsValue });
      expect(result.isError, name).not.toBe(true);
    }
    await client.close();

    expect(upstream.calledTools).toEqual(representatives.map(([name]) => name));
    expect(new Set(upstream.calledUrls)).toHaveLength(6);
    expect(upstream.maximumInFlight).toBe(1);
    expect(upstream.authorizationSlots).toEqual(Array(6).fill("key-03"));

    const replay = await gatewayFetch(provider, tokenRequest());
    expect(replay.status).toBe(400);

    const admin = await gatewayFetch(
      provider,
      new Request(`${ORIGIN}/admin/key-pool`, {
        headers: { authorization: `Bearer ${token.access_token}` },
      }),
    );
    expect(admin.status).toBe(403);
  }, 30_000);
});

describe("OAuth rejection and configuration branch matrix", () => {
  it.each([
    ["PUT", "/authorize", 405],
    ["PUT", "/callback", 405],
    ["GET", "/closed", 404],
  ] as const)("closes %s %s with %s", async (method, pathname, status) => {
    const response = await handleAuthorizationRequest(
      new Request(`https://gateway.test${pathname}`, { method }),
      directAuthorizationEnv(),
    );
    expect(response.status).toBe(status);
  });

  it("rejects unresolved clients and a non-HTTPS identity provider before setting an external redirect", async () => {
    const unknown = directAuthorizationEnv();
    unknown.OAUTH_PROVIDER.lookupClient = async () => null;
    await expect(
      handleAuthorizationRequest(new Request("https://gateway.test/authorize"), unknown),
    ).resolves.toMatchObject({ status: 400 });

    const insecure = directAuthorizationEnv();
    insecure.ACCESS_AUTHORIZATION_URL = "http://access.example.test/authorize";
    const response = await handleAuthorizationRequest(
      new Request("https://gateway.test/authorize"),
      insecure,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it.each([
    new Error("private parse detail"),
    "string parser failure",
    null,
    { code: "invalid_scope", description: "invalid scope" },
    { code: "not_allowed", description: "bad code" },
    { code: "invalid_scope", description: 7 },
    { code: "invalid_scope", description: "bad", redirectUri: 7 },
    { code: "invalid_scope", description: "bad", state: 7 },
    { code: "invalid_scope", description: "bad", issuer: 7 },
  ])("fails closed for an authorization parser rejection", async (failure) => {
    const fixture = directAuthorizationEnv();
    fixture.OAUTH_PROVIDER.parseAuthRequest = async () => Promise.reject(failure);
    const response = await handleAuthorizationRequest(
      new Request("https://gateway.test/authorize"),
      fixture,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("preserves only safe OAuth redirect fields for a structured parser error", async () => {
    const fixture = directAuthorizationEnv();
    fixture.OAUTH_PROVIDER.parseAuthRequest = async () =>
      Promise.reject({
        code: "invalid_scope",
        description: "invalid scope",
        redirectUri: REDIRECT_URI,
        state: "safe-state",
        issuer: "https://gateway.test",
      });
    const response = await handleAuthorizationRequest(
      new Request("https://gateway.test/authorize"),
      fixture,
    );
    const redirect = new URL(response.headers.get("location") ?? "");
    expect(response.status).toBe(302);
    expect(redirect.searchParams.get("error")).toBe("invalid_scope");
    expect(redirect.searchParams.get("state")).toBe("safe-state");
    expect(redirect.searchParams.get("iss")).toBe("https://gateway.test");

    const withoutOptionalFields = directAuthorizationEnv();
    withoutOptionalFields.OAUTH_PROVIDER.parseAuthRequest = async () =>
      Promise.reject({
        code: "invalid_scope",
        description: "invalid scope",
        redirectUri: REDIRECT_URI,
      });
    const minimal = await handleAuthorizationRequest(
      new Request("https://gateway.test/authorize"),
      withoutOptionalFields,
    );
    const minimalRedirect = new URL(minimal.headers.get("location") ?? "");
    expect(minimalRedirect.searchParams.has("state")).toBe(false);
    expect(minimalRedirect.searchParams.has("iss")).toBe(false);
  });

  it("starts authorization when optional client presentation metadata is absent", async () => {
    const fixture = directAuthorizationEnv();
    fixture.OAUTH_PROVIDER.lookupClient = async () => ({
      clientId: "client-01",
      redirectUris: [REDIRECT_URI],
      tokenEndpointAuthMethod: "none",
    });
    const response = await handleAuthorizationRequest(
      new Request("https://gateway.test/authorize"),
      fixture,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("__Host-iwind-access=");
  });

  it("rejects missing callback fields, mismatched state, and the wrong encrypted phase", async () => {
    const fixture = directAuthorizationEnv();
    const started = await handleAuthorizationRequest(
      new Request("https://gateway.test/authorize"),
      fixture,
    );
    const cookie = firstCookie(started);
    for (const url of [
      "https://gateway.test/callback",
      "https://gateway.test/callback?code=x",
      "https://gateway.test/callback?state=x",
      "https://gateway.test/callback?code=x&state=wrong",
    ]) {
      const response = await handleAuthorizationRequest(
        new Request(url, { headers: { cookie } }),
        fixture,
      );
      expect(response.status).toBe(400);
    }
    const wrongPhase = await sealSessionCookie(
      "__Host-iwind-access",
      { phase: "consent" },
      TEST_ENV.COOKIE_ENCRYPTION_KEY,
      Date.now(),
    );
    await expect(
      handleAuthorizationRequest(
        new Request("https://gateway.test/callback?code=x&state=x", {
          headers: { cookie: cookieValue(wrongPhase) },
        }),
        fixture,
      ),
    ).resolves.toMatchObject({ status: 400 });
  });

  it("rejects consent media, body, CSRF, action, phase, and scope boundary violations", async () => {
    const fixture = directAuthorizationEnv();
    const baseSession = consentSession();
    const request = async (
      session: Record<string, unknown>,
      body: BodyInit | null,
      contentType = "application/x-www-form-urlencoded",
    ) => {
      const sealed = await sealSessionCookie(
        "__Host-iwind-consent",
        session,
        TEST_ENV.COOKIE_ENCRYPTION_KEY,
        Date.now(),
      );
      return handleAuthorizationRequest(
        new Request("https://gateway.test/callback", {
          method: "POST",
          headers: { cookie: cookieValue(sealed), "content-type": contentType },
          ...(body === null ? {} : { body }),
        }),
        fixture,
      );
    };

    const cases = [
      request(baseSession, new URLSearchParams({ action: "approve", csrf: "csrf" }), "text/plain"),
      request({ phase: "access" }, new URLSearchParams({ action: "approve", csrf: "csrf" })),
      request(baseSession, new Uint8Array(4097)),
      request(baseSession, null),
      request(baseSession, new URLSearchParams({ action: "approve", csrf: "wrong" })),
      request(baseSession, new URLSearchParams({ action: "maybe", csrf: "csrf" })),
      request(
        { ...baseSession, oauthRequest: { ...baseSession.oauthRequest, scope: [] } },
        new URLSearchParams({ action: "approve", csrf: "csrf" }),
      ),
    ];
    for (const response of await Promise.all(cases)) expect(response.status).toBe(400);
  });

  it("denies consent safely when issuer and optional client metadata are absent", async () => {
    const fixture = directAuthorizationEnv();
    const session = consentSession();
    session.oauthRequest.issuer = undefined;
    session.client = { clientId: "client-01" };
    const sealed = await sealSessionCookie(
      "__Host-iwind-consent",
      session,
      TEST_ENV.COOKIE_ENCRYPTION_KEY,
      Date.now(),
    );
    const response = await handleAuthorizationRequest(
      new Request("https://gateway.test/callback", {
        method: "POST",
        headers: {
          cookie: cookieValue(sealed),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ action: "deny", csrf: "csrf" }),
      }),
      fixture,
    );
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "").searchParams.has("iss")).toBe(false);
  });

  it("validates every public origin and encrypted-cookie input fail closed", async () => {
    expect(createOAuthProviderOptions("https://gateway.test").resourceMetadata.resource).toBe(
      "https://gateway.test/mcp",
    );
    for (const origin of [
      "https://gateway.test/path",
      "https://gateway.test/?query=1",
      "https://gateway.test/#fragment",
      "https://user@gateway.test/",
      "http://gateway.test/",
    ]) {
      expect(() => createOAuthProviderOptions(origin, "production")).toThrow("PUBLIC_ORIGIN_INVALID");
    }
    expect(() => createOAuthProviderOptions("http://127.0.0.1:8787", "local")).toThrow(
      "PUBLIC_ORIGIN_INVALID",
    );
    expect(() => createOAuthProviderOptions("http://localhost:8787", "staging")).toThrow(
      "PUBLIC_ORIGIN_INVALID",
    );

    expect(() => clearSessionCookie("__Host-ok")).not.toThrow();
    expect(() => Reflect.apply(clearSessionCookie, undefined, ["not-host"])).toThrow(
      "INVALID_COOKIE_NAME",
    );
    await expect(
      Reflect.apply(sealSessionCookie, undefined, ["bad name", {}, "secret", 1]),
    ).rejects.toThrow("INVALID_COOKIE_NAME");
    await expect(sealSessionCookie("__Host-test", {}, " ", 1)).rejects.toThrow(
      "COOKIE_KEY_MISSING",
    );
    await expect(sealSessionCookie("__Host-test", {}, "secret", -1)).rejects.toThrow(
      "INVALID_TIMESTAMP",
    );
  });

  it("rejects empty, duplicate, malformed, short, and structurally invalid encrypted cookies", async () => {
    const invalidPayload = await encryptedCookie("__Host-test", TEST_ENV.COOKIE_ENCRYPTION_KEY, "[]");
    for (const cookie of [
      "__Host-test=",
      "__Host-test=A; __Host-test=B",
      "__Host-test=%",
      "__Host-test=A",
      invalidPayload,
    ]) {
      await expect(
        openSessionCookie(
          new Request("https://gateway.test/callback", { headers: { cookie } }),
          "__Host-test",
          TEST_ENV.COOKIE_ENCRYPTION_KEY,
          Date.now(),
        ),
      ).rejects.toThrow("OAUTH_SESSION_INVALID");
    }
  });

  it("rejects invalid Access configuration and token-envelope shapes without identity leakage", async () => {
    const valid = accessInput();
    await expect(
      exchangeAndVerifyAccessCode({ ...valid, code: " " }, { fetch: vi.fn() }),
    ).rejects.toThrow("ACCESS_CONFIGURATION_INVALID");
    await expect(
      exchangeAndVerifyAccessCode({ ...valid, issuer: "http://access.example.test" }, { fetch: vi.fn() }),
    ).rejects.toThrow("ACCESS_CONFIGURATION_INVALID");
    await expect(
      exchangeAndVerifyAccessCode(valid, { fetch: async () => new Response(null, { status: 401 }) }),
    ).rejects.toThrow("ACCESS_IDENTITY_REJECTED");
    for (const body of [null, {}, { id_token: 7 }]) {
      await expect(
        exchangeAndVerifyAccessCode(valid, {
          fetch: async () => Response.json(body),
        }),
      ).rejects.toThrow("ACCESS_IDENTITY_REJECTED");
    }
  });

  it("rejects missing subject and non-normalizable email claims, and supports the default fetch path", async () => {
    const keys = await accessKeys();
    const input = accessInput();
    const fetchFor = (token: string) => async (target: RequestInfo | URL) =>
      String(target).endsWith("/jwks")
        ? Response.json(keys.jwks)
        : Response.json({ id_token: token });

    for (const token of [
      await signedAccessToken(input.nonce, { email: 7 }),
      await signedAccessToken(input.nonce, { email: " " }),
      await signedAccessToken(input.nonce, { subject: null }),
    ]) {
      await expect(
        exchangeAndVerifyAccessCode(input, { fetch: fetchFor(token) }),
      ).rejects.toThrow("ACCESS_IDENTITY_REJECTED");
    }

    const validToken = await signedAccessToken(input.nonce);
    vi.stubGlobal("fetch", fetchFor(validToken));
    await expect(exchangeAndVerifyAccessCode(input)).resolves.toMatchObject({
      scopes: ["mcp:read"],
    });
  });
});

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type MutableAuthorizationEnvironment = Mutable<
  Omit<IWindAuthorizationEnvironment, "OAUTH_PROVIDER">
> & {
  OAUTH_PROVIDER: Mutable<IWindAuthorizationEnvironment["OAUTH_PROVIDER"]>;
};

function directAuthorizationEnv(): MutableAuthorizationEnvironment {
  const authRequest = {
    responseType: "code",
    clientId: "client-01",
    redirectUri: REDIRECT_URI,
    scope: ["mcp:read"],
    state: "client-state",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    resource: "https://gateway.test/mcp",
    issuer: "https://gateway.test",
  } as const;
  return {
    PUBLIC_ORIGIN: "https://gateway.test",
    COOKIE_ENCRYPTION_KEY: TEST_ENV.COOKIE_ENCRYPTION_KEY,
    ACCESS_CLIENT_ID: TEST_ENV.ACCESS_CLIENT_ID,
    ACCESS_CLIENT_SECRET: TEST_ENV.ACCESS_CLIENT_SECRET,
    ACCESS_AUTHORIZATION_URL: TEST_ENV.ACCESS_AUTHORIZATION_URL,
    ACCESS_TOKEN_URL: TEST_ENV.ACCESS_TOKEN_URL,
    ACCESS_JWKS_URL: TEST_ENV.ACCESS_JWKS_URL,
    ACCESS_ISSUER: TEST_ENV.ACCESS_ISSUER,
    ACCESS_AUDIENCE: TEST_ENV.ACCESS_AUDIENCE,
    ALLOWED_USER_EMAIL: TEST_ENV.ALLOWED_USER_EMAIL,
    KEY_POOL: {
      getByName: () => ({
        setOAuthReplayMarker: async () => undefined,
        consumeOAuthReplayMarker: async () => true,
      }),
    },
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({ ...authRequest, scope: [...authRequest.scope] }),
      lookupClient: async () => ({
        clientId: "client-01",
        clientName: "Task 10 client",
        clientUri: "https://client.example.test",
        redirectUris: [REDIRECT_URI],
        tokenEndpointAuthMethod: "none" as const,
      }),
      completeAuthorization: async () => ({ redirectTo: `${REDIRECT_URI}?code=approved` }),
    },
  } as unknown as MutableAuthorizationEnvironment;
}

function consentSession() {
  return {
    phase: "consent",
    oauthRequest: {
      responseType: "code",
      clientId: "client-01",
      redirectUri: REDIRECT_URI,
      scope: ["mcp:read"],
      state: "client-state",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      resource: "https://gateway.test/mcp",
      issuer: "https://gateway.test" as string | undefined,
    },
    client: {
      clientId: "client-01",
      clientName: "Task 10 client",
      clientUri: "https://client.example.test",
    },
    authProps: { userId: "user-01", emailHash: "email-hash", scopes: ["mcp:read"] },
    csrf: "csrf",
    marker: "marker",
  };
}

function accessInput() {
  return {
    code: "access-code",
    nonce: "nonce",
    redirectUri: "https://gateway.test/callback",
    clientId: TEST_ENV.ACCESS_CLIENT_ID,
    clientSecret: TEST_ENV.ACCESS_CLIENT_SECRET,
    tokenUrl: TEST_ENV.ACCESS_TOKEN_URL,
    jwksUrl: TEST_ENV.ACCESS_JWKS_URL,
    issuer: TEST_ENV.ACCESS_ISSUER,
    audience: TEST_ENV.ACCESS_AUDIENCE,
    allowedEmail: TEST_ENV.ALLOWED_USER_EMAIL,
  };
}

function cookieValue(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

async function gatewayFetch(
  provider: ReturnType<typeof createOAuthProvider>,
  request: Request,
): Promise<Response> {
  const headers = new Headers(request.headers);
  if (!headers.has("host")) headers.set("host", new URL(request.url).host);
  const routedRequest = new Request(request, { headers });
  const context = createExecutionContext();
  const response = await provider.fetch(routedRequest, TEST_ENV, context);
  await waitOnExecutionContext(context);
  return response;
}

async function upstreamFixture(): Promise<{
  fetch: FetchLike;
  idToken: string;
  calledTools: string[];
  calledUrls: string[];
  authorizationSlots: string[];
  readonly maximumInFlight: number;
}> {
  const keys = await accessKeys();
  const fixture = {
    idToken: "",
    calledTools: [] as string[],
    calledUrls: [] as string[],
    authorizationSlots: [] as string[],
    inFlight: 0,
    maximum: 0,
    get maximumInFlight() {
      return fixture.maximum;
    },
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      if (url.href === TEST_ENV.ACCESS_TOKEN_URL) {
        return Response.json({ id_token: fixture.idToken });
      }
      if (url.href === TEST_ENV.ACCESS_JWKS_URL) {
        return Response.json(keys.jwks);
      }
      if (url.hostname !== "mcp.wind.com.cn") {
        throw new Error("UNEXPECTED_TEST_FETCH");
      }
      const message: unknown = JSON.parse(String(init?.body));
      if (!isRecord(message) || typeof message.method !== "string") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "server/discover") {
        return new Response("legacy endpoint", { status: 404 });
      }
      if (message.method === "initialize") {
        return jsonRpc(message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "task-10-upstream-fixture", version: "1" },
        });
      }
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "tools/call") {
        fixture.inFlight += 1;
        fixture.maximum = Math.max(fixture.maximum, fixture.inFlight);
        try {
          const params = isRecord(message.params) ? message.params : {};
          const name = typeof params.name === "string" ? params.name : "";
          fixture.calledTools.push(name);
          fixture.calledUrls.push(url.href);
          const authorization = new Headers(init?.headers).get("authorization");
          fixture.authorizationSlots.push(
            authorization === `Bearer ${TEST_ENV.WIND_API_KEY_03}` ? "key-03" : "unexpected",
          );
          return jsonRpc(message.id, {
            content: [{ type: "text", text: "synthetic-upstream-success" }],
            isError: false,
          });
        } finally {
          fixture.inFlight -= 1;
        }
      }
      return new Response("unexpected MCP method", { status: 500 });
    }) satisfies FetchLike,
  };
  return fixture;
}

let keyFixture: Awaited<ReturnType<typeof createAccessKeys>> | undefined;
async function createAccessKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    jwks: { keys: [{ ...jwk, kid: "task-10-key", alg: "RS256", use: "sig" }] },
  };
}

async function accessKeys(): Promise<Awaited<ReturnType<typeof createAccessKeys>>> {
  keyFixture ??= await createAccessKeys();
  return keyFixture;
}

async function signedAccessToken(
  nonce: string,
  overrides: { readonly email?: unknown; readonly subject?: string | null } = {},
): Promise<string> {
  const keys = await accessKeys();
  const now = Math.floor(Date.now() / 1000);
  let token = new SignJWT({
    nonce,
    email: overrides.email === undefined ? TEST_ENV.ALLOWED_USER_EMAIL : overrides.email,
  })
    .setProtectedHeader({ alg: "RS256", kid: "task-10-key" })
    .setIssuer(TEST_ENV.ACCESS_ISSUER)
    .setAudience(TEST_ENV.ACCESS_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300);
  if (overrides.subject !== null) {
    token = token.setSubject(overrides.subject ?? "task-10-access-subject");
  }
  return token.sign(keys.privateKey);
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function firstCookie(response: Response): string {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

function jsonRpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function encryptedCookie(name: string, secret: string, plaintext: string): Promise<string> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
      key,
      encoder.encode(plaintext),
    ),
  );
  const bytes = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  bytes.set(iv);
  bytes.set(ciphertext, iv.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${name}=${encoded}`;
}
