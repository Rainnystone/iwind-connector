import type { CallToolResult } from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { invokeWindTool } from "../../src/invocation/invoke";
import { resolveWindSecret } from "../../src/invocation/resolve-secret";
import type {
  InvocationKeyPool,
  InvocationRequest,
  WindToolCaller,
} from "../../src/invocation/types";
import { createWindToolCaller, WindCallFailure } from "../../src/upstream/call-tool";
import { MAX_ERROR_ENVELOPE_BYTES, limitResponseBody } from "../../src/upstream/result-limit";
import { emitLogEvent } from "../../src/logging/event";
import type { AcquireLeaseResult, ReportOutcomeInput, SlotId } from "../../src/key-pool/types";
import {
  getKeyPoolConfiguration,
  getKeySlotDefinitions,
} from "../../src/key-pool/slots";

const NOW = 1_700_000_000_000;
const SECRET_01 = "unit-secret-one";
const SECRET_02 = "unit-secret-two";
const SECRET_03 = "unit-secret-three";
const SECRET_04 = "unit-secret-four";
const SECRET_05 = "unit-secret-five";
const REQUEST: InvocationRequest = {
  requestId: "request-01",
  toolName: "get_stock_quote",
  input: { windcode: "600519.SH", sentinel: "argument-must-not-be-logged" },
};
const SUCCESS: CallToolResult = {
  content: [{ type: "text", text: "fixture-result" }],
  structuredContent: { value: 42 },
  isError: false,
  _meta: { vendorMetadata: "preserved" },
};

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("Wind invocation state machine", () => {
  it("resolves every manifest slot through its declared Secret binding", () => {
    const invocationEnv = dependencies(scriptedPool([]), scriptedCaller([])).env;

    expect(
      getKeySlotDefinitions("ring-primary-v1").map((definition) => [
        definition.slotId,
        resolveWindSecret(invocationEnv, definition.slotId),
      ]),
    ).toEqual([
      ["key-03", SECRET_03],
      ["key-02", SECRET_02],
      ["key-01", SECRET_01],
    ]);
    expect(() =>
      Reflect.apply(resolveWindSecret, undefined, [invocationEnv, "future-slot"]),
    ).toThrow("UNKNOWN_SLOT");
  });

  it("preserves the successful CallToolResult by reference and keeps key-01 active", async () => {
    const pool = scriptedPool([lease("key-01", "lease-01")]);
    const caller = scriptedCaller([SUCCESS]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toBeNull();
    expect(caller.slots).toEqual([SECRET_01]);
    expect(pool.reports).toEqual([
      report("lease-01", "key-01", "success", null, NOW),
    ]);
  });

  it("routes business invocation through the active generation object", async () => {
    const objectNames: string[] = [];
    const caller = scriptedCaller([SUCCESS]);
    const invocationEnv = {
      KEY_POOL: {
        getByName(objectName: string) {
          objectNames.push(objectName);
          return env.KEY_POOL.getByName(objectName);
        },
      },
      WIND_API_KEY_01: SECRET_01,
      WIND_API_KEY_02: SECRET_02,
      WIND_API_KEY_03: SECRET_03,
      WIND_API_KEY_04: SECRET_04,
      WIND_API_KEY_05: SECRET_05,
      KEY_POOL_LAYOUT_ID: "ring-primary-v1",
    } as never;

    const result = await invokeWindTool(
      { ...REQUEST, requestId: "active-generation-route" },
      { env: invocationEnv, caller, waitUntil: consumeBackgroundPromise },
    );

    expect(result.toolResult).toBe(SUCCESS);
    expect(objectNames).toEqual(["private-key-pool-v2", "private-key-pool-v2"]);
  });

  it("marks a classified failover report as continuing and leaves the success report unmarked", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([classifiedBody("DAILY_LIMIT_ERROR"), SUCCESS]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toBe(SUCCESS);
    expect(pool.reports).toEqual([
      report("lease-01", "key-01", "daily_quota", null, NOW, true),
      report("lease-02", "key-02", "success", null, NOW),
    ]);
  });

  it("routes a 200 isError exact daily envelope to key-02 and reports a successful rotation", async () => {
    const daily: CallToolResult = {
      content: [{ type: "text", text: "vendor error text is not parsed" }],
      structuredContent: {
        error: { code: "DAILY_LIMIT_ERROR", reset_at: 1_700_003_600 },
      },
      isError: true,
    };
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([daily, SUCCESS]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "daily_quota",
      finalStatus: "succeeded",
    });
    expect(caller.slots).toEqual([SECRET_01, SECRET_02]);
    expect(pool.reports.map((entry) => [entry.slotId, entry.category])).toEqual([
      ["key-01", "daily_quota"],
      ["key-02", "success"],
    ]);
    expect(pool.acquisitions).toEqual([
      { requestId: REQUEST.requestId, attemptedSlotIds: [] },
      { requestId: REQUEST.requestId, attemptedSlotIds: ["key-01"] },
    ]);
  });

  it("routes an atomic one-shot daily control through failover without calling Wind for key-01", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    pool.testOutcomes.push("daily_quota", null);
    const caller = scriptedCaller([SUCCESS]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "daily_quota",
    });
    expect(pool.consumedSlots).toEqual(["key-01", "key-02"]);
    expect(caller.slots).toEqual([SECRET_02]);
    expect(pool.reports.map((entry) => [entry.slotId, entry.category])).toEqual([
      ["key-01", "daily_quota"],
      ["key-02", "success"],
    ]);
  });

  it("consumes a transient one-shot control once then retries the same slot against Wind", async () => {
    const pool = scriptedPool([lease("key-01", "lease-01")]);
    pool.testOutcomes.push("network", null);
    const caller = scriptedCaller([SUCCESS]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toBeNull();
    expect(pool.consumedSlots).toEqual(["key-01", "key-01"]);
    expect(caller.slots).toEqual([SECRET_01]);
    expect(pool.reports.map((entry) => entry.category)).toEqual(["success"]);
  });

  it("reports the initial balance category when rotation reaches key-02 and still fails", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([
      classifiedBody("BALANCE_ERROR"),
      new WindCallFailure({ body: "not-json" }),
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult.isError).toBe(true);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATION_FAILED",
      initialCategory: "balance",
      finalStatus: "failed",
    });
    expect(caller.slots).toEqual([SECRET_01, SECRET_02]);
    expect(pool.reports.map((entry) => [entry.slotId, entry.category])).toEqual([
      ["key-01", "balance"],
      ["key-02", "unknown"],
    ]);
  });

  it("reports auth then a rotation failure when the pool has no next slot", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      { ok: false, code: "KEY_POOL_EXHAUSTED", retryAfterMs: null, queueDepth: 0 },
    ]);
    const caller = scriptedCaller([classifiedBody("AUTH_ERROR")]);
    const lines: string[] = [];

    const result = await invokeWindTool(REQUEST, {
      ...dependencies(pool, caller),
      log: (event) => emitLogEvent(event, (line) => lines.push(line)),
    });

    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATION_FAILED",
      initialCategory: "auth",
    });
    expect(caller.slots).toEqual([SECRET_01]);
    expect(pool.reports).toEqual([report("lease-01", "key-01", "auth", null, NOW, true)]);
    const logged = lines.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
    expect(logged).toEqual([
      expect.objectContaining({
        status: "KEY_POOL_EXHAUSTED",
        upstreamStatus: null,
        upstreamErrorCode: "AUTH_ERROR",
      }),
    ]);
    expect(lines.join("\n")).not.toContain("600519.SH");
  });

  it("does not mark continuing for success, a same-slot retry, a final stop, or a gateway-local failure", async () => {
    const successPool = scriptedPool([lease("key-01", "lease-success")]);
    await invokeWindTool(
      { ...REQUEST, requestId: "plain-success" },
      dependencies(successPool, scriptedCaller([SUCCESS])),
    );
    expect(successPool.reports).toEqual([
      report("lease-success", "key-01", "success", null, NOW),
    ]);

    const retryPool = scriptedPool([
      lease("key-01", "lease-retry"),
      lease("key-02", "lease-retry-next"),
    ]);
    await invokeWindTool(
      { ...REQUEST, requestId: "same-slot-retry" },
      dependencies(
        retryPool,
        scriptedCaller([
          new WindCallFailure({ status: 429, headers: { "retry-after": "2" } }),
          new WindCallFailure({ status: 429, headers: { "retry-after": "2" } }),
        ]),
      ),
    );
    expect(retryPool.acquisitions).toHaveLength(1);
    expect(retryPool.reports).toEqual([
      report("lease-retry", "key-01", "qps", NOW + 2_000, NOW),
    ]);

    const stopPool = scriptedPool([
      lease("key-01", "lease-stop"),
      lease("key-02", "lease-stop-next"),
    ]);
    await invokeWindTool(
      { ...REQUEST, requestId: "final-stop" },
      dependencies(
        stopPool,
        scriptedCaller([new WindCallFailure({}, 8_388_609, "response_too_large")]),
      ),
    );
    expect(stopPool.acquisitions).toHaveLength(1);
    expect(stopPool.reports).toEqual([
      report("lease-stop", "key-01", "response_too_large", null, NOW),
    ]);

    const localPool = scriptedPool([
      lease("key-01", "lease-local"),
      lease("key-02", "lease-local-next"),
    ]);
    await invokeWindTool(
      { ...REQUEST, requestId: "gateway-local" },
      dependencies(localPool, scriptedCaller([new Error("local-bug"), SUCCESS])),
    );
    expect(localPool.acquisitions).toHaveLength(1);
    expect(localPool.reports).toEqual([
      report("lease-local", "key-01", "unknown", null, NOW),
    ]);
  });

  it.each([
    ["qps", new WindCallFailure({ status: 429, headers: { "Retry-After": "0" } })],
    ["concurrency", classifiedBody("CONCURRENCY_LIMIT_ERROR")],
    ["network", new WindCallFailure({ error: new TypeError("synthetic network") })],
    ["upstream_5xx", new WindCallFailure({ status: 503 })],
    ["timeout", timeoutFailure()],
  ] as const)(
    "retries %s once on the same lease and slot without reporting the transient failure",
    async (_category, firstFailure) => {
      const pool = scriptedPool([lease("key-01", "lease-01")]);
      const caller = scriptedCaller([firstFailure, SUCCESS]);
      const sleep = vi.fn(async () => undefined);

      const result = await invokeWindTool(REQUEST, {
        ...dependencies(pool, caller),
        sleep,
      });

      expect(result.toolResult).toBe(SUCCESS);
      expect(result.notice).toBeNull();
      expect(caller.slots).toEqual([SECRET_01, SECRET_01]);
      expect(pool.acquisitions).toHaveLength(1);
      expect(pool.reports.map((entry) => entry.category)).toEqual(["success"]);
      expect(sleep).toHaveBeenCalledOnce();
    },
  );

  it("cuts off a silent upstream at 25 seconds, retries once on the same slot, and does not rotate", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const calls: Array<{ readonly apiKey: string; readonly timeoutMs: number }> = [];
    const caller: WindToolCaller = {
      async call(input) {
        calls.push({ apiKey: input.apiKey, timeoutMs: input.timeoutMs });
        throw timeoutFailure();
      },
    };
    const sleep = vi.fn(async () => undefined);

    const result = await invokeWindTool(REQUEST, {
      ...dependencies(pool, caller),
      sleep,
    });

    expect(calls).toEqual([
      { apiKey: SECRET_01, timeoutMs: 25_000 },
      { apiKey: SECRET_01, timeoutMs: 25_000 },
    ]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(500);
    expect(pool.acquisitions).toHaveLength(1);
    expect(pool.reports).toEqual([report("lease-01", "key-01", "timeout", null, NOW)]);
    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "timeout",
    });
  });

  it("stops after exactly one same-slot retry and does not acquire key-02", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([
      new WindCallFailure({ status: 429, headers: { "retry-after": "2" } }),
      new WindCallFailure({ status: 429, headers: { "retry-after": "2" } }),
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "qps",
    });
    expect(caller.slots).toEqual([SECRET_01, SECRET_01]);
    expect(pool.acquisitions).toHaveLength(1);
    expect(pool.reports.map((entry) => entry.category)).toEqual(["qps"]);
    expect(pool.reports[0]?.resetAt).toBe(NOW + 2_000);
  });

  it("marks each Wind unknown walk report as continuing and leaves the finishing success unmarked", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
      lease("key-03", "lease-03"),
    ]);
    const caller = scriptedCaller([
      new WindCallFailure({ body: "not-json" }),
      new WindCallFailure({ body: "not-json" }),
      SUCCESS,
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toBe(SUCCESS);
    expect(pool.reports).toEqual([
      report("lease-01", "key-01", "unknown", null, NOW, true),
      report("lease-02", "key-02", "unknown", null, NOW, true),
      report("lease-03", "key-03", "success", null, NOW),
    ]);
  });

  it("tries the next active slot once after an unclassified Wind failure and returns that success", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([
      new WindCallFailure({ body: "not-json" }),
      SUCCESS,
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "unknown",
      finalStatus: "succeeded",
    });
    expect(caller.slots).toEqual([SECRET_01, SECRET_02]);
    expect(pool.acquisitions).toEqual([
      { requestId: REQUEST.requestId, attemptedSlotIds: [] },
      { requestId: REQUEST.requestId, attemptedSlotIds: ["key-01"] },
    ]);
    expect(pool.reports).toEqual([
      report("lease-01", "key-01", "unknown", null, NOW, true),
      report("lease-02", "key-02", "success", null, NOW),
    ]);
  });

  it("stops on response limit without consuming the next slot", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([
      new WindCallFailure({}, 8_388_609, "response_too_large"),
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "response_too_large",
    });
    expect(caller.slots).toEqual([SECRET_01]);
    expect(pool.acquisitions).toHaveLength(1);
    expect(pool.reports.map((entry) => entry.category)).toEqual(["response_too_large"]);
  });

  it("does not rotate when a structured envelope on a non-auth status exceeds 16 KiB by one byte", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const body = `${exactSizedAuthEnvelope()} `;
    const caller = createWindToolCaller({
      baseFetch: async () =>
        new Response(body, {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "response_too_large",
    });
    expect(pool.acquisitions).toHaveLength(1);
    expect(pool.reports.map((entry) => entry.category)).toEqual(["response_too_large"]);
  });

  it("rotates to key-02 when Wind rejects key-01 with an oversized HTML 401 page", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const page = `<!doctype html><html><head><title>403</title></head><body>${"x".repeat(24_000)}</body></html>`;
    const attemptedKeys: string[] = [];
    const caller = createWindToolCaller({
      createAttempt: (input) => ({
        async connect() {
          attemptedKeys.push(input.apiKey);
          if (input.apiKey !== SECRET_01) return;
          // Replay the edge response through the bounded stream so the recorder sees exactly what
          // the SDK transport would: status 401 plus an HTML body larger than the envelope cap.
          const limited = limitResponseBody(
            new Response(page, { status: 401, headers: { "content-type": "text/html" } }),
            8_388_608,
            input.recorder,
          );
          await limited.arrayBuffer();
          throw new Error("Error POSTing to endpoint (HTTP 401)");
        },
        async callTool() {
          return SUCCESS;
        },
        async close() {},
      }),
    });

    const lines: string[] = [];
    const result = await invokeWindTool(REQUEST, {
      ...dependencies(pool, caller),
      log: (event) => emitLogEvent(event, (line) => lines.push(line)),
    });

    expect(attemptedKeys).toEqual([SECRET_01, SECRET_02]);
    expect(result.toolResult).toBe(SUCCESS);
    expect(result.toolResult.isError).toBe(false);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "daily_quota",
      finalStatus: "succeeded",
    });
    expect(pool.reports).toEqual([
      report("lease-01", "key-01", "daily_quota", null, NOW, true),
      report("lease-02", "key-02", "success", null, NOW),
    ]);
    const logged = lines.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
    expect(logged).toEqual([
      expect.objectContaining({
        slotId: "key-02",
        status: "success",
        noticeCode: "WIND_KEY_ROTATED",
        upstreamStatus: 401,
        upstreamErrorCode: null,
      }),
    ]);
    const serialized = lines.join("\n");
    expect(serialized).not.toContain("<!doctype");
    expect(serialized).not.toContain(SECRET_01);
    expect(serialized).not.toContain("600519.SH");
  });

  it("rounds a known GATEWAY_BUSY retry up to whole seconds in the failure text", async () => {
    const pool = scriptedPool([{ ok: false, code: "GATEWAY_BUSY", retryAfterMs: 1_001, queueDepth: 0 }]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, scriptedCaller([])));

    expect(result.toolResult).toEqual({
      isError: true,
      content: [{ type: "text", text: "iWind request failed (GATEWAY_BUSY). Retry after 2s." }],
    });
    expect(result.notice).toEqual({
      schemaVersion: 1,
      code: "GATEWAY_BUSY",
      initialCategory: null,
      finalStatus: "failed",
      requestId: "request-01",
    });
    expect(JSON.stringify(result)).not.toContain("argument-must-not-be-logged");
    expect(JSON.stringify(result)).not.toContain("600519.SH");
  });

  it("keeps an exact second and leaves other failure text unchanged", async () => {
    const exact = await invokeWindTool(
      REQUEST,
      dependencies(
        scriptedPool([{ ok: false, code: "GATEWAY_BUSY", retryAfterMs: 1_000, queueDepth: 0 }]),
        scriptedCaller([]),
      ),
    );
    expect(exact.toolResult).toMatchObject({
      content: [{ type: "text", text: "iWind request failed (GATEWAY_BUSY). Retry after 1s." }],
    });

    const unknownRetry = await invokeWindTool(
      { ...REQUEST, requestId: "request-02" },
      dependencies(
        scriptedPool([{ ok: false, code: "GATEWAY_BUSY", retryAfterMs: null, queueDepth: 0 }]),
        scriptedCaller([]),
      ),
    );
    expect(unknownRetry.toolResult).toMatchObject({
      content: [{ type: "text", text: "iWind request failed (GATEWAY_BUSY)." }],
    });

    const exhausted = await invokeWindTool(
      { ...REQUEST, requestId: "request-03" },
      dependencies(
        scriptedPool([{ ok: false, code: "KEY_POOL_EXHAUSTED", retryAfterMs: 5_000, queueDepth: 0 }]),
        scriptedCaller([]),
      ),
    );
    expect(exhausted.toolResult).toMatchObject({
      content: [{ type: "text", text: "iWind request failed (KEY_POOL_EXHAUSTED)." }],
    });
  });

  it("logs integer queue wait and depth on busy and successful tool lines", async () => {
    const busyLines: string[] = [];
    const busy = await invokeWindTool(REQUEST, {
      ...dependencies(
        scriptedPool([{ ok: false, code: "GATEWAY_BUSY", retryAfterMs: 1_001, queueDepth: 4 }]),
        scriptedCaller([]),
      ),
      log: (event) => emitLogEvent(event, (line) => busyLines.push(line)),
    });

    expect(busy.toolResult).toMatchObject({
      content: [{ type: "text", text: "iWind request failed (GATEWAY_BUSY). Retry after 2s." }],
    });
    const busyLog = JSON.parse(busyLines[0] ?? "") as {
      queueWaitMs: unknown;
      queueDepth: unknown;
      slotId: unknown;
    };
    expect(busyLog).toMatchObject({
      slotId: null,
      status: "GATEWAY_BUSY",
      queueWaitMs: 0,
      queueDepth: 4,
      upstreamStatus: null,
      upstreamErrorCode: null,
      responseBytes: null,
    });
    expect(Number.isInteger(busyLog.queueWaitMs)).toBe(true);
    expect(Number.isInteger(busyLog.queueDepth)).toBe(true);
    expect(busyLines.join("\n")).not.toContain("argument-must-not-be-logged");
    expect(busyLines.join("\n")).not.toContain("600519.SH");

    const successLines: string[] = [];
    await invokeWindTool(
      { ...REQUEST, requestId: "request-02" },
      {
        ...dependencies(scriptedPool([lease("key-01", "lease-01")]), scriptedCaller([SUCCESS])),
        log: (event) => emitLogEvent(event, (line) => successLines.push(line)),
      },
    );
    const successLog = JSON.parse(successLines[0] ?? "") as {
      queueWaitMs: unknown;
      queueDepth: unknown;
    };
    expect(successLog).toMatchObject({
      slotId: "key-01",
      status: "success",
      queueWaitMs: 0,
      queueDepth: 0,
    });
    expect(Number.isInteger(successLog.queueWaitMs)).toBe(true);
    expect(Number.isInteger(successLog.queueDepth)).toBe(true);
  });

  it.each(["GATEWAY_BUSY", "KEY_POOL_EXHAUSTED"] as const)(
    "returns stable %s without calling Wind",
    async (code) => {
      const pool = scriptedPool([{ ok: false, code, retryAfterMs: null, queueDepth: 0 }]);
      const caller = scriptedCaller([]);

      const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

      expect(result.toolResult.isError).toBe(true);
      expect(result.notice).toMatchObject({ code, initialCategory: null });
      expect(caller.slots).toEqual([]);
      expect(pool.reports).toEqual([]);
    },
  );

  it("fails an unknown tool before lease acquisition", async () => {
    const pool = scriptedPool([lease("key-01", "lease-01")]);
    const caller = scriptedCaller([SUCCESS]);

    const result = await invokeWindTool(
      { ...REQUEST, toolName: "not-a-frozen-tool" },
      dependencies(pool, caller),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "unknown",
    });
    expect(pool.acquisitions).toEqual([]);
    expect(caller.slots).toEqual([]);
  });

  it.each([["   "], [undefined]] as const)(
    "treats a missing key-01 binding value %s as auth, reports it, and then uses key-02",
    async (missingValue) => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([SUCCESS]);
    const deps = dependencies(pool, caller);

    const lines: string[] = [];
    const result = await invokeWindTool(REQUEST, {
      ...deps,
      env: { ...deps.env, WIND_API_KEY_01: missingValue },
      log: (event) => emitLogEvent(event, (line) => lines.push(line)),
    });

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "auth",
    });
    expect(caller.slots).toEqual([SECRET_02]);
    expect(pool.reports.map((entry) => [entry.slotId, entry.category, entry.continuing ?? false])).toEqual([
      ["key-01", "auth", true],
      ["key-02", "success", false],
    ]);
    const logged = lines.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
    expect(logged).toEqual([
      expect.objectContaining({
        slotId: "key-02",
        status: "success",
        noticeCode: "WIND_KEY_ROTATED",
        upstreamStatus: null,
        upstreamErrorCode: null,
      }),
    ]);
    expect(lines.join("\n")).not.toContain("AUTH_ERROR");
    },
  );

  it("walks prose that merely mentions a quota code and does not report daily quota", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([
      {
        content: [{ type: "text", text: "DAILY_LIMIT_ERROR" }],
        isError: true,
      },
      SUCCESS,
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "unknown",
      finalStatus: "succeeded",
    });
    expect(pool.reports.map((entry) => [entry.slotId, entry.category, entry.resetAt])).toEqual([
      ["key-01", "unknown", null],
      ["key-02", "success", null],
    ]);
  });

  it("classifies a single bounded JSON text block by its error code", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: { code: "DAILY_LIMIT_ERROR", reset_at: 1_700_003_600 } }),
          },
        ],
        isError: true,
      },
      SUCCESS,
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "daily_quota",
    });
    expect(pool.reports).toEqual([
      report("lease-01", "key-01", "daily_quota", 1_700_003_600_000, NOW, true),
      report("lease-02", "key-02", "success", null, NOW),
    ]);
  });

  it("lets a string structured error code win over a text envelope", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([
      {
        content: [
          { type: "text", text: JSON.stringify({ error: { code: "DAILY_LIMIT_ERROR" } }) },
        ],
        structuredContent: { error: { code: "AUTH_ERROR" } },
        isError: true,
      },
      SUCCESS,
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "auth",
    });
    expect(pool.reports.map((entry) => entry.category)).toEqual(["auth", "success"]);
  });

  it("walks an unrecognized structured code instead of a daily-quota text envelope", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([
      {
        content: [
          { type: "text", text: JSON.stringify({ error: { code: "DAILY_LIMIT_ERROR" } }) },
        ],
        structuredContent: { error: { code: "NOT_ON_THE_LIST" } },
        isError: true,
      },
      SUCCESS,
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "unknown",
    });
    expect(pool.reports.map((entry) => [entry.slotId, entry.category])).toEqual([
      ["key-01", "unknown"],
      ["key-02", "success"],
    ]);
  });

  it("walks bare isError, invalid JSON, and an oversized text block without calling them daily quota", async () => {
    const oversized = `{"error":{"code":"DAILY_LIMIT_ERROR"},"padding":"${"x".repeat(MAX_ERROR_ENVELOPE_BYTES)}"}`;
    const cases = [
      { content: [], isError: true },
      { content: [{ type: "text" as const, text: "{not-json" }], isError: true },
      {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: { code: 12 } }) },
        ],
        isError: true,
      },
      { content: [{ type: "text" as const, text: oversized }], isError: true },
      {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: { code: "DAILY_LIMIT_ERROR" } }) },
          { type: "text" as const, text: "second block" },
        ],
        isError: true,
      },
    ];

    for (const [index, first] of cases.entries()) {
      const pool = scriptedPool([
        lease("key-01", "lease-01"),
        lease("key-02", "lease-02"),
      ]);
      const caller = scriptedCaller([first, SUCCESS]);
      const result = await invokeWindTool(
        { ...REQUEST, requestId: `bare-${index}` },
        dependencies(pool, caller),
      );

      expect(result.toolResult, `case ${index}`).toBe(SUCCESS);
      expect(result.notice, `case ${index}`).toMatchObject({
        code: "WIND_KEY_ROTATED",
        initialCategory: "unknown",
      });
      expect(pool.reports.map((entry) => entry.category), `case ${index}`).toEqual([
        "unknown",
        "success",
      ]);
      expect(pool.reports.some((entry) => entry.category === "daily_quota"), `case ${index}`).toBe(
        false,
      );
      expect(
        pool.reports.some((entry) => entry.category === "response_too_large"),
        `case ${index}`,
      ).toBe(false);
    }
  });

  it("stops after every scripted active slot returns unclassified", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
      lease("key-03", "lease-03"),
    ]);
    const caller = scriptedCaller([
      new WindCallFailure({ body: "not-json" }),
      new WindCallFailure({ body: "not-json" }),
      new WindCallFailure({ body: "not-json" }),
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "iWind request failed (KEY_POOL_EXHAUSTED)." }],
    });
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATION_FAILED",
      initialCategory: "unknown",
      finalStatus: "failed",
    });
    expect(caller.slots).toEqual([SECRET_01, SECRET_02, SECRET_03]);
    expect(pool.acquisitions.map((entry) => entry.attemptedSlotIds)).toEqual([
      [],
      ["key-01"],
      ["key-01", "key-02"],
      ["key-01", "key-02", "key-03"],
    ]);
    expect(pool.reports).toEqual([
      report("lease-01", "key-01", "unknown", null, NOW, true),
      report("lease-02", "key-02", "unknown", null, NOW, true),
      report("lease-03", "key-03", "unknown", null, NOW, true),
    ]);
  });

  it("does not retry or walk when the caller throws a generic Error", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([new Error("local-bug"), SUCCESS]);
    const sleep = vi.fn(async () => undefined);

    const result = await invokeWindTool(REQUEST, {
      ...dependencies(pool, caller),
      sleep,
    });

    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "unknown",
    });
    expect(caller.slots).toEqual([SECRET_01]);
    expect(pool.acquisitions).toHaveLength(1);
    expect(pool.reports.map((entry) => entry.category)).toEqual(["unknown"]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops an unknown walk when the lease report fails", async () => {
    const pool = scriptedPool(
      [lease("key-01", "lease-01"), lease("key-02", "lease-02")],
      1,
    );
    const caller = scriptedCaller([new WindCallFailure({ body: "not-json" }), SUCCESS]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toMatchObject({
      content: [{ type: "text", text: "iWind request failed (KEY_POOL_REPORT_FAILED)." }],
    });
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATION_FAILED",
      initialCategory: "unknown",
    });
    expect(caller.slots).toEqual([SECRET_01]);
    expect(pool.acquisitions).toHaveLength(1);
  });

  it("stops an unknown walk when the pool hands the same slot back", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-01", "lease-repeat"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([
      new WindCallFailure({ body: "not-json" }),
      SUCCESS,
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult).toMatchObject({
      content: [{ type: "text", text: "iWind request failed (WIND_REPEATED_SLOT)." }],
    });
    expect(caller.slots).toEqual([SECRET_01]);
    expect(pool.reports.map((entry) => [entry.leaseId, entry.category, entry.continuing ?? false])).toEqual([
      ["lease-01", "unknown", true],
      ["lease-repeat", "unknown", false],
    ]);
  });

  it("rejects a repeated failover slot and releases that lease as unknown", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-01", "lease-repeat"),
    ]);
    const caller = scriptedCaller([classifiedBody("DAILY_LIMIT_ERROR")]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.notice).toMatchObject({ code: "WIND_KEY_ROTATION_FAILED" });
    expect(caller.slots).toEqual([SECRET_01]);
    expect(pool.reports.map((entry) => [entry.leaseId, entry.category, entry.continuing ?? false])).toEqual([
      ["lease-01", "daily_quota", true],
      ["lease-repeat", "unknown", false],
    ]);
  });

  it("registers a real allowlisted repair-log promise when lease reporting fails", async () => {
    const pool = scriptedPool([lease("key-01", "lease-01")], 1);
    const caller = scriptedCaller([SUCCESS]);
    const lines: string[] = [];
    const registered: Promise<void>[] = [];

    const result = await invokeWindTool(REQUEST, {
      ...dependencies(pool, caller),
      log: (event) => emitLogEvent(event, (line) => lines.push(line)),
      waitUntil: (promise) => registered.push(promise),
    });

    expect(result.toolResult.isError).toBe(true);
    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "unknown",
    });
    expect(registered).toHaveLength(1);
    await Promise.all(registered);
    const repairEvent = lines
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>)
      .find((event) => event.status === "lease_repair_required");
    expect(repairEvent).toBeDefined();
    expect(Object.keys(repairEvent ?? {}).sort()).toEqual([
      "domain",
      "durationMs",
      "noticeCode",
      "queueDepth",
      "queueWaitMs",
      "requestId",
      "responseBytes",
      "slotId",
      "status",
      "toolName",
      "upstreamErrorCode",
      "upstreamStatus",
    ]);
    expect(lines.join("\n")).not.toContain(SECRET_01);
    expect(lines.join("\n")).not.toContain("argument-must-not-be-logged");
    expect(lines.join("\n")).not.toContain("fixture-result");
    expect(pool.reports).toHaveLength(1);
  });

  it("keeps lease and business semantics when repair waitUntil and logging throw", async () => {
    const pool = scriptedPool([lease("key-01", "lease-01")], 1);
    const waitUntil = vi.fn((promise: Promise<void>) => {
      void promise;
      throw new Error("synthetic waitUntil failure");
    });

    const result = await invokeWindTool(REQUEST, {
      ...dependencies(pool, scriptedCaller([SUCCESS])),
      waitUntil,
      log: () => {
        throw new Error("synthetic logger failure");
      },
    });

    expect(result.toolResult.isError).toBe(true);
    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "unknown",
    });
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(pool.reports).toHaveLength(1);
  });

  it("returns rotation failed when key-02 succeeds but its lease report fails", async () => {
    const pool = scriptedPool(
      [lease("key-01", "lease-01"), lease("key-02", "lease-02")],
      2,
    );
    const caller = scriptedCaller([classifiedBody("DAILY_LIMIT_ERROR"), SUCCESS]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.toolResult.isError).toBe(true);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATION_FAILED",
      initialCategory: "daily_quota",
    });
    expect(pool.reports).toHaveLength(2);
  });

  it("serializes two logical calls through the real KeyPool gate with max upstream in-flight one", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const caller: WindToolCaller = {
      async call() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 150));
        inFlight -= 1;
        return SUCCESS;
      },
    };
    const realEnv = {
      KEY_POOL: env.KEY_POOL,
      WIND_API_KEY_01: SECRET_01,
      WIND_API_KEY_02: SECRET_02,
      WIND_API_KEY_03: SECRET_03,
      KEY_POOL_LAYOUT_ID: "ring-primary-v1",
    };

    const results = await Promise.all([
      invokeWindTool(
        { ...REQUEST, requestId: "concurrent-01" },
        { env: realEnv, caller, waitUntil: consumeBackgroundPromise },
      ),
      invokeWindTool(
        { ...REQUEST, requestId: "concurrent-02" },
        { env: realEnv, caller, waitUntil: consumeBackgroundPromise },
      ),
    ]);

    const succeeded = results.filter((result) => result.toolResult === SUCCESS);
    const refused = results.filter((result) => result.toolResult !== SUCCESS);
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.toolResult.isError).toBe(true);
    const refusedText = refused[0]?.toolResult.content.find((block) => block.type === "text");
    expect(refusedText && "text" in refusedText ? refusedText.text : "").toMatch(
      /^iWind request failed \(GATEWAY_BUSY\)\. Retry after \d+s\.$/,
    );
    expect(maxInFlight).toBe(1);
  });

  it("names the leased slot on a hard stop and leaves the pool-exhausted line without a slot", async () => {
    const stopPool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const stopLines: string[] = [];
    const stopped = await invokeWindTool(REQUEST, {
      ...dependencies(
        stopPool,
        scriptedCaller([new WindCallFailure({}, 8_388_609, "response_too_large")]),
      ),
      log: (event) => emitLogEvent(event, (line) => stopLines.push(line)),
    });

    expect(stopped.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "response_too_large",
    });
    expect(stopLines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        slotId: "key-01",
        status: "WIND_RESPONSE_TOO_LARGE",
      }),
    ]);

    const exhaustedLines: string[] = [];
    const exhausted = await invokeWindTool(
      { ...REQUEST, requestId: "unknown-exhaust" },
      {
        ...dependencies(
          scriptedPool([lease("key-01", "lease-01")]),
          scriptedCaller([new WindCallFailure({ body: "not-json" })]),
        ),
        log: (event) => emitLogEvent(event, (line) => exhaustedLines.push(line)),
      },
    );

    expect(exhausted.notice).toMatchObject({
      code: "WIND_KEY_ROTATION_FAILED",
      initialCategory: "unknown",
    });
    expect(exhaustedLines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        slotId: null,
        status: "KEY_POOL_EXHAUSTED",
      }),
    ]);
  });

  it("logs status 200 from a thrown Wind failure without retaining an ordinary 2xx body", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const body = JSON.stringify({
      error: { code: "vendor.code-1" },
      detail: "body-must-not-be-logged",
    });
    const caller = createWindToolCaller({
      createAttempt: (input) => ({
        async connect() {
          if (input.apiKey !== SECRET_01) return;
          const limited = limitResponseBody(
            new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
            8_388_608,
            input.recorder,
          );
          await limited.arrayBuffer();
          throw new Error("protocol failure message-must-not-be-logged");
        },
        async callTool() {
          return SUCCESS;
        },
        async close() {},
      }),
    });
    const lines: string[] = [];

    const result = await invokeWindTool(REQUEST, {
      ...dependencies(pool, caller),
      log: (event) => emitLogEvent(event, (line) => lines.push(line)),
    });

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "unknown",
    });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        slotId: "key-02",
        status: "success",
        upstreamStatus: 200,
        upstreamErrorCode: null,
      }),
    ]);
    const serialized = lines.join("\n");
    expect(serialized).not.toContain("body-must-not-be-logged");
    expect(serialized).not.toContain("message-must-not-be-logged");
    expect(serialized).not.toContain("vendor.code-1");
  });

  it("does not walk or network-retry a generic Error that never got a Wind result", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const attempted: string[] = [];
    const caller = createWindToolCaller({
      createAttempt: (input) => ({
        async connect() {
          attempted.push(input.apiKey);
          throw new Error("local-bug");
        },
        async callTool() {
          return SUCCESS;
        },
        async close() {},
      }),
    });
    const sleep = vi.fn(async () => undefined);

    const result = await invokeWindTool(REQUEST, {
      ...dependencies(pool, caller),
      sleep,
    });

    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "unknown",
    });
    expect(attempted).toEqual([SECRET_01]);
    expect(pool.acquisitions).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a TypeError on HTTP 200 on the same slot instead of walking", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const attempted: string[] = [];
    const caller = createWindToolCaller({
      createAttempt: (input) => ({
        async connect() {
          attempted.push(input.apiKey);
          input.recorder.begin(new Response(null, { status: 200 }));
          if (attempted.length === 1) throw new TypeError("synthetic network");
        },
        async callTool() {
          return SUCCESS;
        },
        async close() {},
      }),
    });
    const sleep = vi.fn(async () => undefined);

    const result = await invokeWindTool(REQUEST, {
      ...dependencies(pool, caller),
      sleep,
    });

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toBeNull();
    expect(attempted).toEqual([SECRET_01, SECRET_01]);
    expect(pool.acquisitions).toHaveLength(1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("logs a retained vendor code on a 200 failure when that envelope is already in hand", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const envelope = JSON.stringify({ error: { code: "vendor.code-1" } });
    const caller = createWindToolCaller({
      createAttempt: (input) => ({
        async connect() {
          if (input.apiKey !== SECRET_01) return;
          input.recorder.begin(new Response(null, { status: 200 }));
          input.recorder.captureErrorChunk(new TextEncoder().encode(envelope));
          throw new Error("protocol failure message-must-not-be-logged");
        },
        async callTool() {
          return SUCCESS;
        },
        async close() {},
      }),
    });
    const lines: string[] = [];

    const result = await invokeWindTool(REQUEST, {
      ...dependencies(pool, caller),
      log: (event) => emitLogEvent(event, (line) => lines.push(line)),
    });

    expect(result.notice).toMatchObject({ initialCategory: "unknown" });
    expect(pool.reports.map((entry) => entry.category)).toEqual(["unknown", "success"]);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        upstreamStatus: 200,
        upstreamErrorCode: "vendor.code-1",
      }),
    ]);
    expect(lines.join("\n")).not.toContain("message-must-not-be-logged");
  });

  it("keeps a pending staging control dormant in production and consumes it once in staging", async () => {
    const stub = env.KEY_POOL.getByName(
      getKeyPoolConfiguration("ring-primary-v1").generation.objectName,
    );
    await stub.setNextTestOutcome({ slotId: "key-03", category: "network" });
    const productionCaller = scriptedCaller([SUCCESS]);
    const realEnv = {
      KEY_POOL: env.KEY_POOL,
      WIND_API_KEY_01: SECRET_01,
      WIND_API_KEY_02: SECRET_02,
      WIND_API_KEY_03: SECRET_03,
      KEY_POOL_LAYOUT_ID: "ring-primary-v1",
      DEPLOYMENT_STAGE: "production",
    };

    const production = await invokeWindTool(
      { ...REQUEST, requestId: "production-control" },
      { env: realEnv, caller: productionCaller, waitUntil: consumeBackgroundPromise },
    );
    expect(production.toolResult).toBe(SUCCESS);
    expect(productionCaller.slots).toEqual([SECRET_03]);

    const stagingCaller = scriptedCaller([SUCCESS]);
    const staging = await invokeWindTool(
      { ...REQUEST, requestId: "staging-control" },
      {
        env: { ...realEnv, DEPLOYMENT_STAGE: "staging" },
        caller: stagingCaller,
        waitUntil: consumeBackgroundPromise,
        sleep: async () => undefined,
      },
    );
    expect(staging.toolResult).toBe(SUCCESS);
    expect(stagingCaller.slots).toEqual([SECRET_03]);
    await expect(stub.consumeNextTestOutcome("key-03")).resolves.toBeNull();
  });
});

