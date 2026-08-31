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
import { MAX_ERROR_ENVELOPE_BYTES } from "../../src/upstream/result-limit";
import { emitLogEvent } from "../../src/logging/event";
import type { AcquireLeaseResult, ReportOutcomeInput, SlotId } from "../../src/key-pool/types";
import { KEY_SLOT_DEFINITIONS } from "../../src/key-pool/slots";

const NOW = 1_700_000_000_000;
const SECRET_01 = "unit-secret-one";
const SECRET_02 = "unit-secret-two";
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
      KEY_SLOT_DEFINITIONS.map((definition) => [
        definition.slotId,
        resolveWindSecret(invocationEnv, definition.slotId),
      ]),
    ).toEqual([
      ["key-01", SECRET_01],
      ["key-02", SECRET_02],
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
      { ok: false, code: "KEY_POOL_EXHAUSTED", retryAfterMs: null },
    ]);
    const caller = scriptedCaller([classifiedBody("AUTH_ERROR")]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATION_FAILED",
      initialCategory: "auth",
    });
    expect(caller.slots).toEqual([SECRET_01]);
    expect(pool.reports).toHaveLength(1);
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

  it.each([
    ["unknown", new WindCallFailure({ body: "not-json" }), "unknown"],
    [
      "response limit",
      new WindCallFailure({}, 8_388_609, "response_too_large"),
      "response_too_large",
    ],
  ] as const)("stops on %s without consuming the next slot", async (_name, failure, category) => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([failure]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: category,
    });
    expect(caller.slots).toEqual([SECRET_01]);
    expect(pool.acquisitions).toHaveLength(1);
    expect(pool.reports.map((entry) => entry.category)).toEqual([category]);
  });

  it("does not rotate when a structured auth envelope exceeds 16 KiB by one byte", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const body = `${exactSizedAuthEnvelope()} `;
    const caller = createWindToolCaller({
      baseFetch: async () =>
        new Response(body, {
          status: 401,
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

  it.each(["GATEWAY_BUSY", "KEY_POOL_EXHAUSTED"] as const)(
    "returns stable %s without calling Wind",
    async (code) => {
      const pool = scriptedPool([{ ok: false, code, retryAfterMs: null }]);
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

    const result = await invokeWindTool(REQUEST, {
      ...deps,
      env: { ...deps.env, WIND_API_KEY_01: missingValue },
    });

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "auth",
    });
    expect(caller.slots).toEqual([SECRET_02]);
    expect(pool.reports.map((entry) => [entry.slotId, entry.category])).toEqual([
      ["key-01", "auth"],
      ["key-02", "success"],
    ]);
    },
  );

  it("fails closed when an isError result has only text that resembles a quota code", async () => {
    const pool = scriptedPool([
      lease("key-01", "lease-01"),
      lease("key-02", "lease-02"),
    ]);
    const caller = scriptedCaller([
      {
        content: [{ type: "text", text: "DAILY_LIMIT_ERROR" }],
        isError: true,
      },
    ]);

    const result = await invokeWindTool(REQUEST, dependencies(pool, caller));

    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "unknown",
    });
    expect(pool.acquisitions).toHaveLength(1);
    expect(caller.slots).toEqual([SECRET_01]);
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
    expect(pool.reports.map((entry) => [entry.leaseId, entry.category])).toEqual([
      ["lease-01", "daily_quota"],
      ["lease-repeat", "unknown"],
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
      "requestId",
      "responseBytes",
      "slotId",
      "status",
      "toolName",
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

    expect(results.every((result) => result.toolResult === SUCCESS)).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it("keeps a pending staging control dormant in production and consumes it once in staging", async () => {
    const stub = env.KEY_POOL.getByName("private-key-pool");
    await stub.setNextTestOutcome({ slotId: "key-01", category: "network" });
    const productionCaller = scriptedCaller([SUCCESS]);
    const realEnv = {
      KEY_POOL: env.KEY_POOL,
      WIND_API_KEY_01: SECRET_01,
      WIND_API_KEY_02: SECRET_02,
      DEPLOYMENT_STAGE: "production",
    };

    const production = await invokeWindTool(
      { ...REQUEST, requestId: "production-control" },
      { env: realEnv, caller: productionCaller, waitUntil: consumeBackgroundPromise },
    );
    expect(production.toolResult).toBe(SUCCESS);
    expect(productionCaller.slots).toEqual([SECRET_01]);

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
    expect(stagingCaller.slots).toEqual([SECRET_01]);
    await expect(stub.consumeNextTestOutcome("key-01")).resolves.toBeNull();
  });
});

function dependencies(pool: ScriptedPool, caller: WindToolCaller) {
  return {
    env: {
      KEY_POOL: env.KEY_POOL,
      WIND_API_KEY_01: SECRET_01,
      WIND_API_KEY_02: SECRET_02,
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
        outcome ?? { ok: false, code: "KEY_POOL_EXHAUSTED", retryAfterMs: null }
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
  return { ok: true, slotId, leaseId, expiresAt: NOW + 1_230_000 };
}

function report(
  leaseId: string,
  slotId: SlotId,
  category: ReportOutcomeInput["category"],
  resetAt: number | null,
  occurredAt: number,
): ReportOutcomeInput {
  return { leaseId, slotId, category, resetAt, occurredAt };
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
