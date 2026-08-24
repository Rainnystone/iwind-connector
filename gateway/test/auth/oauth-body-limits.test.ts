import { describe, expect, it } from "vitest";

import {
  OAUTH_REGISTER_BODY_LIMIT,
  OAUTH_TOKEN_BODY_LIMIT,
  enforceOAuthProviderBodyLimit,
} from "../../src/auth/oauth-body-limits";

describe("OAuth provider request body limits", () => {
  it.each([
    ["/oauth/token", OAUTH_TOKEN_BODY_LIMIT],
    ["/oauth/register", OAUTH_REGISTER_BODY_LIMIT],
  ] as const)("accepts exact POST %s boundary and rejects +1", async (path, limit) => {
    const accepted = await enforceOAuthProviderBodyLimit(
      post(`https://gateway.test${path}`, new Uint8Array(limit)),
    );
    expect(accepted).toBeInstanceOf(Request);
    if (!(accepted instanceof Request)) throw new Error("unexpected response");
    expect((await accepted.arrayBuffer()).byteLength).toBe(limit);

    const rejected = await enforceOAuthProviderBodyLimit(
      post(`https://gateway.test${path}`, new Uint8Array(limit + 1)),
    );
    expect(rejected).toBeInstanceOf(Response);
    expect((rejected as Response).status).toBe(413);
  });

  it("cancels an oversized unknown-length stream and returns stable 413", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(OAUTH_TOKEN_BODY_LIMIT));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await enforceOAuthProviderBodyLimit(
      new Request("https://gateway.test/oauth/token", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    await expect((result as Response).text()).resolves.toBe("Payload Too Large");
    expect(cancelled).toBe(true);
  });

  it.each([
    ["POST", "/oauth/token/extra"],
    ["POST", "/oauth/register/extra"],
    ["PUT", "/oauth/token"],
  ] as const)("does not consume or limit %s %s", async (method, path) => {
    const request = new Request(`https://gateway.test${path}`, {
      method,
      body: new Uint8Array(OAUTH_REGISTER_BODY_LIMIT + 1),
    });
    await expect(enforceOAuthProviderBodyLimit(request)).resolves.toBe(request);
    expect(request.bodyUsed).toBe(false);
  });
});

function post(url: string, body: Uint8Array): Request {
  return new Request(url, { method: "POST", body });
}
