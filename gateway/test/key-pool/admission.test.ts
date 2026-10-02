import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AcquireLeaseInput,
  AcquireLeaseResult,
  ReportOutcomeInput,
  SlotId,
} from "../../src/key-pool/types";

const BASE_TIME = Date.UTC(2035, 7, 24, 0, 0, 0);
const BUDGET_MS = 30_000;

afterEach(async () => {
  await reset();
});

type KeyPoolStub = {
  acquireLease(input: AcquireLeaseInput): Promise<AcquireLeaseResult>;
  reportOutcome(input: ReportOutcomeInput): Promise<void>;
};

function keyPool() {
  return env.KEY_POOL.getByName("private-key-pool");
}

function acquire(
  stub: KeyPoolStub,
  requestId: string,
  now: number,
  deadlineAt = now + BUDGET_MS,
  attemptedSlotIds: readonly SlotId[] = [],
): Promise<AcquireLeaseResult> {
  return stub.acquireLease({ requestId, attemptedSlotIds, now, deadlineAt });
}

async function grantedLease(
  stub: KeyPoolStub,
  requestId: string,
  now: number,
  deadlineAt?: number,
): Promise<Extract<AcquireLeaseResult, { ok: true }>> {
  const result = await acquire(stub, requestId, now, deadlineAt);
  if (!result.ok) throw new Error(`expected ${requestId} to be granted: ${JSON.stringify(result)}`);
  return result;
}

function succeed(
  stub: KeyPoolStub,
  lease: Extract<AcquireLeaseResult, { ok: true }>,
  occurredAt: number,
): Promise<void> {
  return stub.reportOutcome({
    leaseId: lease.leaseId,
    slotId: lease.slotId,
    category: "success",
    resetAt: null,
    occurredAt,
  });
}

