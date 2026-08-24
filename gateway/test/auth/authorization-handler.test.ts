import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { handleAuthorizationRequest } from "../../src/auth/authorization-handler";

const NOW = Date.UTC(2035, 7, 24);
const AUTH_REQUEST: AuthRequest = {
  responseType: "code",
  clientId: "client-01",
  redirectUri: "https://client.example.test/callback",
  scope: ["mcp:read", "unsupported"],
  state: "client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  resource: "https://gateway.test/mcp",
  issuer: "https://gateway.test",
};
const CLIENT: ClientInfo = {
  clientId: "client-01",
  clientName: '<script>alert("x")</script>',
  redirectUris: [AUTH_REQUEST.redirectUri],
  tokenEndpointAuthMethod: "none",
};

describe("authorization and explicit consent flow", () => {
  it("starts Access login without putting the raw OAuth request in the URL", async () => {
    const fixture = authFixture();
    const response = await handleAuthorizationRequest(
      new Request("https://gateway.test/authorize?client_id=client-01"),
      fixture.env,
      fixture.dependencies,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://access.example.test/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("openid email");
    expect(location.searchParams.get("redirect_uri")).toBe("https://gateway.test/callback");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.href).not.toContain(AUTH_REQUEST.redirectUri);
    expect(location.href).not.toContain("client-state");
    expect(response.headers.get("set-cookie")).toContain("__Host-iwind-access=");
  });

  it("fails locally when a validated client metadata lookup cannot be resolved", async () => {
    const fixture = authFixture();
    fixture.env.OAUTH_PROVIDER.lookupClient = async () => {
      throw new Error("private metadata resolution detail");
    };

    const response = await handleAuthorizationRequest(
      new Request("https://gateway.test/authorize"),
      fixture.env,
      fixture.dependencies,
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("OAuth client could not be resolved");
    expect(response.headers.get("location")).toBeNull();
  });

  it("verifies callback state once and renders escaped explicit consent", async () => {
    const fixture = authFixture();
    const started = await handleAuthorizationRequest(
      new Request("https://gateway.test/authorize"),
      fixture.env,
      fixture.dependencies,
    );
    const accessCookie = cookiePair(started);
    const redirect = new URL(started.headers.get("location") ?? "");
    fixture.token = await signedIdToken(redirect.searchParams.get("nonce") ?? "");
    const callbackUrl = new URL("https://gateway.test/callback");
    callbackUrl.searchParams.set("code", "access-code");
    callbackUrl.searchParams.set("state", redirect.searchParams.get("state") ?? "");

    const consent = await handleAuthorizationRequest(
      new Request(callbackUrl, { headers: { cookie: accessCookie } }),
      fixture.env,
      fixture.dependencies,
    );
    const html = await consent.text();
    expect(consent.status).toBe(200);
    expect(html).toContain("Approve");
    expect(html).toContain("mcp:read");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(fixture.completeAuthorization).not.toHaveBeenCalled();

    const replay = await handleAuthorizationRequest(
      new Request(callbackUrl, { headers: { cookie: accessCookie } }),
      fixture.env,
      fixture.dependencies,
    );
    expect(replay.status).toBe(400);
  });

  it("calls completeAuthorization only after matching CSRF and explicit approve", async () => {
    const fixture = authFixture();
    const { consent, csrf } = await reachConsent(fixture);
    const approved = await handleAuthorizationRequest(
      new Request("https://gateway.test/callback", {
        method: "POST",
        headers: {
          cookie: cookiePair(consent),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ action: "approve", csrf }),
      }),
      fixture.env,
      fixture.dependencies,
    );

    expect(approved.status).toBe(302);
    expect(approved.headers.get("location")).toBe("https://client.example.test/approved");
    expect(fixture.completeAuthorization).toHaveBeenCalledOnce();
    expect(fixture.completeAuthorization.mock.calls[0]?.[0]).toMatchObject({
      scope: ["mcp:read"],
      props: { scopes: ["mcp:read"] },
    });

    const replay = await handleAuthorizationRequest(
      new Request("https://gateway.test/callback", {
        method: "POST",
        headers: {
          cookie: cookiePair(consent),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ action: "approve", csrf }),
      }),
      fixture.env,
      fixture.dependencies,
    );
    expect(replay.status).toBe(400);
    expect(fixture.completeAuthorization).toHaveBeenCalledOnce();
  });

  it("returns a safe access_denied redirect without granting on explicit deny", async () => {
    const fixture = authFixture();
    const { consent, csrf } = await reachConsent(fixture);
    const denied = await handleAuthorizationRequest(
      new Request("https://gateway.test/callback", {
        method: "POST",
        headers: {
          cookie: cookiePair(consent),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ action: "deny", csrf }),
      }),
      fixture.env,
      fixture.dependencies,
    );

    expect(denied.status).toBe(302);
    const redirect = new URL(denied.headers.get("location") ?? "");
    expect(redirect.origin + redirect.pathname).toBe(AUTH_REQUEST.redirectUri);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("client-state");
    expect(redirect.searchParams.get("iss")).toBe("https://gateway.test");
    expect(fixture.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects ambiguous duplicate consent fields before granting", async () => {
    const fixture = authFixture();
    const { consent, csrf } = await reachConsent(fixture);
    const form = new URLSearchParams();
    form.append("action", "approve");
    form.append("csrf", csrf);
    form.append("csrf", "attacker-value");
    const response = await handleAuthorizationRequest(
      new Request("https://gateway.test/callback", {
        method: "POST",
        headers: {
          cookie: cookiePair(consent),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      }),
      fixture.env,
      fixture.dependencies,
    );

    expect(response.status).toBe(400);
    expect(fixture.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects missing or tampered callback session without granting", async () => {
    const fixture = authFixture();
    const response = await handleAuthorizationRequest(
      new Request("https://gateway.test/callback?code=x&state=y"),
      fixture.env,
      fixture.dependencies,
    );
    expect(response.status).toBe(400);
    expect(fixture.completeAuthorization).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

async function reachConsent(fixture: ReturnType<typeof authFixture>) {
  const started = await handleAuthorizationRequest(
    new Request("https://gateway.test/authorize"),
    fixture.env,
    fixture.dependencies,
  );
  const redirect = new URL(started.headers.get("location") ?? "");
  fixture.token = await signedIdToken(redirect.searchParams.get("nonce") ?? "");
  const callback = new URL("https://gateway.test/callback");
  callback.searchParams.set("code", "access-code");
  callback.searchParams.set("state", redirect.searchParams.get("state") ?? "");
  const consent = await handleAuthorizationRequest(
    new Request(callback, { headers: { cookie: cookiePair(started) } }),
    fixture.env,
    fixture.dependencies,
  );
  const html = await consent.clone().text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/u)?.[1] ?? "";
  return { consent, csrf };
}

function authFixture() {
  const markers = new Set<string>();
  const completeAuthorization = vi.fn(async () => ({
    redirectTo: "https://client.example.test/approved",
  }));
  const fixture = {
    token: "",
    completeAuthorization,
    env: {
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
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => AUTH_REQUEST,
        lookupClient: async () => CLIENT,
        completeAuthorization,
      },
      KEY_POOL: {
        getByName() {
          return {
            async setOAuthReplayMarker(input: { markerId: string }) {
              markers.add(input.markerId);
            },
            async consumeOAuthReplayMarker(input: { markerId: string }) {
              if (!markers.has(input.markerId)) return false;
              markers.delete(input.markerId);
              return true;
            },
          };
        },
      },
    } as never,
    dependencies: {
      now: () => NOW,
      fetch: async (input: RequestInfo | URL) =>
        String(input).endsWith("/jwks")
          ? Response.json((await signedFixture()).jwks)
          : Response.json({ id_token: fixture.token }),
    },
  };
  return fixture;
}

let keyFixture: Awaited<ReturnType<typeof createKeyFixture>> | undefined;
async function createKeyFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwks: { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] } };
}
async function signedFixture() {
  keyFixture ??= await createKeyFixture();
  return keyFixture;
}
async function signedIdToken(nonce: string): Promise<string> {
  const fixture = await signedFixture();
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
