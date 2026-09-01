import { describe, expect, it } from "vitest";

import {
  validateWindCredential,
  type CredentialValidatorDependencies,
} from "../scripts/validate-wind-credential";

describe("credential validator", () => {
  it("makes exactly one read-only representative call and returns only anonymous slot status and shape", async () => {
    const calls: Array<readonly [string, Readonly<Record<string, unknown>>]> = [];
    let closes = 0;
    const dependencies: CredentialValidatorDependencies = {
      getCredential: (binding) => binding === "WIND_API_KEY_04" ? "test-only-key" : undefined,
      createSession: async () => ({
        async callTool(tool, input) {
          calls.push([tool, input]);
          return {
            content: [{ type: "text", text: "business payload must not be emitted" }],
            structuredContent: { sensitive: "business payload must not be emitted" },
            isError: false,
          };
        },
        async close() {
          closes += 1;
        },
      }),
    };

    await expect(validateWindCredential("key-04", dependencies)).resolves.toEqual({
      slot: "key-04",
      status: "success",
      responseShape: {
        type: "object",
        keys: ["content", "isError", "structuredContent"],
        contentCount: 1,
        contentTypes: ["text"],
      },
    });
    expect(calls).toEqual([["get_stock_price_indicators", { windcode: "600519.SH" }]]);
    expect(closes).toBe(1);
  });

  it("fails closed without revealing a missing credential, upstream message, URL, or business data", async () => {
    const dependencies: CredentialValidatorDependencies = {
      getCredential: () => undefined,
      createSession: async () => {
        throw new Error("must not connect");
      },
    };

    await expect(validateWindCredential("key-05", dependencies)).resolves.toEqual({
      slot: "key-05",
      status: "failure",
    });
    await expect(validateWindCredential("not-a-slot", dependencies)).resolves.toEqual({
      slot: "unknown",
      status: "failure",
    });
  });

  it("fails closed when closing a successful session rejects without exposing that error", async () => {
    const dependencies: CredentialValidatorDependencies = {
      getCredential: () => "test-only-key",
      createSession: async () => ({
        async callTool() {
          return { content: [{ type: "text", text: "business payload" }], isError: false };
        },
        async close() {
          throw new Error("private close failure with credential-like material");
        },
      }),
    };

    await expect(validateWindCredential("key-04", dependencies)).resolves.toEqual({
      slot: "key-04",
      status: "failure",
    });
  });
});
