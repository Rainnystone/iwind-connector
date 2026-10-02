import type { CallToolResult } from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { invokeWindTool } from "../../src/invocation/invoke";
import type { WindToolCaller } from "../../src/invocation/types";
import { getKeyPoolConfiguration, KEY_POOL_LAYOUT_ID } from "../../src/key-pool/slots";
import type { AcquireLeaseInput, AcquireLeaseResult, SlotId } from "../../src/key-pool/types";
import { WindCallFailure } from "../../src/upstream/call-tool";

const BASE_TIME = Date.UTC(2035, 7, 24, 0, 0, 0);
const RESERVATION_MS = 2_000;

function keyPool() {
  return env.KEY_POOL.getByName("private-key-pool");
}

function acquireLease(
  stub: { acquireLease(input: AcquireLeaseInput): Promise<AcquireLeaseResult> },
  requestId: string,
  now: number,
  attemptedSlotIds: readonly SlotId[] = [],
): Promise<AcquireLeaseResult> {
  return stub.acquireLease({ requestId, attemptedSlotIds, now });
}

afterEach(async () => {
  await reset();
});

describe("walk reservation", () => {
  it("keeps the next lease for a continuing request while waiters poll", async () => {
    const stub = keyPool();
    const first = await acquireLease(stub, "walker", BASE_TIME);
    expect(first).toMatchObject({ ok: true, slotId: "key-01" });
    if (!first.ok) throw new Error("fixture-lease-not-acquired");

    await acquireLease(stub, "waiter-a", BASE_TIME + 1);
    await acquireLease(stub, "waiter-b", BASE_TIME + 2);

    const reportedAt = BASE_TIME + 10;
    await stub.reportOutcome({
      leaseId: first.leaseId,
      slotId: first.slotId,
      category: "daily_quota",
      resetAt: reportedAt + 86_400_000,
      occurredAt: reportedAt,
      continuing: true,
    });

    await expect(acquireLease(stub, "waiter-a", reportedAt + 1)).resolves.toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: RESERVATION_MS - 1,
      queueDepth: 1,
    });
    await expect(acquireLease(stub, "waiter-b", reportedAt + 2)).resolves.toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: RESERVATION_MS - 2,
      queueDepth: 2,
    });

    const next = await acquireLease(stub, "walker", reportedAt + 3, ["key-01"]);
    expect(next).toMatchObject({ ok: true, slotId: "key-02" });
    expect((await stub.getStatus()).lease).toMatchObject({
      requestId: "walker",
      slotId: "key-02",
    });
    if (!next.ok) throw new Error("fixture-lease-not-acquired");
    expect(next.leaseId).not.toBe(first.leaseId);
  });

  it("grants the head of the waitlist once an unused reservation lapses", async () => {
    const stub = keyPool();
    const first = await acquireLease(stub, "walker", BASE_TIME);
    if (!first.ok) throw new Error("fixture-lease-not-acquired");
    await acquireLease(stub, "waiter-a", BASE_TIME + 1);
    await acquireLease(stub, "waiter-b", BASE_TIME + 2);

    const reportedAt = BASE_TIME + 10;
    await stub.reportOutcome({
      leaseId: first.leaseId,
      slotId: first.slotId,
      category: "unknown",
      resetAt: null,
      occurredAt: reportedAt,
      continuing: true,
    });

    await expect(acquireLease(stub, "waiter-a", reportedAt + RESERVATION_MS - 1)).resolves.toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: 1,
      queueDepth: 1,
    });
    await expect(acquireLease(stub, "waiter-b", reportedAt + RESERVATION_MS)).resolves.toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: null,
      queueDepth: 2,
    });
    await expect(acquireLease(stub, "waiter-a", reportedAt + RESERVATION_MS)).resolves.toMatchObject({
      ok: true,
      slotId: "key-01",
    });
    expect((await stub.getStatus()).lease).toMatchObject({ requestId: "waiter-a" });
  });

  it("lets only the reserving request consume its reservation", async () => {
    const stub = keyPool();
    const first = await acquireLease(stub, "walker", BASE_TIME);
    if (!first.ok) throw new Error("fixture-lease-not-acquired");
    await acquireLease(stub, "waiter-head", BASE_TIME + 1);

    const reportedAt = BASE_TIME + 10;
    await stub.reportOutcome({
      leaseId: first.leaseId,
      slotId: first.slotId,
      category: "balance",
      resetAt: null,
      occurredAt: reportedAt,
      continuing: true,
    });

    await expect(acquireLease(stub, "waiter-head", reportedAt + 50)).resolves.toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: RESERVATION_MS - 50,
      queueDepth: 1,
    });
    await expect(acquireLease(stub, "stranger", reportedAt + 60)).resolves.toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: RESERVATION_MS - 60,
      queueDepth: 2,
    });

    const next = await acquireLease(stub, "walker", reportedAt + 70, ["key-01"]);
    expect(next).toMatchObject({ ok: true, slotId: "key-02" });
    expect((await stub.getStatus()).lease).toMatchObject({ requestId: "walker", slotId: "key-02" });
  });

  it("acquires the next slot during a classified failover while waiters poll", async () => {
    const stub = primaryPool();
    const requestId = "failover-walker";
    const seen: string[] = [];
    let contention: ReturnType<typeof contendingWaiters> | undefined;
    const caller = pacedCaller([dailyQuotaFailure(), SUCCESS], async () => {
      contention ??= contendingWaiters(stub);
      const lease = (await stub.getStatus()).lease;
      if (lease?.requestId === requestId) seen.push(lease.leaseId);
    });

    const result = await invokeWindTool(walkRequest(requestId), walkDependencies(caller));
    const busyPolls = contention === undefined ? 0 : await contention.stop();

    expect(result.toolResult).toBe(SUCCESS);
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "daily_quota",
    });
    expect(caller.slots).toEqual(["key-05", "key-04"]);
    expect(new Set(seen).size).toBe(2);
    expect(busyPolls).toBeGreaterThan(0);
    expect((await stub.getStatus()).currentSlotId).toBe("key-04");
  });

  it("walks each unclassified slot once while waiters poll, then grants the head waiter", async () => {
    const stub = primaryPool();
    const requestId = "unknown-walker";
    const seen: Array<{ leaseId: string; slotId: string }> = [];
    let contention: ReturnType<typeof contendingWaiters> | undefined;
    const caller = pacedCaller(
      [
        new WindCallFailure({ body: "not-json" }),
        new WindCallFailure({ body: "not-json" }),
        new WindCallFailure({ body: "not-json" }),
        new WindCallFailure({ body: "not-json" }),
        new WindCallFailure({ body: "not-json" }),
      ],
      async () => {
        contention ??= contendingWaiters(stub);
        const lease = (await stub.getStatus()).lease;
        if (lease?.requestId === requestId) {
          seen.push({ leaseId: lease.leaseId, slotId: lease.slotId });
        }
      },
    );

    const result = await invokeWindTool(walkRequest(requestId), walkDependencies(caller));
    const busyPolls = contention === undefined ? 0 : await contention.stop();

    expect(result.toolResult).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "iWind request failed (KEY_POOL_EXHAUSTED)." }],
    });
    expect(result.notice).toMatchObject({
      code: "WIND_KEY_ROTATION_FAILED",
      initialCategory: "unknown",
    });
    expect(caller.slots).toEqual(["key-05", "key-04", "key-03", "key-02", "key-01"]);
    expect(busyPolls).toBeGreaterThan(0);
    expect(seen.map((lease) => lease.slotId)).toEqual([
      "key-05",
      "key-04",
      "key-03",
      "key-02",
      "key-01",
    ]);
    expect(new Set(seen.map((lease) => lease.leaseId)).size).toBe(5);

    const status = await stub.getStatus();
    expect(status.currentSlotId).toBe("key-01");
    expect(status.lease).toBeNull();
    expect(status.slots.map((slot) => [slot.slotId, slot.state, slot.resetAt])).toEqual([
      ["key-05", "active", null],
      ["key-04", "active", null],
      ["key-03", "active", null],
      ["key-02", "active", null],
      ["key-01", "active", null],
    ]);
    expect(status.slots.some((slot) => slot.lastErrorCode === "daily_quota")).toBe(false);
    expect(
      status.slots.some(
        (slot) => slot.state === "disabled_auth" || slot.state === "exhausted_until_reset",
      ),
    ).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(
      stub.acquireLease({
        requestId: "following-request",
        attemptedSlotIds: [],
        now: Date.now(),
      }),
    ).resolves.toMatchObject({ ok: true, slotId: "key-01" });
  });
});