function dependencies(pool: ScriptedPool, caller: WindToolCaller) {
  return {
    env: {
      KEY_POOL: env.KEY_POOL,
      WIND_API_KEY_01: SECRET_01,
      WIND_API_KEY_02: SECRET_02,
      WIND_API_KEY_03: SECRET_03,
      KEY_POOL_LAYOUT_ID: "ring-primary-v1",
    },
    waitUntil: consumeBackgroundPromise,
    keyPool: pool satisfies InvocationKeyPool,
    caller: caller satisfies WindToolCaller,
    now: () => NOW,
    sleep: async () => undefined,
    log: () => undefined,
  };
}

function consumeBackgroundPromise(promise: Promise<void>): void {
  void promise.catch(() => undefined);
}

interface ScriptedPool extends InvocationKeyPool {
  readonly acquisitions: Array<{
    readonly requestId: string;
    readonly attemptedSlotIds: readonly SlotId[];
  }>;
  readonly reports: ReportOutcomeInput[];
  readonly consumedSlots: SlotId[];
  readonly testOutcomes: Array<ReportOutcomeInput["category"] | null>;
}

function scriptedPool(
  outcomes: readonly AcquireLeaseResult[],
  rejectReportAt: number | null = null,
): ScriptedPool {
  const remaining = [...outcomes];
  const acquisitions: Array<{
    readonly requestId: string;
    readonly attemptedSlotIds: readonly SlotId[];
  }> = [];
  const reports: ReportOutcomeInput[] = [];
  const consumedSlots: SlotId[] = [];
  const testOutcomes: Array<ReportOutcomeInput["category"] | null> = [];
  return {
    acquisitions,
    reports,
    consumedSlots,
    testOutcomes,
    async acquire(requestId, attemptedSlotIds: readonly SlotId[] = []) {
      acquisitions.push({ requestId, attemptedSlotIds: [...attemptedSlotIds] });
      const outcome = remaining.shift();
      return (
        outcome ?? { ok: false, code: "KEY_POOL_EXHAUSTED", retryAfterMs: null, queueDepth: 0 }
      );
    },
    async report(outcome) {
      reports.push(outcome);
      if (reports.length === rejectReportAt) throw new Error("synthetic report failure");
    },
    async consumeTestOutcome(slotId) {
      consumedSlots.push(slotId);
      return testOutcomes.shift() ?? null;
    },
  };
}

