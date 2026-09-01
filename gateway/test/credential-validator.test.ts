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
        contentCount: 1,
        contentTypes: ["text"],
      },
    });
    expect(calls).toEqual([["get_stock_price_indicators", { windcode: "600519.SH" }]]);
    expect(closes).toBe(1);
  });

  it("maps hostile content types to unknown and never emits hostile fields or values", async () => {
    let calls = 0;
    const dependencies: CredentialValidatorDependencies = {
      getCredential: () => "test-only-key",
      createSession: async () => ({
        async callTool() {
          calls += 1;
          return {
            content: [
              { type: "text", text: "private business payload" },
              {
                type: "HOSTILE_CONTENT_TYPE_WITH_KEY_MATERIAL",
                HOSTILE_CONTENT_FIELD: "private field value",
              },
            ],
            isError: false,
            HOSTILE_TOP_LEVEL_FIELD: "private top-level value",
          };
        },
        async close() {},
      }),
    };

    const result = await validateWindCredential("key-04", dependencies);

    expect(result).toEqual({
      slot: "key-04",
      status: "success",
      responseShape: {
        contentCount: 2,
        contentTypes: ["text", "unknown"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("HOSTILE");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(calls).toBe(1);
  });

  it.each([
    ["null", null],
    ["a primitive", "malformed"],
    ["an array", []],
    ["missing content", {}],
    ["non-array content", { content: "malformed" }],
    ["true isError", { content: [], isError: true }],
    ["non-boolean isError", { content: [], isError: "false" }],
    ["a null content item", { content: [null] }],
    ["an array content item", { content: [[]] }],
    ["a content item without type", { content: [{}] }],
    ["a content item with non-string type", { content: [{ type: 7 }] }],
  ] as const)("fails anonymously for %s after exactly one upstream call", async (_label, response) => {
    let calls = 0;
    let closes = 0;
    const dependencies: CredentialValidatorDependencies = {
      getCredential: () => "test-only-key",
      createSession: async () => ({
        async callTool() {
          calls += 1;
          return response as never;
        },
        async close() {
          closes += 1;
        },
      }),
    };

    await expect(validateWindCredential("key-04", dependencies)).resolves.toEqual({
      slot: "key-04",
      status: "failure",
    });
    expect(calls).toBe(1);
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