const SUCCESS: CallToolResult = {
  content: [{ type: "text", text: "synthetic-success" }],
  isError: false,
};

const WALK_SECRETS = {
  WIND_API_KEY_01: "walk-secret-01",
  WIND_API_KEY_02: "walk-secret-02",
  WIND_API_KEY_03: "walk-secret-03",
  WIND_API_KEY_04: "walk-secret-04",
  WIND_API_KEY_05: "walk-secret-05",
} as const;

function primaryPool() {
  return env.KEY_POOL.getByName(
    getKeyPoolConfiguration(KEY_POOL_LAYOUT_ID).generation.objectName,
  );
}

function walkRequest(requestId: string) {
  return {
    requestId,
    toolName: "get_stock_quote",
    input: { windcode: "600519.SH" },
  };
}

function walkDependencies(caller: WindToolCaller) {
  return {
    env: {
      KEY_POOL: env.KEY_POOL,
      ...WALK_SECRETS,
      KEY_POOL_LAYOUT_ID,
      DEPLOYMENT_STAGE: "production",
    },
    caller,
    waitUntil: (promise: Promise<void>) => {
      void promise.catch(() => undefined);
    },
    sleep: async () => undefined,
    log: () => undefined,
  };
}

function dailyQuotaFailure(): WindCallFailure {
  return new WindCallFailure({
    body: JSON.stringify({ error: { code: "DAILY_LIMIT_ERROR" } }),
  });
}

