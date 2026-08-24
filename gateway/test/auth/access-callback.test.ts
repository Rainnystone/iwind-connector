import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { exchangeAndVerifyAccessCode } from "../../src/auth/access-oidc";

const ISSUER = "https://access.example.test";
const AUDIENCE = "access-audience";
const EMAIL = "allowed@example.test";
const NOW = Date.UTC(2035, 7, 24);

describe("Cloudflare Access OIDC callback", () => {
  it("exchanges the code, verifies signature/issuer/audience/nonce, and minimizes props", async () => {
    const fixture = await oidcFixture();
    const requests: Request[] = [];

    const props = await exchangeAndVerifyAccessCode(
      accessInput(),
      {
        now: () => NOW,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          if (request.url.endsWith("/token")) {
            return Response.json({ id_token: fixture.token });
          }
          if (request.url.endsWith("/jwks")) return Response.json(fixture.jwks);
          throw new Error("unexpected URL");
        },
      },
    );

    expect(Object.keys(props).sort()).toEqual(["emailHash", "scopes", "userId"]);
    expect(props).toMatchObject({ scopes: ["mcp:read"] });
    expect(props.userId).toMatch(/^u_[a-f0-9]{64}$/);
    expect(props.emailHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(props)).not.toContain(EMAIL);
    const tokenBody = await requests[0]?.clone().text();
    expect(tokenBody).toContain("grant_type=authorization_code");
    expect(tokenBody).toContain("client_secret=access-secret");
  });

  it.each([
    ["issuer", { issuer: "https://wrong.example.test" }],
    ["audience", { audience: "wrong-audience" }],
    ["nonce", { nonce: "wrong-nonce" }],
    ["email", { email: "other@example.test" }],
  ] as const)("rejects a wrong %s claim", async (_name, overrides) => {
    const fixture = await oidcFixture(overrides);
    await expect(
      exchangeAndVerifyAccessCode(accessInput(), {
        now: () => NOW,
        fetch: async (input) =>
          String(input).endsWith("/jwks")
            ? Response.json(fixture.jwks)
            : Response.json({ id_token: fixture.token }),
      }),
    ).rejects.toThrow("ACCESS_IDENTITY_REJECTED");
  });

  it("rejects a token whose signature does not match the configured JWKS", async () => {
    const signed = await oidcFixture();
    const differentKey = await oidcFixture();
    await expect(
      exchangeAndVerifyAccessCode(accessInput(), {
        now: () => NOW,
        fetch: async (input) =>
          String(input).endsWith("/jwks")
            ? Response.json(differentKey.jwks)
            : Response.json({ id_token: signed.token }),
      }),
    ).rejects.toThrow("ACCESS_IDENTITY_REJECTED");
  });

  it("rejects an otherwise valid expired token", async () => {
    const fixture = await oidcFixture();
    await expect(
      exchangeAndVerifyAccessCode(accessInput(), {
        now: () => NOW + 301_000,
        fetch: async (input) =>
          String(input).endsWith("/jwks")
            ? Response.json(fixture.jwks)
            : Response.json({ id_token: fixture.token }),
      }),
    ).rejects.toThrow("ACCESS_IDENTITY_REJECTED");
  });

  it.each(["exp", "iat"] as const)("rejects a signed token missing %s", async (claim) => {
    const fixture = await oidcFixture({}, claim);
    await expect(
      exchangeAndVerifyAccessCode(accessInput(), {
        now: () => NOW,
        fetch: async (input) =>
          String(input).endsWith("/jwks")
            ? Response.json(fixture.jwks)
            : Response.json({ id_token: fixture.token }),
      }),
    ).rejects.toThrow("ACCESS_IDENTITY_REJECTED");
  });

  it("accepts a JWKS response at 256 KiB exactly", async () => {
    const fixture = await oidcFixture();
    const body = padJson(fixture.jwks, 256 * 1024);

    await expect(
      exchangeAndVerifyAccessCode(accessInput(), {
        now: () => NOW,
        fetch: async (input) =>
          String(input).endsWith("/jwks")
            ? new Response(body)
            : Response.json({ id_token: fixture.token }),
      }),
    ).resolves.toMatchObject({ scopes: ["mcp:read"] });
  });

  it("cancels and rejects a streamed JWKS response above 256 KiB", async () => {
    const fixture = await oidcFixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(fixture.jwks)));
        controller.enqueue(new Uint8Array(256 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      exchangeAndVerifyAccessCode(accessInput(), {
        now: () => NOW,
        fetch: async (input) =>
          String(input).endsWith("/jwks")
            ? new Response(body)
            : Response.json({ id_token: fixture.token }),
      }),
    ).rejects.toThrow("ACCESS_IDENTITY_REJECTED");
    expect(cancelled).toBe(true);
  });
});

function accessInput() {
  return {
    code: "access-code",
    nonce: "expected-nonce",
    redirectUri: "https://gateway.test/callback",
    clientId: "access-client",
    clientSecret: "access-secret",
    tokenUrl: `${ISSUER}/token`,
    jwksUrl: `${ISSUER}/jwks`,
    issuer: ISSUER,
    audience: AUDIENCE,
    allowedEmail: EMAIL.toUpperCase(),
  };
}

async function oidcFixture(
  overrides: Partial<{ issuer: string; audience: string; nonce: string; email: string }> = {},
  omittedClaim?: "exp" | "iat",
) {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const issuer = overrides.issuer ?? ISSUER;
  const audience = overrides.audience ?? AUDIENCE;
  let tokenBuilder = new SignJWT({
    nonce: overrides.nonce ?? "expected-nonce",
    email: overrides.email ?? EMAIL,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("access-subject")
    .setIssuer(issuer)
    .setAudience(audience);
  if (omittedClaim !== "iat") tokenBuilder = tokenBuilder.setIssuedAt(Math.floor(NOW / 1000));
  if (omittedClaim !== "exp") {
    tokenBuilder = tokenBuilder.setExpirationTime(Math.floor(NOW / 1000) + 300);
  }
  const token = await tokenBuilder.sign(privateKey);
  return { token, jwks: { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] } };
}

function padJson(value: unknown, size: number): string {
  const json = JSON.stringify(value);
  if (json.length > size) throw new Error("fixture too large");
  return `${json}${" ".repeat(size - json.length)}`;
}
