import { env } from "cloudflare:workers";
import { SELF, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";

import worker from "../../src/index";
import {
  createOAuthProvider,
  createOAuthProviderOptions,
  runOAuthCleanup,
} from "../../src/auth/provider";

describe("OAuth-protected MCP surface", () => {
  it("returns an RFC 9728 challenge for unauthenticated /mcp", async () => {
    const response = await SELF.fetch("http://localhost:8787/mcp");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://localhost:8787/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("publishes exact resource, scope, S256, CIMD, and DCR metadata without implicit flow", async () => {
    const resource = await SELF.fetch(
      "http://localhost:8787/.well-known/oauth-protected-resource/mcp",
    );
    expect(await resource.json()).toEqual({
      resource: "http://localhost:8787/mcp",
      authorization_servers: ["http://localhost:8787"],
      scopes_supported: ["mcp:read"],
      bearer_methods_supported: ["header"],
      resource_name: "iWind AIFin MCP",
    });

    const authorization = await SELF.fetch(
      "http://localhost:8787/.well-known/oauth-authorization-server",
    );
    const metadata = (await authorization.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: "http://localhost:8787",
      authorization_endpoint: "http://localhost:8787/authorize",
      token_endpoint: "http://localhost:8787/oauth/token",
      registration_endpoint: "http://localhost:8787/oauth/register",
      scopes_supported: ["mcp:read"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
    expect(metadata.response_types_supported).toEqual(["code"]);
    expect(metadata.grant_types_supported).not.toContain("implicit");
    expect(metadata.grant_types_supported).not.toContain("urn:ietf:params:oauth:grant-type:token-exchange");
  });

  it("keeps other public paths closed and production test controls indistinguishable from missing", async () => {
    await expect(SELF.fetch("http://localhost:8787/not-a-route")).resolves.toMatchObject({ status: 404 });
    const productionEnv = { ...env, DEPLOYMENT_STAGE: "production", PUBLIC_ORIGIN: "https://gateway.test" };
    const response = await worker.fetch(
      new Request("https://gateway.test/admin/test-controls/next-outcome", {
        method: "POST",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: JSON.stringify({ slotId: "key-01", category: "daily_quota", times: 1 }),
      }),
      productionEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
  });

  it("keeps an HTTPS production issuer and resource exact", async () => {
    const provider = createOAuthProvider("https://gateway.test", "production");
    const response = await provider.fetch(
      new Request("https://gateway.test/.well-known/oauth-protected-resource/mcp"),
      env,
      createExecutionContext(),
    );
    expect(await response.json()).toMatchObject({
      resource: "https://gateway.test/mcp",
      authorization_servers: ["https://gateway.test"],
    });
  });

  it("rejects implicit response type and plain PKCE for a valid registered client", async () => {
    const registered = await SELF.fetch("http://localhost:8787/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Security test client",
        redirect_uris: ["https://client.example.test/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };
    const common = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.example.test/callback",
      scope: "mcp:read",
      state: "client-state",
      resource: "http://localhost:8787/mcp",
    });
    const implicit = new URLSearchParams(common);
    implicit.set("response_type", "token");
    const implicitResponse = await SELF.fetch(`http://localhost:8787/authorize?${implicit}`, {
      redirect: "manual",
    });
    expect(new URL(implicitResponse.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "unsupported_response_type",
    );

    const plain = new URLSearchParams(common);
    plain.set("response_type", "code");
    plain.set("code_challenge", "plain-verifier");
    plain.set("code_challenge_method", "plain");
    const plainResponse = await SELF.fetch(`http://localhost:8787/authorize?${plain}`, {
      redirect: "manual",
    });
    expect(new URL(plainResponse.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "invalid_request",
    );

    const s256 = new URLSearchParams(common);
    s256.set("response_type", "code");
    s256.set("code_challenge", await sha256Base64Url("valid-verifier-012345678901234567890123456789"));
    s256.set("code_challenge_method", "S256");
    const localEnv = {
      OAUTH_KV: env.OAUTH_KV,
      KEY_POOL: env.KEY_POOL,
      PUBLIC_ORIGIN: "http://localhost:8787" as const,
      DEPLOYMENT_STAGE: "local" as const,
      WIND_API_KEY_01: "unused-test-value",
      WIND_API_KEY_02: "unused-test-value",
      ADMIN_TOKEN: "unused-test-value",
      COOKIE_ENCRYPTION_KEY: "local-cookie-encryption-test-value",
      ACCESS_CLIENT_ID: "access-test-client",
      ACCESS_CLIENT_SECRET: "unused-test-value",
      ACCESS_AUTHORIZATION_URL: "https://access.example.test/authorize",
      ACCESS_TOKEN_URL: "https://access.example.test/token",
      ACCESS_JWKS_URL: "https://access.example.test/jwks",
      ACCESS_ISSUER: "https://access.example.test",
      ACCESS_AUDIENCE: "access-test-audience",
      ALLOWED_USER_EMAIL: "allowed@example.test",
    };
    const started = await worker.fetch(
      new Request(`http://localhost:8787/authorize?${s256}`),
      localEnv,
      createExecutionContext(),
    );
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toContain("https://access.example.test/authorize?");
    expect(started.headers.get("set-cookie")).toContain(
      "; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600",
    );
  });

  it("binds an issued token audience to the canonical MCP resource", async () => {
    const options = createOAuthProviderOptions("http://localhost:8787", "local");
    const helpers = getOAuthApi(options, env);
    const client = await helpers.createClient({
      clientName: "Audience test client",
      redirectUris: ["https://client.example.test/callback"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
    });
    const verifier = "audience-test-verifier-which-is-long-enough-0123456789";
    const challenge = await sha256Base64Url(verifier);
    const { redirectTo } = await helpers.completeAuthorization({
      request: {
        responseType: "code",
        clientId: client.clientId,
        redirectUri: "https://client.example.test/callback",
        scope: ["mcp:read"],
        state: "audience-state",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        resource: "http://localhost:8787/mcp",
        issuer: "http://localhost:8787",
      },
      userId: "opaque-test-user",
      metadata: {},
      scope: ["mcp:read"],
      props: { userId: "opaque-test-user", emailHash: "hash", scopes: ["mcp:read"] },
    });
    const code = new URL(redirectTo).searchParams.get("code") ?? "";
    const tokenResponse = await SELF.fetch("http://localhost:8787/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        redirect_uri: "https://client.example.test/callback",
        code,
        code_verifier: verifier,
        resource: "http://localhost:8787/mcp",
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as { access_token: string; resource: string };
    expect(token.resource).toBe("http://localhost:8787/mcp");
    const summary = await helpers.unwrapToken(token.access_token);
    expect(summary?.audience).toBe("http://localhost:8787/mcp");
  });

  it("runs scheduled cleanup with numeric aggregate logging only", async () => {
    const lines: string[] = [];
    await runOAuthCleanup(env, (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual([
      "done",
      "event",
      "grantsChecked",
      "grantsPurged",
      "tokensChecked",
      "tokensPurged",
    ]);
    expect(event.event).toBe("oauth_cleanup");
    for (const key of ["grantsChecked", "grantsPurged", "tokensChecked", "tokensPurged"]) {
      expect(typeof event[key]).toBe("number");
    }
  });
});

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