interface ScriptedCaller extends WindToolCaller {
  readonly slots: string[];
}

function scriptedCaller(outcomes: readonly (CallToolResult | Error)[]): ScriptedCaller {
  const remaining = [...outcomes];
  const slots: string[] = [];
  return {
    slots,
    async call(input) {
      slots.push(input.apiKey);
      const outcome = remaining.shift();
      if (outcome instanceof Error) throw outcome;
      if (outcome === undefined) throw new Error("missing scripted caller outcome");
      return outcome;
    },
  };
}

function lease(slotId: SlotId, leaseId: string): AcquireLeaseResult {
  return { ok: true, slotId, leaseId, expiresAt: NOW + 1_230_000, queueDepth: 0 };
}

function report(
  leaseId: string,
  slotId: SlotId,
  category: ReportOutcomeInput["category"],
  resetAt: number | null,
  occurredAt: number,
  continuing?: boolean,
): ReportOutcomeInput {
  return {
    leaseId,
    slotId,
    category,
    resetAt,
    occurredAt,
    ...(continuing === true ? { continuing: true } : {}),
  };
}

function classifiedBody(code: string): WindCallFailure {
  return new WindCallFailure({ body: JSON.stringify({ error: { code } }) });
}

function timeoutFailure(): WindCallFailure {
  const error = new Error("synthetic timeout");
  error.name = "AbortError";
  return new WindCallFailure({ error });
}

function exactSizedAuthEnvelope(): string {
  const prefix = '{"error":{"code":"AUTH_ERROR"},"padding":"';
  const suffix = '"}';
  return `${prefix}${"x".repeat(MAX_ERROR_ENVELOPE_BYTES - prefix.length - suffix.length)}${suffix}`;
}
