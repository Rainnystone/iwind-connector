import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
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
