import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReportOutcomeInput } from "../../src/key-pool/types";

const BASE_TIME = Date.UTC(2035, 7, 24, 0, 0, 0);

afterEach(async () => {
  vi.useRealTimers();
  await reset();
});

function keyPool() {
  return env.KEY_POOL.getByName("private-key-pool");
}

describe("KeyPool SQLite Durable Object", () => {
  it("catches a broken priority selector or missing singleton lease by granting key-01 once and reporting busy for overlap", async () => {
    const stub = keyPool();

    const first = await stub.acquireLease("request-01", BASE_TIME);
    const overlapping = await stub.acquireLease("request-02", BASE_TIME + 1);

    expect(first).toMatchObject({
      ok: true,
      slotId: "key-01",
      expiresAt: BASE_TIME + 1_230_000,
    });
    expect(overlapping).toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: 1_229_999,
    });
  });

  it("catches a missing expiry cleanup by reclaiming an expired singleton lease", async () => {
    const stub = keyPool();
    const first = await stub.acquireLease("request-01", BASE_TIME);
    expect(first.ok).toBe(true);

    const replacement = await stub.acquireLease("request-02", BASE_TIME + 1_230_000);

    expect(replacement).toMatchObject({
      ok: true,
      slotId: "key-01",
      expiresAt: BASE_TIME + 2_460_000,
    });
    expect(replacement.ok && first.ok && replacement.leaseId).not.toBe(first.leaseId);
  });

  it("catches in-memory-only coordination by preserving the live lease across eviction", async () => {
    const stub = keyPool();
    const lease = await stub.acquireLease("persistent-holder", BASE_TIME);
    expect(lease).toMatchObject({ ok: true, slotId: "key-01" });

    await evictDurableObject(stub);

    await expect(stub.acquireLease("after-eviction", BASE_TIME + 1)).resolves.toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: 1_229_999,
    });
  });

  it("catches sensitive storage expansion by exposing only anonymous coordination columns", async () => {
    const stub = keyPool();

    const columns = await runInDurableObject(stub, (_instance, state) => ({
      slots: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { name: string }>("PRAGMA table_info(slots)")
        .toArray()
        .map((column) => column.name),
      lease: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { name: string }>("PRAGMA table_info(lease)")
        .toArray()
        .map((column) => column.name),
    }));

    expect(columns).toEqual({
      slots: [
        "slot_id",
        "priority",
        "state",
        "reset_at",
        "cooldown_until",
        "last_error_code",
        "call_count",
        "updated_at",
      ],
      lease: ["singleton", "lease_id", "request_id", "slot_id", "expires_at"],
    });
  });

  it.each([
    ["daily_quota", "exhausted_until_reset"],
    ["balance", "disabled_balance"],
    ["auth", "disabled_auth"],
  ] as const)(
    "catches a wrong %s state transition by disabling the leased slot as %s",
    async (category, expectedState) => {
      const stub = keyPool();
      const lease = await stub.acquireLease(`request-${category}`, BASE_TIME);
      if (!lease.ok) throw new Error("fixture-lease-not-acquired");

      await stub.reportOutcome({
        leaseId: lease.leaseId,
        slotId: lease.slotId,
        category,
        resetAt: category === "daily_quota" ? BASE_TIME + 60_000 : null,
        occurredAt: BASE_TIME + 1,
      });

      const status = await stub.getStatus();
      expect(status.lease).toBeNull();
      expect(status.slots[0]).toMatchObject({
        slotId: "key-01",
        state: expectedState,
        callCount: 1,
        lastErrorCode: category,
      });
      await expect(stub.acquireLease("next-request", BASE_TIME + 2)).resolves.toMatchObject({
        ok: true,
        slotId: "key-02",
      });
    },
  );

  it.each([
    "success",
    "concurrency",
    "network",
    "upstream_5xx",
    "timeout",
    "response_too_large",
    "unknown",
  ] as const)(
    "catches accidental pool burning for %s by releasing key-01 without disabling it",
    async (category) => {
      const stub = keyPool();
      const lease = await stub.acquireLease(`request-${category}`, BASE_TIME);
      if (!lease.ok) throw new Error("fixture-lease-not-acquired");

      await stub.reportOutcome({
        leaseId: lease.leaseId,
        slotId: lease.slotId,
        category,
        resetAt: null,
        occurredAt: BASE_TIME + 1,
      });

      const next = await stub.acquireLease("next-request", BASE_TIME + 2);
      expect(next).toMatchObject({ ok: true, slotId: "key-01" });
      const status = await stub.getStatus();
      expect(status.slots[0]).toMatchObject({
        state: "active",
        callCount: 1,
        lastErrorCode: category === "success" ? null : category,
      });
    },
  );

  it("catches qps failover by blocking the whole pool until key-01 cooldown expires", async () => {
    const stub = keyPool();
    const lease = await stub.acquireLease("qps-request", BASE_TIME);
    if (!lease.ok) throw new Error("fixture-lease-not-acquired");

    await stub.reportOutcome({
      leaseId: lease.leaseId,
      slotId: lease.slotId,
      category: "qps",
      resetAt: BASE_TIME + 5_000,
      occurredAt: BASE_TIME + 1,
    });

    expect((await stub.getStatus()).slots[0]).toMatchObject({
      state: "cooldown",
      cooldownUntil: BASE_TIME + 5_000,
    });
    await expect(stub.acquireLease("during-cooldown", BASE_TIME + 2)).resolves.toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: 4_998,
    });
    await expect(stub.acquireLease("after-cooldown", BASE_TIME + 5_000)).resolves.toMatchObject({
      ok: true,
      slotId: "key-01",
    });
  });

  it("catches unstable exhaustion or priority restore by exhausting both slots then restoring key-01", async () => {
    const stub = keyPool();
    const first = await stub.acquireLease("request-01", BASE_TIME);
    if (!first.ok) throw new Error("fixture-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: first.leaseId,
      slotId: first.slotId,
      category: "daily_quota",
      resetAt: null,
      occurredAt: BASE_TIME + 1,
    });

    const second = await stub.acquireLease("request-02", BASE_TIME + 2);
    if (!second.ok) throw new Error("fixture-second-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: second.leaseId,
      slotId: second.slotId,
      category: "auth",
      resetAt: null,
      occurredAt: BASE_TIME + 3,
    });

    await expect(stub.acquireLease("request-03", BASE_TIME + 4)).resolves.toEqual({
      ok: false,
      code: "KEY_POOL_EXHAUSTED",
      retryAfterMs: null,
    });

    await stub.restoreSlot("key-01", BASE_TIME + 5);
    await expect(stub.acquireLease("request-04", BASE_TIME + 6)).resolves.toMatchObject({
      ok: true,
      slotId: "key-01",
    });
  });

  it("catches an unprotected manual transition by disabling and restoring only a known slot", async () => {
    const stub = keyPool();

    await stub.disableSlot("key-01", BASE_TIME);
    await expect(stub.acquireLease("request-01", BASE_TIME + 1)).resolves.toMatchObject({
      ok: true,
      slotId: "key-02",
    });
    await expect(
      runInDurableObject(stub, (instance) =>
        Reflect.apply(instance.disableSlot, instance, ["key-99", BASE_TIME + 2]),
      ),
    ).rejects.toThrow("UNKNOWN_SLOT");
    await expect(
      runInDurableObject(stub, (instance) =>
        Reflect.apply(instance.restoreSlot, instance, ["key-99", BASE_TIME + 2]),
      ),
    ).rejects.toThrow("UNKNOWN_SLOT");
  });

  it.each(["success", "unknown"] as const)(
    "catches administrative lease preemption and stale %s outcome reactivation",
    async (category) => {
      const stub = keyPool();
      const lease = await stub.acquireLease("in-flight", BASE_TIME);
      if (!lease.ok) throw new Error("fixture-lease-not-acquired");

      await stub.disableSlot("key-01", BASE_TIME + 1);
      await expect(stub.acquireLease("overlap", BASE_TIME + 2)).resolves.toMatchObject({
        ok: false,
        code: "GATEWAY_BUSY",
      });
      await stub.restoreSlot("key-01", BASE_TIME + 3);
      await expect(
        stub.acquireLease("overlap-after-restore", BASE_TIME + 4),
      ).resolves.toMatchObject({
        ok: false,
        code: "GATEWAY_BUSY",
      });
      await stub.disableSlot("key-01", BASE_TIME + 5);
      await stub.reportOutcome({
        leaseId: lease.leaseId,
        slotId: lease.slotId,
        category,
        resetAt: null,
        occurredAt: BASE_TIME + 6,
      });
      expect((await stub.getStatus()).slots[0]).toMatchObject({
        slotId: "key-01",
        state: "disabled_manual",
      });
      await expect(stub.acquireLease("after-report", BASE_TIME + 7)).resolves.toMatchObject({
        ok: true,
        slotId: "key-02",
      });
    },
  );

  it("catches acceptance of stale, mismatched, duplicate, or caller-chosen state reports", async () => {
    const stub = keyPool();
    const lease = await stub.acquireLease("request-01", BASE_TIME);
    if (!lease.ok) throw new Error("fixture-lease-not-acquired");

    await expect(
      runInDurableObject(stub, (instance) =>
        instance.reportOutcome({
          leaseId: lease.leaseId,
          slotId: "key-02",
          category: "success",
          resetAt: null,
          occurredAt: BASE_TIME + 1,
        }),
      ),
    ).rejects.toThrow("LEASE_SLOT_MISMATCH");

    await expect(
      runInDurableObject(stub, (instance) =>
        instance.reportOutcome({
          leaseId: lease.leaseId,
          slotId: lease.slotId,
          category: "success",
          resetAt: null,
          occurredAt: lease.expiresAt,
        }),
      ),
    ).rejects.toThrow("LEASE_EXPIRED");

    const replacement = await stub.acquireLease("request-02", lease.expiresAt);
    if (!replacement.ok) throw new Error("fixture-replacement-lease-not-acquired");
    const validReport: ReportOutcomeInput = {
      leaseId: replacement.leaseId,
      slotId: replacement.slotId,
      category: "success",
      resetAt: null,
      occurredAt: lease.expiresAt + 1,
    };
    await stub.reportOutcome(validReport);
    await expect(
      runInDurableObject(stub, (instance) => instance.reportOutcome(validReport)),
    ).rejects.toThrow("LEASE_ALREADY_REPORTED");

    const third = await stub.acquireLease("request-03", lease.expiresAt + 2);
    if (!third.ok) throw new Error("fixture-third-lease-not-acquired");
    await expect(
      runInDurableObject(stub, (instance) =>
        Reflect.apply(instance.reportOutcome, instance, [
          {
            leaseId: third.leaseId,
            slotId: third.slotId,
            category: "disabled_manual",
            resetAt: null,
            occurredAt: lease.expiresAt + 3,
          },
        ]),
      ),
    ).rejects.toThrow("INVALID_OUTCOME_CATEGORY");
  });

  it("catches eager unknown reset recovery and wrong alarm ordering", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const stub = keyPool();

    const first = await stub.acquireLease("request-01", BASE_TIME);
    if (!first.ok) throw new Error("fixture-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: first.leaseId,
      slotId: first.slotId,
      category: "daily_quota",
      resetAt: BASE_TIME + 10_000,
      occurredAt: BASE_TIME + 1,
    });

    const second = await stub.acquireLease("request-02", BASE_TIME + 2);
    if (!second.ok) throw new Error("fixture-second-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: second.leaseId,
      slotId: second.slotId,
      category: "qps",
      resetAt: BASE_TIME + 5_000,
      occurredAt: BASE_TIME + 3,
    });

    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(BASE_TIME + 5_000);

    vi.setSystemTime(BASE_TIME + 5_000);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    expect((await stub.getStatus()).slots).toMatchObject([
      { slotId: "key-01", state: "exhausted_until_reset" },
      { slotId: "key-02", state: "active" },
    ]);
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(BASE_TIME + 10_000);

    vi.setSystemTime(BASE_TIME + 10_000);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    expect((await stub.getStatus()).slots).toMatchObject([
      { slotId: "key-01", state: "active" },
      { slotId: "key-02", state: "active" },
    ]);
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBeNull();
  });

  it("catches guessed daily resets by leaving an exhausted slot disabled without a known reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const stub = keyPool();
    const lease = await stub.acquireLease("request-01", BASE_TIME);
    if (!lease.ok) throw new Error("fixture-lease-not-acquired");

    await stub.reportOutcome({
      leaseId: lease.leaseId,
      slotId: lease.slotId,
      category: "daily_quota",
      resetAt: null,
      occurredAt: BASE_TIME + 1,
    });

    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBeNull();
    vi.setSystemTime(BASE_TIME + 86_400_000);
    await runInDurableObject(stub, (instance) => instance.alarm());
    expect((await stub.getStatus()).slots[0]).toMatchObject({
      slotId: "key-01",
      state: "exhausted_until_reset",
      resetAt: null,
    });
  });
});
