import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { classifyWindFailure, validateWindSignalRules } from "../../src/errors/classifier";
import type { WindFailureCategory } from "../../src/errors/types";

const NOW = 1_700_000_000_000;
const FIXTURES = new URL("../fixtures/errors/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), "utf8");
}

describe("Wind failure classifier", () => {
  it.each([
    ["daily-limit.json", "daily_quota", "failover_slot", "exhausted_until_reset"],
    ["balance.json", "balance", "failover_slot", "disabled_balance"],
    ["auth.json", "auth", "failover_slot", "disabled_auth"],
    ["rate-limit.json", "qps", "retry_same_slot", undefined],
    ["concurrency-limit.json", "concurrency", "retry_same_slot", undefined],
  ] as const)(
    "uses only the exact structured code in %s",
    async (name, category, kind, disableAs) => {
      const result = classifyWindFailure({ body: await fixture(name), now: NOW });

      expect(result.category).toBe(category);
      expect(result.decision.kind).toBe(kind);
      if (disableAs !== undefined && result.decision.kind === "failover_slot") {
        expect(result.decision.disableAs).toBe(disableAs);
      }
    },
  );

  it("makes only daily, balance, and auth failures eligible for slot failover", async () => {
    const cases = await Promise.all(
      ["daily-limit.json", "balance.json", "auth.json", "rate-limit.json", "concurrency-limit.json"].map(
        async (name) => classifyWindFailure({ body: await fixture(name), now: NOW }),
      ),
    );

    expect(cases.filter((failure) => failure.decision.kind === "failover_slot")).toHaveLength(3);
  });

  it("keeps textual code fragments and unexpected envelope shapes unknown", async () => {
    const textOnly = classifyWindFailure({ body: await fixture("text-only.json"), now: NOW });
    const unexpectedShape = classifyWindFailure({
      body: JSON.stringify({ failure: { code: "DAILY_LIMIT_ERROR" } }),
      now: NOW,
    });

    expect(textOnly.category).toBe("unknown");
    expect(textOnly.decision).toEqual({ kind: "stop" });
    expect(unexpectedShape.category).toBe("unknown");
    expect(unexpectedShape.decision).toEqual({ kind: "stop" });
  });

  it.each([
    [429, "qps", { kind: "retry_same_slot", delayMs: 3000, maxRetries: 1 }],
    [401, "unknown", { kind: "stop" }],
    [503, "upstream_5xx", { kind: "retry_same_slot", delayMs: 500, maxRetries: 1 }],
  ] as const)("classifies HTTP %i without treating status as a quota or auth signal", (status, category, decision) => {
    const result = classifyWindFailure({ status, now: NOW });

    expect(result.category).toBe(category);
    expect(result.decision).toEqual(decision);
  });

  it.each([
    ["2", 2000],
    ["Tue, 14 Nov 2023 22:13:22 GMT", 2000],
    ["6", 3000],
    ["invalid", 3000],
  ] as const)("uses bounded Retry-After value %s", (retryAfter, delayMs) => {
    const result = classifyWindFailure({ status: 429, headers: { "retry-after": retryAfter }, now: NOW });

    expect(result.decision).toEqual({ kind: "retry_same_slot", delayMs, maxRetries: 1 });
  });

  it("uses fixed retry delays for concurrency, network, timeout, and upstream 5xx", async () => {
    const concurrency = classifyWindFailure({ body: await fixture("concurrency-limit.json"), now: NOW });
    const network = classifyWindFailure({ error: new TypeError("synthetic network failure"), now: NOW });
    const timeoutError = new Error("synthetic timeout");
    timeoutError.name = "AbortError";
    const timeout = classifyWindFailure({ error: timeoutError, now: NOW });
    const upstream = classifyWindFailure({ status: 502, now: NOW });

    expect(concurrency.decision).toEqual({ kind: "retry_same_slot", delayMs: 3000, maxRetries: 1 });
    expect(network.decision).toEqual({ kind: "retry_same_slot", delayMs: 500, maxRetries: 1 });
    expect(timeout.decision).toEqual({ kind: "retry_same_slot", delayMs: 500, maxRetries: 1 });
    expect(upstream.decision).toEqual({ kind: "retry_same_slot", delayMs: 500, maxRetries: 1 });
  });

  it("accepts only a future machine-readable structured reset value", async () => {
    const future = classifyWindFailure({ body: await fixture("daily-limit.json"), now: NOW });
    const past = classifyWindFailure({
      body: JSON.stringify({ error: { code: "DAILY_LIMIT_ERROR", reset_at: 1_699_999_999 } }),
      now: NOW,
    });
    const text = classifyWindFailure({
      body: JSON.stringify({ error: { code: "DAILY_LIMIT_ERROR", reset_at: "tomorrow" } }),
      now: NOW,
    });

    expect(future.resetAt).toBe(1_700_003_600_000);
    expect(past.resetAt).toBeNull();
    expect(text.resetAt).toBeNull();
  });

  it("uses only a future HTTP-date reset header when the structured reset is absent", async () => {
    const future = classifyWindFailure({
      body: await fixture("balance.json"),
      headers: { "x-ratelimit-reset": "Tue, 14 Nov 2023 22:13:22 GMT" },
      now: NOW,
    });
    const expired = classifyWindFailure({
      body: await fixture("balance.json"),
      headers: { "x-ratelimit-reset": "Tue, 14 Nov 2023 22:13:19 GMT" },
      now: NOW,
    });
    const nonHttpDate = classifyWindFailure({
      body: await fixture("balance.json"),
      headers: { "x-ratelimit-reset": "2023-11-14T22:13:22.000Z" },
      now: NOW,
    });

    expect(future.resetAt).toBe(1_700_000_002_000);
    expect(expired.resetAt).toBeNull();
    expect(nonHttpDate.resetAt).toBeNull();
  });

  it("does not parse an oversized envelope or infer a failure category from its text", () => {
    const oversized = `${"x".repeat(16 * 1024)}DAILY_LIMIT_ERROR`;
    const result = classifyWindFailure({ body: oversized, now: NOW });

    expect(result.category).toBe("response_too_large");
    expect(result.decision).toEqual({ kind: "stop" });
  });

  it("returns stable codes for every exposed category", () => {
    const results = [
      classifyWindFailure({ status: 429, now: NOW }),
      classifyWindFailure({ status: 503, now: NOW }),
      classifyWindFailure({ error: new TypeError("synthetic"), now: NOW }),
      classifyWindFailure({ body: "not JSON", now: NOW }),
    ];

    expect(results.map((result) => result.stableCode)).toEqual([
      "WIND_QPS",
      "WIND_UPSTREAM_5XX",
      "WIND_NETWORK",
      "WIND_UNKNOWN",
    ]);
  });

  it("rejects a rule file that claims unapproved evidence", () => {
    expect(() =>
      validateWindSignalRules({
        schemaVersion: 1,
        codeFieldPath: ["error", "code"],
        resetFieldPath: ["error", "reset_at"],
        rules: [
          {
            code: "DAILY_LIMIT_ERROR",
            category: "daily_quota",
            stableCode: "WIND_DAILY_QUOTA",
            evidence: "message_fragment",
          },
        ],
      }),
    ).toThrow("invalid Wind signal rules");
  });

  it("keeps the failure category closed to the documented public union", () => {
    const category: WindFailureCategory = classifyWindFailure({ now: NOW }).category;

    expect(category).toBe("unknown");
  });
});
