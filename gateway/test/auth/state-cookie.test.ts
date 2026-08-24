import { describe, expect, it } from "vitest";

import {
  clearSessionCookie,
  openSessionCookie,
  sealSessionCookie,
} from "../../src/auth/state-cookie";

const SECRET = "cookie-test-secret-with-enough-entropy";
const NOW = Date.UTC(2035, 7, 24);

describe("encrypted OAuth session cookies", () => {
  it("round-trips only through a 10-minute __Host cookie with required attributes", async () => {
    const setCookie = await sealSessionCookie(
      "__Host-iwind-flow",
      { state: "opaque-state", nested: { scope: ["mcp:read"] } },
      SECRET,
      NOW,
    );

    expect(setCookie).toContain("; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600");
    expect(setCookie).not.toContain("opaque-state");
    const request = new Request("https://gateway.test/callback", {
      headers: { cookie: setCookie.split(";", 1)[0] ?? "" },
    });
    await expect(
      openSessionCookie<{ state: string; nested: { scope: string[] } }>(
        request,
        "__Host-iwind-flow",
        SECRET,
        NOW + 599_000,
      ),
    ).resolves.toEqual({ state: "opaque-state", nested: { scope: ["mcp:read"] } });
  });

  it("rejects tampering, missing cookies, and expiry", async () => {
    const setCookie = await sealSessionCookie(
      "__Host-iwind-flow",
      { state: "state" },
      SECRET,
      NOW,
    );
    const cookie = setCookie.split(";", 1)[0] ?? "";
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;

    await expect(
      openSessionCookie(new Request("https://gateway.test/callback"), "__Host-iwind-flow", SECRET, NOW),
    ).rejects.toThrow("OAUTH_SESSION_INVALID");
    await expect(
      openSessionCookie(
        new Request("https://gateway.test/callback", { headers: { cookie: tampered } }),
        "__Host-iwind-flow",
        SECRET,
        NOW,
      ),
    ).rejects.toThrow("OAUTH_SESSION_INVALID");
    await expect(
      openSessionCookie(
        new Request("https://gateway.test/callback", { headers: { cookie } }),
        "__Host-iwind-flow",
        SECRET,
        NOW + 600_001,
      ),
    ).rejects.toThrow("OAUTH_SESSION_EXPIRED");
    expect(clearSessionCookie("__Host-iwind-flow")).toContain("Max-Age=0");
  });
});
