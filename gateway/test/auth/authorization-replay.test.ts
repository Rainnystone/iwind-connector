import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleAuthorizationRequest } from "../../src/auth/authorization-handler";

const NOW = Date.UTC(2035, 7, 24);
const AUTH_REQUEST: AuthRequest = {
  responseType: "code",
  clientId: "client-01",
  redirectUri: "https://client.example.test/callback",
  scope: ["mcp:read"],
  state: "client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  resource: "https://gateway.test/mcp",
  issuer: "https://gateway.test",
};
const CLIENT: ClientInfo = {
  clientId: "client-01",
  clientName: "Replay test client",
  redirectUris: [AUTH_REQUEST.redirectUri],
  tokenEndpointAuthMethod: "none",
};

afterEach(async () => {
  await reset();
});

describe("authorization replay coordination", () => {
  it("allows only one concurrent Access callback to enter token exchange", async () => {
    const fixture = await fixtureEnv();
    const started = await handleAuthorizationRequest(
      new Request("https://gateway.test/authorize"),
      fixture.authorizationEnv,
      fixture.dependencies,
    );
    const redirect = new URL(started.headers.get("location") ?? "");
    fixture.token = await signedToken(redirect.searchParams.get("nonce") ?? "");
    const callback = new URL("https://gateway.test/callback");
    callback.searchParams.set("code", "access-code");
    callback.searchParams.set("state", redirect.searchParams.get("state") ?? "");
    const cookie = cookiePair(started);

    const responses = await Promise.all([
      handleAuthorizationRequest(
        new Request(callback, { headers: { cookie } }),
        fixture.authorizationEnv,
        fixture.dependencies,
      ),
      handleAuthorizationRequest(
        new Request(callback, { headers: { cookie } }),
        fixture.authorizationEnv,
        fixture.dependencies,
      ),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(fixture.tokenExchanges).toHaveBeenCalledOnce();
    expect(fixture.objectNames).not.toHaveLength(0);
    expect(fixture.objectNames.every((objectName) => objectName === "private-key-pool")).toBe(true);
  });

  it("allows only one concurrent consent to enter completeAuthorization", async () => {
    const fixture = await fixtureEnv();
    const consent = await reachConsent(fixture);
    const html = await consent.clone().text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/u)?.[1] ?? "";
    const cookie = cookiePair(consent);
    const request = () =>
      new Request("https://gateway.test/callback", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "approve", csrf }),
      });

    const responses = await Promise.all([
      handleAuthorizationRequest(request(), fixture.authorizationEnv, fixture.dependencies),
      handleAuthorizationRequest(request(), fixture.authorizationEnv, fixture.dependencies),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
    expect(fixture.completeAuthorization).toHaveBeenCalledOnce();
    expect(fixture.objectNames).not.toHaveLength(0);
    expect(fixture.objectNames.every((objectName) => objectName === "private-key-pool")).toBe(true);
  });
});

async function reachConsent(fixture: Awaited<ReturnType<typeof fixtureEnv>>): Promise<Response> {
  const started = await handleAuthorizationRequest(
    new Request("https://gateway.test/authorize"),
    fixture.authorizationEnv,
    fixture.dependencies,
  );
  const redirect = new URL(started.headers.get("location") ?? "");
  fixture.token = await signedToken(redirect.searchParams.get("nonce") ?? "");
  const callback = new URL("https://gateway.test/callback");
  callback.searchParams.set("code", "access-code");
  callback.searchParams.set("state", redirect.searchParams.get("state") ?? "");
  return handleAuthorizationRequest(
    new Request(callback, { headers: { cookie: cookiePair(started) } }),
    fixture.authorizationEnv,
    fixture.dependencies,
  );
}

async function fixtureEnv() {
  const signed = await keyFixture();
  const completeAuthorization = vi.fn(async () => ({
    redirectTo: "https://client.example.test/approved",
  }));
  const tokenExchanges = vi.fn();
  const fixture = {
    token: "",
    objectNames: [] as string[],
    tokenExchanges,
    completeAuthorization,
    authorizationEnv: {
      PUBLIC_ORIGIN: "https://gateway.test",
      COOKIE_ENCRYPTION_KEY: "cookie-encryption-key",
      ACCESS_CLIENT_ID: "access-client",
      ACCESS_CLIENT_SECRET: "access-secret",
      ACCESS_AUTHORIZATION_URL: "https://access.example.test/authorize",
      ACCESS_TOKEN_URL: "https://access.example.test/token",
      ACCESS_JWKS_URL: "https://access.example.test/jwks",
      ACCESS_ISSUER: "https://access.example.test",
      ACCESS_AUDIENCE: "access-audience",
      ALLOWED_USER_EMAIL: "allowed@example.test",
      KEY_POOL: {
        getByName(objectName: string) {
          fixture.objectNames.push(objectName);
          return env.KEY_POOL.getByName(objectName);
        },
      },
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => AUTH_REQUEST,
        lookupClient: async () => CLIENT,
        completeAuthorization,
      },
    } as never,
    dependencies: {
      now: () => NOW,
      fetch: async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/jwks")) return Response.json(signed.jwks);
        tokenExchanges();
        await Promise.resolve();
        return Response.json({ id_token: fixture.token });
      },
    },
  };
  return fixture;
}

let keys: Awaited<ReturnType<typeof createKeyFixture>> | undefined;
async function createKeyFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwks: { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] } };
}
async function keyFixture() {
  keys ??= await createKeyFixture();
  return keys;
}
async function signedToken(nonce: string): Promise<string> {
  const fixture = await keyFixture();
  return new SignJWT({ nonce, email: "allowed@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("access-subject")
    .setIssuer("https://access.example.test")
    .setAudience("access-audience")
    .setIssuedAt(Math.floor(NOW / 1000))
    .setExpirationTime(Math.floor(NOW / 1000) + 300)
    .sign(fixture.privateKey);
}

function cookiePair(response: Response): string {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}
