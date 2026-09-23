import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { classifyWindFailure, validateWindSignalRules } from "../../src/errors/classifier";
import type { WindFailureCategory } from "../../src/errors/types";

const NOW = 1_700_000_000_000;
const INVALID_HTTP_DATE = "Thu, 31 Apr 2026 00:00:00 GMT";
const INVALID_HTTP_DATE_NOW = Date.UTC(2026, 4, 1) - 2000;
const FIXTURES = new URL("../fixtures/errors/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), "utf8");
}

async function byteFixture(name: string): Promise<Uint8Array> {
  const value: unknown = JSON.parse(await fixture(name));
  if (typeof value !== "object" || value === null || !Array.isArray((value as { bytes?: unknown }).bytes)) {
    throw new Error("invalid byte fixture");
  }
  return new Uint8Array((value as { bytes: number[] }).bytes);
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

  it("fails closed when a bounded byte envelope contains invalid UTF-8", async () => {
    const result = classifyWindFailure({ body: await byteFixture("invalid-utf8.json"), now: NOW });

    expect(result.category).toBe("unknown");
    expect(result.decision).toEqual({ kind: "stop" });
  });

  it.each([
    [429, "qps", { kind: "retry_same_slot", delayMs: 3000, maxRetries: 1 }, null],
    [401, "daily_quota", { kind: "failover_slot", disableAs: "exhausted_until_reset" }, null],
    [403, "daily_quota", { kind: "failover_slot", disableAs: "exhausted_until_reset" }, null],
    [400, "unknown", { kind: "stop" }, null],
    [404, "unknown", { kind: "stop" }, null],
    [503, "upstream_5xx", { kind: "retry_same_slot", delayMs: 500, maxRetries: 1 }, null],
  ] as const)(
    "classifies HTTP %i by status: 401 and 403 without a vendor code are daily-quota failover",
    (status, category, decision, resetAt) => {
      const result = classifyWindFailure({ status, now: NOW });

      expect(result.category).toBe(category);
      expect(result.decision).toEqual(decision);
      expect(result.resetAt).toBe(resetAt);
      if (status === 401 || status === 403) {
        expect(result.stableCode).toBe("WIND_DAILY_QUOTA");
      }
    },
  );

  it("treats an HTTP 401 with a non-structured HTML body as daily-quota failover without a trusted reset", () => {
    const htmlPage = "<!doctype html><html><head><title>403</title></head><body>Forbidden</body></html>";
    const result = classifyWindFailure({
      status: 401,
      headers: { "content-type": "text/html" },
      body: htmlPage,
      now: NOW,
    });

    expect(result.category).toBe("daily_quota");
    expect(result.stableCode).toBe("WIND_DAILY_QUOTA");
    expect(result.decision).toEqual({ kind: "failover_slot", disableAs: "exhausted_until_reset" });
    expect(result.resetAt).toBeNull();
  });

  it("keeps an unrecognized structured code on HTTP 401 unknown", () => {
    const result = classifyWindFailure({
      status: 401,
      body: JSON.stringify({ error: { code: "SOMETHING_ELSE" } }),
      now: NOW,
    });

    expect(result.category).toBe("unknown");
    expect(result.stableCode).toBe("WIND_UNKNOWN");
    expect(result.decision).toEqual({ kind: "stop" });
    expect(result.upstreamStatus).toBe(401);
    expect(result.upstreamErrorCode).toBe("SOMETHING_ELSE");
  });

  it("lets an exact structured code win over a 401 or 403 status", async () => {
    const dailyOn401 = classifyWindFailure({ status: 401, body: await fixture("daily-limit.json"), now: NOW });
    const balanceOn403 = classifyWindFailure({ status: 403, body: await fixture("balance.json"), now: NOW });
    const authOn401 = classifyWindFailure({ status: 401, body: await fixture("auth.json"), now: NOW });
    const rateLimitOn403 = classifyWindFailure({ status: 403, body: await fixture("rate-limit.json"), now: NOW });

    expect(dailyOn401.category).toBe("daily_quota");
    expect(dailyOn401.decision).toEqual({ kind: "failover_slot", disableAs: "exhausted_until_reset" });
    expect(balanceOn403.category).toBe("balance");
    expect(balanceOn403.decision).toEqual({ kind: "failover_slot", disableAs: "disabled_balance" });
    expect(authOn401.category).toBe("auth");
    expect(authOn401.stableCode).toBe("WIND_AUTH");
    expect(authOn401.decision).toEqual({ kind: "failover_slot", disableAs: "disabled_auth" });
    expect(rateLimitOn403.category).toBe("qps");
  });

  it("does not infer authentication from message text on a non-auth status", () => {
    const result = classifyWindFailure({
      status: 400,
      body: JSON.stringify({ message: "AUTH_ERROR: invalid token" }),
      now: NOW,
    });

    expect(result.category).toBe("unknown");
    expect(result.decision).toEqual({ kind: "stop" });
  });

  it.each([
    ["2", 2000],
    ["Tue, 14 Nov 2023 22:13:22 GMT", 2000],
    ["6", 3000],
    ["2.5", 3000],
    ["2023-11-14T22:13:22.000Z", 3000],
    ["invalid", 3000],
  ] as const)("uses bounded Retry-After value %s", (retryAfter, delayMs) => {
    const result = classifyWindFailure({ status: 429, headers: { "retry-after": retryAfter }, now: NOW });

    expect(result.decision).toEqual({ kind: "retry_same_slot", delayMs, maxRetries: 1 });
  });

  it("rejects an impossible IMF-fixdate Retry-After instead of accepting runtime normalization", () => {
    const result = classifyWindFailure({
      status: 429,
      headers: { "retry-after": INVALID_HTTP_DATE },
      now: INVALID_HTTP_DATE_NOW,
    });

    expect(result.decision).toEqual({ kind: "retry_same_slot", delayMs: 3000, maxRetries: 1 });
  });

  it("honors case-insensitive record headers and native Headers", async () => {
    const titleCasedRetryAfter = classifyWindFailure({ status: 429, headers: { "Retry-After": "2" }, now: NOW });
    const titleCasedReset = classifyWindFailure({
      body: await fixture("balance.json"),
      headers: { "X-RateLimit-Reset": "Tue, 14 Nov 2023 22:13:22 GMT" },
      now: NOW,
    });
    const nativeHeaders = classifyWindFailure({
      status: 429,
      headers: new Headers({ "Retry-After": "2" }),
      now: NOW,
    });

    expect(titleCasedRetryAfter.decision).toEqual({ kind: "retry_same_slot", delayMs: 2000, maxRetries: 1 });
    expect(titleCasedReset.resetAt).toBe(1_700_000_002_000);
    expect(nativeHeaders.decision).toEqual({ kind: "retry_same_slot", delayMs: 2000, maxRetries: 1 });
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
    const impossibleHttpDate = classifyWindFailure({
      body: await fixture("balance.json"),
      headers: { "x-ratelimit-reset": INVALID_HTTP_DATE },
      now: INVALID_HTTP_DATE_NOW,
    });

    expect(future.resetAt).toBe(1_700_000_002_000);
    expect(expired.resetAt).toBeNull();
    expect(nonHttpDate.resetAt).toBeNull();
    expect(impossibleHttpDate.resetAt).toBeNull();
  });

  it("logs a bounded dotted code without treating it as daily quota", () => {
    const dotted = classifyWindFailure({
      status: 200,
      body: JSON.stringify({ error: { code: "vendor.code-1" } }),
      now: NOW,
    });
    const urlShaped = classifyWindFailure({
      status: 200,
      body: JSON.stringify({ error: { code: "https://vendor.example/callback" } }),
      now: NOW,
    });
    const tooLong = classifyWindFailure({
      body: JSON.stringify({ error: { code: "A".repeat(65) } }),
      now: NOW,
    });
    const atCap = classifyWindFailure({
      body: JSON.stringify({ error: { code: `a.b-${"C".repeat(60)}` } }),
      now: NOW,
    });

    expect(dotted.category).toBe("unknown");
    expect(dotted.decision).toEqual({ kind: "stop" });
    expect(dotted.upstreamStatus).toBe(200);
    expect(dotted.upstreamErrorCode).toBe("vendor.code-1");
    expect(urlShaped.category).toBe("unknown");
    expect(urlShaped.upstreamErrorCode).toBeNull();
    expect(tooLong.upstreamErrorCode).toBeNull();
    expect(atCap.upstreamErrorCode).toHaveLength(64);
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
      classifyWindFailure({ status: 401, now: NOW }),
      classifyWindFailure({ status: 503, now: NOW }),
      classifyWindFailure({ error: new TypeError("synthetic"), now: NOW }),
      classifyWindFailure({ body: "not JSON", now: NOW }),
    ];

    expect(results.map((result) => result.stableCode)).toEqual([
      "WIND_QPS",
      "WIND_DAILY_QUOTA",
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