interface PacedCaller extends WindToolCaller {
  readonly slots: string[];
}

function pacedCaller(
  outcomes: readonly (CallToolResult | Error)[],
  whileHeld: () => Promise<void>,
): PacedCaller {
  const remaining = [...outcomes];
  const slots: string[] = [];
  return {
    slots,
    async call({ apiKey }) {
      slots.push(slotLabel(apiKey));
      await whileHeld();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const outcome = remaining.shift();
      if (outcome instanceof Error) throw outcome;
      if (outcome === undefined) throw new Error("missing synthetic outcome");
      return outcome;
    },
  };
}

function slotLabel(apiKey: string): string {
  switch (apiKey) {
    case WALK_SECRETS.WIND_API_KEY_01:
      return "key-01";
    case WALK_SECRETS.WIND_API_KEY_02:
      return "key-02";
    case WALK_SECRETS.WIND_API_KEY_03:
      return "key-03";
    case WALK_SECRETS.WIND_API_KEY_04:
      return "key-04";
    case WALK_SECRETS.WIND_API_KEY_05:
      return "key-05";
    default:
      return "unknown";
  }
}

function contendingWaiters(stub: ReturnType<typeof primaryPool>): { stop: () => Promise<number> } {
  let stopped = false;
  let busyPolls = 0;
  const loop = (async () => {
    while (!stopped) {
      for (const requestId of ["burst-a", "burst-b", "burst-c"]) {
        const outcome = await stub.acquireLease({
          requestId,
          attemptedSlotIds: [],
          now: Date.now(),
        });
        if (!outcome.ok && outcome.code === "GATEWAY_BUSY") busyPolls += 1;
        if (outcome.ok) {
          await stub.reportOutcome({
            leaseId: outcome.leaseId,
            slotId: outcome.slotId,
            category: "success",
            resetAt: null,
            occurredAt: Date.now(),
          });
        }
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return busyPolls;
    },
  };
}
