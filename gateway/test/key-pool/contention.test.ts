import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireKeyPoolLease } from "../../src/key-pool/client";
import type { AcquireLeaseInput, AcquireLeaseResult } from "../../src/key-pool/types";

const BASE_TIME = Date.UTC(2035, 7, 24, 0, 0, 0);

function acquireLease(
  stub: { acquireLease(input: AcquireLeaseInput): Promise<AcquireLeaseResult> },
  requestId: string,
  now: number,
): Promise<AcquireLeaseResult> {
  return stub.acquireLease({ requestId, attemptedSlotIds: [], now });
}

afterEach(async () => {
  vi.useRealTimers();
  await reset();
});

describe("KeyPool contention", () => {
  it("catches non-atomic acquisition by admitting exactly one real lease under concurrent RPCs", async () => {
    const stub = env.KEY_POOL.getByName("private-key-pool");

    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        acquireLease(stub, `concurrent-${String(index).padStart(2, "0")}`, BASE_TIME),
      ),
    );

    const admitted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ slotId: "key-01" });
    expect(rejected).toHaveLength(23);
    expect(rejected.every((result) => result.code === "GATEWAY_BUSY")).toBe(true);

    // Task 4 has no Wind fetch path yet. At the lease/client boundary, only
    // admitted callers may enter that future path, so observed in-flight is 1.
    let inFlightAtUpstreamBoundary = 0;
    let maxInFlightAtUpstreamBoundary = 0;
    await Promise.all(
      admitted.map(async () => {
        inFlightAtUpstreamBoundary += 1;
        maxInFlightAtUpstreamBoundary = Math.max(
          maxInFlightAtUpstreamBoundary,
          inFlightAtUpstreamBoundary,
        );
        await Promise.resolve();
        inFlightAtUpstreamBoundary -= 1;
      }),
    );
    expect(maxInFlightAtUpstreamBoundary).toBe(1);
  });

  it("catches an unbounded worker wait by returning GATEWAY_BUSY after at most two seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const stub = env.KEY_POOL.getByName("private-key-pool");
    await acquireLease(stub, "holder", BASE_TIME);

    const resultPromise = acquireKeyPoolLease(env, "waiter");
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: null,
    });
  });

  it("catches cooldown failover in the bounded client by waiting for and reacquiring key-01", async () => {
    const stub = env.KEY_POOL.getByName("private-key-pool");
    const now = Date.now();
    const lease = await acquireLease(stub, "rate-limited", now);
    if (!lease.ok) throw new Error("fixture-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: lease.leaseId,
      slotId: lease.slotId,
      category: "qps",
      resetAt: now + 200,
      occurredAt: now + 1,
    });

    await expect(acquireKeyPoolLease(env, "retry-same-slot")).resolves.toMatchObject({
      ok: true,
      slotId: "key-01",
    });
  });
});