describe("KeyPool admission against the caller's deadline", () => {
  it("keeps admitted callers in line while the holder runs past the typical hold", async () => {
    const stub = keyPool();
    const holder = await grantedLease(stub, "holder", BASE_TIME);
    for (const requestId of ["a", "b", "c"]) {
      await expect(acquire(stub, requestId, BASE_TIME + 100)).resolves.toMatchObject({
        ok: false,
        code: "GATEWAY_BUSY",
      });
    }

    for (const now of [BASE_TIME + 4_000, BASE_TIME + 8_000, BASE_TIME + 8_500, BASE_TIME + 9_000]) {
      for (const requestId of ["a", "b", "c"]) {
        await expect(acquire(stub, requestId, now, BASE_TIME + 100 + BUDGET_MS)).resolves.toMatchObject({
          ok: false,
          code: "GATEWAY_BUSY",
          queueDepth: 3,
        });
      }
    }

    await succeed(stub, holder, BASE_TIME + 9_000);
    const a = await grantedLease(stub, "a", BASE_TIME + 9_100, BASE_TIME + 100 + BUDGET_MS);
    await succeed(stub, a, BASE_TIME + 12_000);
    const b = await grantedLease(stub, "b", BASE_TIME + 12_100, BASE_TIME + 100 + BUDGET_MS);
    await succeed(stub, b, BASE_TIME + 15_000);
    await grantedLease(stub, "c", BASE_TIME + 15_100, BASE_TIME + 100 + BUDGET_MS);
  });

  it("drops a head waiter at its deadline so the next waiter is granted without a staleness gap", async () => {
    const stub = keyPool();
    const holder = await grantedLease(stub, "holder", BASE_TIME);
    const shortDeadline = BASE_TIME + 3_000;
    await acquire(stub, "gives-up", BASE_TIME + 100, shortDeadline);
    await acquire(stub, "next", BASE_TIME + 200, BASE_TIME + 200 + BUDGET_MS);
    await acquire(stub, "gives-up", BASE_TIME + 2_900, shortDeadline);
    await succeed(stub, holder, BASE_TIME + 3_100);

    await expect(
      acquire(stub, "next", BASE_TIME + 3_200, BASE_TIME + 200 + BUDGET_MS),
    ).resolves.toMatchObject({ ok: true, slotId: "key-01" });
  });

  it("tells a caller explicitly whether it is in line or refused", async () => {
    const stub = keyPool();
    await grantedLease(stub, "holder", BASE_TIME);

    await expect(acquire(stub, "waiter", BASE_TIME + 100)).resolves.toMatchObject({
      ok: false,
      code: "GATEWAY_BUSY",
      inLine: true,
    });
    await expect(
      acquire(stub, "too-late", BASE_TIME + 100, BASE_TIME + 1_000),
    ).resolves.toMatchObject({ ok: false, code: "GATEWAY_BUSY", inLine: false });
  });

  it("reports KEY_POOL_EXHAUSTED as not in line", async () => {
    const stub = keyPool();
    await expect(
      acquire(stub, "walker", BASE_TIME, BASE_TIME + BUDGET_MS, ["key-01", "key-02"]),
    ).resolves.toMatchObject({ ok: false, code: "KEY_POOL_EXHAUSTED", inLine: false });
  });

  describe("estimating the current holder from recorded holds", () => {
    async function recordHolds(stub: KeyPoolStub, holdsMs: readonly number[]): Promise<number> {
      let now = BASE_TIME;
      for (const [index, holdMs] of holdsMs.entries()) {
        const lease = await grantedLease(stub, `sample-${String(index)}`, now);
        await succeed(stub, lease, now + holdMs);
        now += holdMs + 1;
      }
      return now;
    }

    it("counts a holder down from the median hold", async () => {
      const stub = keyPool();
      const start = await recordHolds(stub, [4_000, 6_000, 10_000, 12_000, 14_000]);
      await grantedLease(stub, "holder", start);

      await expect(acquire(stub, "a", start + 3_000)).resolves.toEqual({
        ok: false,
        code: "GATEWAY_BUSY",
        retryAfterMs: 7_000,
        queueDepth: 1,
        inLine: true,
      });
    });

    it("treats a holder past the median as about to finish", async () => {
      const stub = keyPool();
      const start = await recordHolds(stub, [4_000, 6_000, 10_000, 12_000, 14_000]);
      await grantedLease(stub, "holder", start);
      const now = start + 11_000;

      const joined = [];
      for (const requestId of ["a", "b", "c", "d", "e"]) {
        joined.push(await acquire(stub, requestId, now));
      }

      expect(joined).toEqual([
        { ok: false, code: "GATEWAY_BUSY", retryAfterMs: 0, queueDepth: 1, inLine: true },
        { ok: false, code: "GATEWAY_BUSY", retryAfterMs: 10_000, queueDepth: 2, inLine: true },
        { ok: false, code: "GATEWAY_BUSY", retryAfterMs: 20_000, queueDepth: 3, inLine: true },
        { ok: false, code: "GATEWAY_BUSY", retryAfterMs: 30_000, queueDepth: 4, inLine: true },
        { ok: false, code: "GATEWAY_BUSY", retryAfterMs: 10_000, queueDepth: 4, inLine: false },
      ]);
    });

    it("treats a lease from before grant times were recorded as about to finish", async () => {
      const stub = keyPool();
      await stub.getStatus();
      const oldExpiry = BASE_TIME + 1_230_000;
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO lease (singleton, lease_id, request_id, slot_id, expires_at)
           VALUES (1, 'pre-change-lease', 'pre-change-request', 'key-01', ?)`,
          oldExpiry,
        );
      });

      await expect(acquire(stub, "a", BASE_TIME + 1_000)).resolves.toEqual({
        ok: false,
        code: "GATEWAY_BUSY",
        retryAfterMs: 0,
        queueDepth: 1,
        inLine: true,
      });
      await stub.reportOutcome({
        leaseId: "pre-change-lease",
        slotId: "key-01",
        category: "success",
        resetAt: null,
        occurredAt: BASE_TIME + 2_000,
      });

      await grantedLease(stub, "a", BASE_TIME + 3_000, BASE_TIME + 1_000 + BUDGET_MS);
      await expect(acquire(stub, "b", BASE_TIME + 3_000)).resolves.toMatchObject({
        retryAfterMs: 8_000,
        inLine: true,
      });
    });

    it("still replaces a pre-change lease at its stored expiry", async () => {
      const stub = keyPool();
      await stub.getStatus();
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO lease (singleton, lease_id, request_id, slot_id, expires_at)
           VALUES (1, 'pre-change-lease', 'pre-change-request', 'key-01', ?)`,
          BASE_TIME + 90_000,
        );
      });

      await expect(acquire(stub, "after-expiry", BASE_TIME + 90_000)).resolves.toMatchObject({
        ok: true,
        slotId: "key-01",
      });
    });
  });

  describe("refusal retry times", () => {
    it("tells refused callers when they could rejoin, one median hold apart", async () => {
      const stub = keyPool();
      await grantedLease(stub, "holder", BASE_TIME);
      const now = BASE_TIME + 50;

      const results = [];
      for (let index = 0; index < 7; index += 1) {
        results.push(await acquire(stub, `burst-${String(index)}`, now));
      }

      expect(results.map((result) => (result.ok ? "ok" : [result.inLine, result.retryAfterMs]))).toEqual([
        [true, 7_950],
        [true, 15_950],
        [true, 23_950],
        [false, 1_950],
        [false, 9_950],
        [false, 17_950],
        [false, 25_950],
      ]);
    });

    it("admits a refused caller that comes back at its retry time with no newcomers in between", async () => {
      const stub = keyPool();
      await grantedLease(stub, "holder", BASE_TIME);
      const joinedAt = BASE_TIME + 50;
      for (const requestId of ["a", "b", "c"]) await acquire(stub, requestId, joinedAt);
      const refused = await acquire(stub, "refused", joinedAt);
      if (refused.ok || refused.retryAfterMs === null) throw new Error("expected a refusal with a retry time");
      expect(refused.inLine).toBe(false);

      const returnsAt = joinedAt + refused.retryAfterMs;
      for (const requestId of ["a", "b", "c"]) {
        await expect(
          acquire(stub, requestId, returnsAt, joinedAt + BUDGET_MS),
        ).resolves.toMatchObject({ inLine: true });
      }
      await expect(acquire(stub, "refused", returnsAt)).resolves.toMatchObject({
        ok: false,
        inLine: true,
        queueDepth: 4,
      });
    });

    it("admits a returning refused caller once the holder has outrun every recorded hold", async () => {
      const stub = keyPool();
      let now = BASE_TIME;
      for (let index = 0; index < 3; index += 1) {
        const sample = await grantedLease(stub, `sample-${String(index)}`, now);
        await succeed(stub, sample, now + 4_000);
        now += 4_001;
      }
      const heldAt = now;
      await grantedLease(stub, "holder", heldAt);
      const waiters = ["w0", "w1", "w2", "w3", "w4", "w5", "w6"];
      const waiterDeadline = heldAt + 100 + BUDGET_MS;
      for (const pollAt of [heldAt + 100, heldAt + 3_000, heldAt + 6_000]) {
        for (const requestId of waiters) {
          await expect(acquire(stub, requestId, pollAt, waiterDeadline)).resolves.toMatchObject({
            inLine: true,
          });
        }
      }

      const first = await acquire(stub, "newcomer", heldAt + 6_000);
      if (first.ok) throw new Error("the holder is still running");
      if (first.inLine) return;
      if (first.retryAfterMs === null) throw new Error("expected a retry time");
      const returnsAt = heldAt + 6_000 + first.retryAfterMs;
      for (const requestId of waiters) await acquire(stub, requestId, returnsAt, waiterDeadline);
      await expect(acquire(stub, "newcomer", returnsAt)).resolves.toMatchObject({ inLine: true });
    });

    it("counts a holder's estimate down at least as fast as the clock", async () => {
      const stub = keyPool();
      let now = BASE_TIME;
      for (const [index, holdMs] of [4_000, 6_000, 10_000, 12_000, 14_000].entries()) {
        const sample = await grantedLease(stub, `sample-${String(index)}`, now);
        await succeed(stub, sample, now + holdMs);
        now += holdMs + 1;
      }
      const heldAt = now;
      await grantedLease(stub, "holder", heldAt);
      const deadlineAt = heldAt + 100 + BUDGET_MS;

      const quoted: { readonly at: number; readonly retryAfterMs: number }[] = [];
      for (const elapsed of [100, 3_000, 6_000, 9_000, 11_900, 12_100, 14_500, 17_000]) {
        const result = await acquire(stub, "head", heldAt + elapsed, deadlineAt);
        if (result.ok || !result.inLine || result.retryAfterMs === null) {
          throw new Error(`expected the head to stay in line: ${JSON.stringify(result)}`);
        }
        quoted.push({ at: elapsed, retryAfterMs: result.retryAfterMs });
      }

      for (const [index, later] of quoted.entries()) {
        const earlier = quoted[index - 1];
        if (earlier === undefined) continue;
        expect(later.retryAfterMs).toBeLessThanOrEqual(
          Math.max(0, earlier.retryAfterMs - (later.at - earlier.at)),
        );
      }
    });

    it("never tells a refused caller to come back in less than one second", async () => {
      const stub = keyPool();
      await grantedLease(stub, "holder", BASE_TIME);
      await expect(
        acquire(stub, "tight", BASE_TIME + 100, BASE_TIME + 100 + 7_850),
      ).resolves.toMatchObject({ inLine: false, retryAfterMs: 1_000 });
    });

    it("refuses a newcomer that cannot fit a cursor cooldown with a rejoin time", async () => {
      const stub = keyPool();
      const lease = await grantedLease(stub, "rate-limited", BASE_TIME);
      await stub.reportOutcome({
        leaseId: lease.leaseId,
        slotId: lease.slotId,
        category: "qps",
        resetAt: BASE_TIME + 45_000,
        occurredAt: BASE_TIME + 5_000,
      });

      await expect(acquire(stub, "newcomer", BASE_TIME + 5_000)).resolves.toEqual({
        ok: false,
        code: "GATEWAY_BUSY",
        retryAfterMs: 10_000,
        queueDepth: 0,
        inLine: false,
      });
    });

    it("keeps a caller already in line when a cooldown starts", async () => {
      const stub = keyPool();
      const lease = await grantedLease(stub, "rate-limited", BASE_TIME);
      await acquire(stub, "waiter", BASE_TIME + 100);
      await stub.reportOutcome({
        leaseId: lease.leaseId,
        slotId: lease.slotId,
        category: "qps",
        resetAt: BASE_TIME + 45_000,
        occurredAt: BASE_TIME + 1_000,
      });

      await expect(acquire(stub, "waiter", BASE_TIME + 1_100, BASE_TIME + 100 + BUDGET_MS)).resolves.toEqual({
        ok: false,
        code: "GATEWAY_BUSY",
        retryAfterMs: 43_900,
        queueDepth: 1,
        inLine: true,
      });
    });
  });

  it("grants a walk step its reserved lease even when a newcomer would be refused", async () => {
    const stub = keyPool();
    const sample = await grantedLease(stub, "sample", BASE_TIME);
    await succeed(stub, sample, BASE_TIME + 10_000);
    const walker = await grantedLease(stub, "walker", BASE_TIME + 10_001);
    for (const now of [BASE_TIME + 10_002, BASE_TIME + 14_000, BASE_TIME + 18_000]) {
      for (const requestId of ["a", "b", "c"]) {
        await expect(acquire(stub, requestId, now, BASE_TIME + 10_002 + BUDGET_MS)).resolves.toMatchObject({
          inLine: true,
        });
      }
    }
    await stub.reportOutcome({
      leaseId: walker.leaseId,
      slotId: walker.slotId,
      category: "unknown",
      resetAt: null,
      occurredAt: BASE_TIME + 20_001,
      continuing: true,
    });

    await expect(acquire(stub, "newcomer", BASE_TIME + 20_002)).resolves.toMatchObject({
      inLine: false,
    });
    await expect(
      acquire(stub, "walker", BASE_TIME + 20_003, BASE_TIME + 20_003 + BUDGET_MS, [walker.slotId]),
    ).resolves.toMatchObject({ ok: true, slotId: "key-02" });
  });

  it("adds the grant-time and deadline columns to tables created before them", async () => {
    const stub = keyPool();
    await stub.getStatus();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DROP TABLE lease");
        state.storage.sql.exec(
          `CREATE TABLE lease (
             singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
             lease_id TEXT NOT NULL,
             request_id TEXT NOT NULL,
             slot_id TEXT NOT NULL,
             expires_at INTEGER NOT NULL
           )`,
        );
        state.storage.sql.exec("DROP TABLE waitlist");
        state.storage.sql.exec(
          `CREATE TABLE waitlist (
             request_id TEXT PRIMARY KEY,
             ticket INTEGER NOT NULL,
             last_seen_at INTEGER NOT NULL
           )`,
        );
      });
    });

    await evictDurableObject(stub);
    const holder = await grantedLease(stub, "holder", BASE_TIME);
    await expect(acquire(stub, "waiter", BASE_TIME + 100)).resolves.toMatchObject({
      inLine: true,
    });
    await succeed(stub, holder, BASE_TIME + 5_000);
    await expect(acquire(stub, "waiter", BASE_TIME + 5_100)).resolves.toMatchObject({ ok: true });
    const versions = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { version: number }>(
          "SELECT version FROM _key_pool_schema_migrations ORDER BY version",
        )
        .toArray()
        .map(({ version }) => version),
    );
    expect(versions).toEqual([1, 2]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-finite deadline (%s)",
    async (deadlineAt) => {
      const stub = keyPool();
      await expect(
        runInDurableObject(stub, (instance) =>
          Reflect.apply(instance.acquireLease, instance, [
            { requestId: "caller", attemptedSlotIds: [], now: BASE_TIME, deadlineAt },
          ]),
        ),
      ).rejects.toThrow("INVALID_ACQUIRE_INPUT");
    },
  );
});
