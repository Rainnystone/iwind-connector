import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AcquireLeaseInput,
  AcquireLeaseResult,
  ReportOutcomeInput,
  SlotId,
} from "../../src/key-pool/types";
import { initializeKeyPoolSchema } from "../../src/key-pool/schema";

const BASE_TIME = Date.UTC(2035, 7, 24, 0, 0, 0);

afterEach(async () => {
  vi.useRealTimers();
  await reset();
});

function keyPool() {
  return env.KEY_POOL.getByName("private-key-pool");
}

function primaryKeyPool() {
  return env.KEY_POOL.getByName("private-key-pool-v2");
}

function acquireLease(
  stub: { acquireLease(input: AcquireLeaseInput): Promise<AcquireLeaseResult> },
  requestId: string,
  now: number,
  attemptedSlotIds: readonly SlotId[] = [],
): Promise<AcquireLeaseResult> {
  return stub.acquireLease({ requestId, attemptedSlotIds, now });
}

describe("KeyPool SQLite Durable Object", () => {
  it("leaves every existing legacy v2 row and schema marker compatible with the old Worker", async () => {
    const stub = keyPool();
    await stub.getStatus();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          `UPDATE slots SET state = 'disabled_balance', reset_at = NULL,
             cooldown_until = NULL, last_error_code = 'balance', call_count = 17,
             updated_at = ? WHERE slot_id = 'key-01'`,
          BASE_TIME - 3,
        );
        state.storage.sql.exec(
          `UPDATE slots SET state = 'cooldown', reset_at = NULL,
             cooldown_until = ?, last_error_code = 'qps', call_count = 23,
             updated_at = ? WHERE slot_id = 'key-02'`,
          BASE_TIME + 60_000,
          BASE_TIME - 2,
        );
        state.storage.sql.exec(
          "UPDATE pool_state SET cursor_slot_id = 'key-02', updated_at = ? WHERE singleton = 1",
          BASE_TIME - 1,
        );
        state.storage.sql.exec(
          `INSERT INTO lease (singleton, lease_id, request_id, slot_id, expires_at)
           VALUES (1, 'legacy-live-lease', 'legacy-request', 'key-02', ?)`,
          BASE_TIME + 30_000,
        );
        state.storage.sql.exec(
          `INSERT INTO oauth_replay_marker (marker_id, kind, expires_at)
           VALUES (?, 'access', ?)`,
          "e".repeat(64),
          BASE_TIME + 600_000,
        );
      });
    });
    const before = await legacyPersistenceSnapshot(stub);

    await evictDurableObject(stub);
    await stub.getStatus();

    expect(await legacyPersistenceSnapshot(stub)).toEqual(before);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<Record<string, SqlStorageValue> & { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pool_manifest'",
          )
          .toArray(),
      ),
    ).resolves.toEqual([]);
  });

  it("initializes a new primary generation at key-03 with schema v3 and three active slots", async () => {
    const stub = primaryKeyPool();

    const status = await stub.getStatus();

    expect(status).toMatchObject({
      currentSlotId: "key-03",
      slots: [
        { slotId: "key-03", priority: 1, state: "active", callCount: 0 },
        { slotId: "key-02", priority: 2, state: "active", callCount: 0 },
        { slotId: "key-01", priority: 3, state: "active", callCount: 0 },
      ],
      lease: null,
    });
    const metadata = await runInDurableObject(stub, (_instance, state) => ({
      manifest: state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            generation_id: string;
            layout_id: string;
          }
        >("SELECT generation_id, layout_id FROM pool_manifest WHERE singleton = 1")
        .one(),
      versions: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { version: number }>(
          "SELECT version FROM _key_pool_schema_migrations ORDER BY version",
        )
        .toArray()
        .map(({ version }) => version),
    }));
    expect(metadata).toEqual({
      manifest: { generation_id: "primary-v2", layout_id: "ring-primary-v1" },
      versions: [1, 2, 3],
    });
  });

  it("appends synthetic fourth and fifth slots atomically without changing live state", async () => {
    const stub = primaryKeyPool();
    const lease = await acquireLease(stub, "future-prefix-holder", BASE_TIME);
    if (!lease.ok) throw new Error("fixture-lease-not-acquired");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          `UPDATE slots SET state = 'disabled_balance', last_error_code = 'balance',
             call_count = 9, updated_at = ? WHERE slot_id = 'key-02'`,
          BASE_TIME - 1,
        );
      });
      Reflect.apply(initializeKeyPoolSchema, undefined, [
        state.storage,
        BASE_TIME + 1,
        syntheticPersistenceConfiguration("ring-primary-v2", [
          "key-03",
          "key-02",
          "key-01",
          "key-04",
        ]),
      ]);
      Reflect.apply(initializeKeyPoolSchema, undefined, [
        state.storage,
        BASE_TIME + 2,
        syntheticPersistenceConfiguration("ring-primary-v3", [
          "key-03",
          "key-02",
          "key-01",
          "key-04",
          "key-05",
        ]),
      ]);
    });

    const persisted = await runInDurableObject(stub, (_instance, state) => ({
      slots: state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            slot_id: string;
            priority: number;
            state: string;
            call_count: number;
            last_error_code: string | null;
          }
        >(
          "SELECT slot_id, priority, state, call_count, last_error_code FROM slots ORDER BY priority",
        )
        .toArray(),
      cursor: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { cursor_slot_id: string }>(
          "SELECT cursor_slot_id FROM pool_state WHERE singleton = 1",
        )
        .one().cursor_slot_id,
      lease: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { lease_id: string; slot_id: string }>(
          "SELECT lease_id, slot_id FROM lease WHERE singleton = 1",
        )
        .one(),
      manifest: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { generation_id: string; layout_id: string }>(
          "SELECT generation_id, layout_id FROM pool_manifest WHERE singleton = 1",
        )
        .one(),
      versions: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { version: number }>(
          "SELECT version FROM _key_pool_schema_migrations ORDER BY version",
        )
        .toArray()
        .map(({ version }) => version),
    }));
    expect(persisted).toEqual({
      slots: [
        { slot_id: "key-03", priority: 1, state: "active", call_count: 0, last_error_code: null },
        { slot_id: "key-02", priority: 2, state: "disabled_balance", call_count: 9, last_error_code: "balance" },
        { slot_id: "key-01", priority: 3, state: "active", call_count: 0, last_error_code: null },
        { slot_id: "key-04", priority: 4, state: "active", call_count: 0, last_error_code: null },
        { slot_id: "key-05", priority: 5, state: "active", call_count: 0, last_error_code: null },
      ],
      cursor: "key-03",
      lease: { lease_id: lease.leaseId, slot_id: "key-03" },
      manifest: { generation_id: "primary-v2", layout_id: "ring-primary-v3" },
      versions: [1, 2, 3],
    });
  });

  it.each([
    ["reorder", "ring-primary-reorder", ["key-03", "key-01", "key-02"]],
    ["middle insertion", "ring-primary-middle", ["key-03", "key-04", "key-02", "key-01"]],
    ["removal", "ring-primary-removal", ["key-03", "key-02"]],
    ["rename", "ring-primary-rename", ["key-03", "key-02", "key-renamed"]],
  ] as const)("fails closed for same-generation %s", async (_label, layoutId, orderedSlotIds) => {
    const stub = primaryKeyPool();
    await stub.getStatus();

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        Reflect.apply(initializeKeyPoolSchema, undefined, [
          state.storage,
          BASE_TIME,
          syntheticPersistenceConfiguration(layoutId, orderedSlotIds),
        ]),
      ),
    ).rejects.toThrow("KEY_POOL_LAYOUT_PREFIX_REQUIRED");
    await expect(stub.getStatus()).resolves.toMatchObject({
      currentSlotId: "key-03",
      slots: [
        { slotId: "key-03", priority: 1 },
        { slotId: "key-02", priority: 2 },
        { slotId: "key-01", priority: 3 },
      ],
    });
  });

  it.each([
    ["duplicate slot", ["key-03", "key-02", "key-02"]],
    ["catalog-external slot", ["key-03", "key-02", "key-01", "key-06"]],
  ] as const)("rejects an invalid target layout with a %s", async (_label, orderedSlotIds) => {
    const stub = primaryKeyPool();
    await stub.getStatus();
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        Reflect.apply(initializeKeyPoolSchema, undefined, [
          state.storage,
          BASE_TIME,
          syntheticPersistenceConfiguration("ring-invalid", orderedSlotIds),
        ]),
      ),
    ).rejects.toThrow("INVALID_KEY_POOL_LAYOUT");
  });

  it("rejects non-contiguous persisted priorities without repairing the object", async () => {
    const stub = primaryKeyPool();
    await stub.getStatus();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE slots SET priority = 99 WHERE slot_id = 'key-01'");
        state.storage.sql.exec("UPDATE slots SET priority = 4 WHERE slot_id = 'key-01'");
      });
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        Reflect.apply(initializeKeyPoolSchema, undefined, [
          state.storage,
          BASE_TIME,
          syntheticPersistenceConfiguration("ring-primary-v1", [
            "key-03",
            "key-02",
            "key-01",
          ]),
        ]),
      ),
    ).rejects.toThrow("INVALID_STORED_KEY_POOL_LAYOUT");
  });

  it("fails closed for generation mismatch and unknown stored metadata", async () => {
    const stub = primaryKeyPool();
    await stub.getStatus();
    const mismatchTarget = {
      layoutId: "ring-other-v1",
      generationId: "other-v3",
      orderedSlotIds: ["key-03", "key-02", "key-01", "key-04"],
    } as const;
    const mismatchConfiguration = syntheticPersistenceConfiguration(
      mismatchTarget.layoutId,
      mismatchTarget.orderedSlotIds,
    );
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        Reflect.apply(initializeKeyPoolSchema, undefined, [
          state.storage,
          BASE_TIME,
          {
            ...mismatchConfiguration,
            generation: { generationId: "other-v3", objectName: "private-key-pool-v3" },
            targetLayout: mismatchTarget,
            knownLayouts: [mismatchConfiguration.knownLayouts[0], mismatchTarget],
          },
        ]),
      ),
    ).rejects.toThrow("KEY_POOL_GENERATION_MISMATCH");

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec(
        "UPDATE pool_manifest SET generation_id = 'unknown-generation' WHERE singleton = 1",
      ),
    );
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        Reflect.apply(initializeKeyPoolSchema, undefined, [
          state.storage,
          BASE_TIME,
          syntheticPersistenceConfiguration("ring-primary-v1", [
            "key-03",
            "key-02",
            "key-01",
          ]),
        ]),
      ),
    ).rejects.toThrow("KEY_POOL_GENERATION_MISMATCH");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE pool_manifest SET generation_id = 'primary-v2' WHERE singleton = 1",
      );
      state.storage.sql.exec(
        "UPDATE pool_manifest SET layout_id = 'unknown-layout' WHERE singleton = 1",
      );
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        Reflect.apply(initializeKeyPoolSchema, undefined, [
          state.storage,
          BASE_TIME,
          syntheticPersistenceConfiguration("ring-primary-v1", [
            "key-03",
            "key-02",
            "key-01",
          ]),
        ]),
      ),
    ).rejects.toThrow("UNKNOWN_STORED_KEY_POOL_LAYOUT");
  });

  it("uses the primary pool's persisted three-slot layout for attempts and eviction", async () => {
    const stub = primaryKeyPool();
    const first = await acquireLease(stub, "primary-attempts", BASE_TIME, ["key-03"]);
    expect(first).toMatchObject({ ok: true, slotId: "key-02" });
    await evictDurableObject(stub);
    await expect(acquireLease(stub, "primary-overlap", BASE_TIME + 1)).resolves.toMatchObject({
      ok: false,
      code: "GATEWAY_BUSY",
    });
    await expect(
      runInDurableObject(stub, (instance) =>
        Reflect.apply(instance.acquireLease, instance, [
          {
            requestId: "too-many-attempts",
            attemptedSlotIds: ["key-03", "key-02", "key-01", "key-03"],
            now: BASE_TIME + 2,
          },
        ]),
      ),
    ).rejects.toThrow("INVALID_ATTEMPTED_SLOTS");
  });

  it.each([
    [
      "a missing required table",
      (sql: SqlStorage) => sql.exec("DROP TABLE lease"),
      "INVALID_KEY_POOL_SCHEMA",
    ],
    [
      "a too-new schema marker",
      (sql: SqlStorage) =>
        sql.exec(
          "INSERT INTO _key_pool_schema_migrations (version, applied_at) VALUES (4, ?)",
          BASE_TIME,
        ),
      "KEY_POOL_SCHEMA_TOO_NEW",
    ],
    [
      "an incomplete schema marker",
      (sql: SqlStorage) => sql.exec("DELETE FROM _key_pool_schema_migrations WHERE version = 3"),
      "INVALID_KEY_POOL_SCHEMA",
    ],
    [
      "a missing manifest row",
      (sql: SqlStorage) => sql.exec("DELETE FROM pool_manifest"),
      "INVALID_KEY_POOL_MANIFEST",
    ],
    [
      "a missing persisted slot",
      (sql: SqlStorage) => sql.exec("DELETE FROM slots WHERE slot_id = 'key-01'"),
      "INVALID_STORED_KEY_POOL_LAYOUT",
    ],
    [
      "an unknown cursor",
      (sql: SqlStorage) =>
        sql.exec("UPDATE pool_state SET cursor_slot_id = 'key-99' WHERE singleton = 1"),
      "INVALID_STORED_POOL_CURSOR",
    ],
    [
      "an unknown leased slot",
      (sql: SqlStorage) =>
        sql.exec(
          `INSERT INTO lease (singleton, lease_id, request_id, slot_id, expires_at)
           VALUES (1, 'invalid-lease', 'invalid-request', 'key-99', ?)`,
          BASE_TIME + 1,
        ),
      "INVALID_STORED_POOL_LEASE",
    ],
  ] as const)("fails closed when a versioned pool has %s", async (_label, mutate, error) => {
    const stub = primaryKeyPool();
    await stub.getStatus();
    await runInDurableObject(stub, (_instance, state) => mutate(state.storage.sql));
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        Reflect.apply(initializeKeyPoolSchema, undefined, [
          state.storage,
          BASE_TIME,
          syntheticPersistenceConfiguration("ring-primary-v1", [
            "key-03",
            "key-02",
            "key-01",
          ]),
        ]),
      ),
    ).rejects.toThrow(error);
  });

  it.each([
    ["markers [2,3]", "DELETE FROM _key_pool_schema_migrations WHERE version = 1"],
    ["markers [1,3]", "DELETE FROM _key_pool_schema_migrations WHERE version = 2"],
    ["only marker [3]", "DELETE FROM _key_pool_schema_migrations WHERE version < 3"],
  ] as const)("rejects primary schema with %s without mutating persisted state", async (_label, sql) => {
    const stub = primaryKeyPool();
    const lease = await acquireLease(stub, `damaged-schema-${_label}`, BASE_TIME);
    if (!lease.ok) throw new Error("fixture-lease-not-acquired");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          `UPDATE slots SET state = 'disabled_balance', last_error_code = 'balance',
             call_count = 11, updated_at = ? WHERE slot_id = 'key-02'`,
          BASE_TIME - 1,
        );
        state.storage.sql.exec(sql);
      });
    });
    const before = await versionedPersistenceSnapshot(stub);

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        Reflect.apply(initializeKeyPoolSchema, undefined, [
          state.storage,
          BASE_TIME + 1,
          syntheticPersistenceConfiguration("ring-primary-v1", [
            "key-03",
            "key-02",
            "key-01",
          ]),
        ]),
      ),
    ).rejects.toThrow("INVALID_KEY_POOL_SCHEMA");
    expect(await versionedPersistenceSnapshot(stub)).toEqual(before);
  });

  it.each([
    [
      "a too-new schema marker",
      (sql: SqlStorage) =>
        sql.exec(
          "INSERT INTO _key_pool_schema_migrations (version, applied_at) VALUES (3, ?)",
          BASE_TIME,
        ),
      "KEY_POOL_SCHEMA_TOO_NEW",
    ],
    [
      "an unknown cursor",
      (sql: SqlStorage) =>
        sql.exec("UPDATE pool_state SET cursor_slot_id = 'key-99' WHERE singleton = 1"),
      "INVALID_STORED_POOL_CURSOR",
    ],
    [
      "an extra slot",
      (sql: SqlStorage) =>
        sql.exec(
          `INSERT INTO slots (
             slot_id, priority, state, reset_at, cooldown_until,
             last_error_code, call_count, updated_at
           ) VALUES ('key-03', 3, 'active', NULL, NULL, NULL, 0, 0)`,
        ),
      "KEY_SLOT_MANIFEST_REMOVAL_UNSUPPORTED",
    ],
  ] as const)("keeps the legacy compatibility initializer fail-closed for %s", async (_label, mutate, error) => {
    const stub = keyPool();
    await stub.getStatus();
    await runInDurableObject(stub, (_instance, state) => mutate(state.storage.sql));
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        initializeKeyPoolSchema(state.storage, BASE_TIME),
      ),
    ).rejects.toThrow(error);
  });

  it("persists quota-driven cursor movement as key-01 to key-02 to key-01", async () => {
    const stub = keyPool();

    const first = await stub.acquireLease({
      requestId: "ring-request-01",
      attemptedSlotIds: [],
      now: BASE_TIME,
    });
    expect(first).toMatchObject({ ok: true, slotId: "key-01" });
    expect((await stub.getStatus()).currentSlotId).toBe("key-01");
    if (!first.ok) throw new Error("fixture-first-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: first.leaseId,
      slotId: first.slotId,
      category: "daily_quota",
      resetAt: null,
      occurredAt: BASE_TIME + 1,
    });

    const second = await stub.acquireLease({
      requestId: "ring-request-01",
      attemptedSlotIds: ["key-01"],
      now: BASE_TIME + 2,
    });
    expect(second).toMatchObject({ ok: true, slotId: "key-02" });
    expect((await stub.getStatus()).currentSlotId).toBe("key-02");
    if (!second.ok) throw new Error("fixture-second-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: second.leaseId,
      slotId: second.slotId,
      category: "daily_quota",
      resetAt: null,
      occurredAt: BASE_TIME + 3,
    });

    await expect(
      stub.acquireLease({
        requestId: "ring-request-02",
        attemptedSlotIds: [],
        now: BASE_TIME + 4,
      }),
    ).resolves.toMatchObject({ ok: true, slotId: "key-01" });
    expect((await stub.getStatus()).currentSlotId).toBe("key-01");
    expect((await stub.getStatus()).slots).toMatchObject([
      { slotId: "key-01", state: "active", lastErrorCode: "daily_quota" },
      { slotId: "key-02", state: "active", lastErrorCode: "daily_quota" },
    ]);
  });

  it("validates attempted slots and selects each manifest slot at most once", async () => {
    const stub = keyPool();
    await expect(
      runInDurableObject(stub, (instance) =>
        Reflect.apply(instance.acquireLease, instance, [
          { requestId: "invalid-duplicate", attemptedSlotIds: ["key-01", "key-01"], now: BASE_TIME },
        ]),
      ),
    ).rejects.toThrow("INVALID_ATTEMPTED_SLOTS");
    await expect(
      runInDurableObject(stub, (instance) =>
        Reflect.apply(instance.acquireLease, instance, [
          { requestId: "invalid-unknown", attemptedSlotIds: ["key-03"], now: BASE_TIME },
        ]),
      ),
    ).rejects.toThrow("INVALID_ATTEMPTED_SLOTS");

    const selected = await acquireLease(stub, "skip-attempted", BASE_TIME, ["key-01"]);
    expect(selected).toMatchObject({ ok: true, slotId: "key-02" });
    expect((await stub.getStatus()).currentSlotId).toBe("key-02");
  });

  it("skips a known-reset slot until due while preserving the ring cursor", async () => {
    const stub = keyPool();
    const first = await acquireLease(stub, "known-reset-01", BASE_TIME);
    if (!first.ok) throw new Error("fixture-first-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: first.leaseId,
      slotId: first.slotId,
      category: "daily_quota",
      resetAt: BASE_TIME + 60_000,
      occurredAt: BASE_TIME + 1,
    });
    const second = await acquireLease(stub, "known-reset-01", BASE_TIME + 2, ["key-01"]);
    if (!second.ok) throw new Error("fixture-second-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: second.leaseId,
      slotId: second.slotId,
      category: "daily_quota",
      resetAt: null,
      occurredAt: BASE_TIME + 3,
    });

    await expect(acquireLease(stub, "known-reset-02", BASE_TIME + 4)).resolves.toMatchObject({
      ok: true,
      slotId: "key-02",
    });
    expect((await stub.getStatus()).currentSlotId).toBe("key-02");
  });

  it("moves the cursor when the current slot is disabled and restore does not steal it back", async () => {
    const stub = keyPool();
    await stub.disableSlot("key-01", BASE_TIME);
    expect((await stub.getStatus()).currentSlotId).toBe("key-02");

    await stub.restoreSlot("key-01", BASE_TIME + 1);
    expect((await stub.getStatus()).currentSlotId).toBe("key-02");
    await expect(acquireLease(stub, "manual-state", BASE_TIME + 2)).resolves.toMatchObject({
      ok: true,
      slotId: "key-02",
    });
  });

  it("preserves the cursor across Durable Object eviction", async () => {
    const stub = keyPool();
    const first = await acquireLease(stub, "cursor-before-eviction", BASE_TIME);
    if (!first.ok) throw new Error("fixture-first-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: first.leaseId,
      slotId: first.slotId,
      category: "daily_quota",
      resetAt: null,
      occurredAt: BASE_TIME + 1,
    });
    expect((await stub.getStatus()).currentSlotId).toBe("key-02");

    await evictDurableObject(stub);
    await expect(acquireLease(stub, "cursor-after-eviction", BASE_TIME + 2)).resolves.toMatchObject({
      ok: true,
      slotId: "key-02",
    });
  });

  it("migrates an old two-slot database from its live lease without losing legacy state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const stub = keyPool();
    await stub.getStatus();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DELETE FROM lease");
        state.storage.sql.exec(
          `INSERT INTO lease (singleton, lease_id, request_id, slot_id, expires_at)
           VALUES (1, 'legacy-lease', 'legacy-request', 'key-02', ?)`,
          BASE_TIME + 60_000,
        );
        state.storage.sql.exec(
          `UPDATE slots SET state = 'exhausted_until_reset', reset_at = NULL,
             last_error_code = 'daily_quota', updated_at = ? WHERE slot_id = 'key-01'`,
          BASE_TIME - 2,
        );
        state.storage.sql.exec("DROP TABLE pool_state");
        state.storage.sql.exec("DROP TABLE _key_pool_schema_migrations");
      });
    });
    await evictDurableObject(stub);

    const status = await stub.getStatus();
    expect(status.currentSlotId).toBe("key-02");
    expect(status.lease).toMatchObject({ leaseId: "legacy-lease", slotId: "key-02" });
    expect(status.slots[0]).toMatchObject({
      slotId: "key-01",
      state: "active",
      lastErrorCode: "daily_quota",
    });
    const migrationRows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { version: number }>(
          "SELECT version FROM _key_pool_schema_migrations ORDER BY version",
        )
        .toArray()
        .map(({ version }) => version),
    );
    expect(migrationRows).toEqual([1, 2]);
  });

  it.each([
    {
      label: "known reset and balance disable",
      firstState: "exhausted_until_reset",
      resetAt: BASE_TIME + 60_000,
      cooldownUntil: null,
      secondState: "disabled_balance",
    },
    {
      label: "QPS cooldown and auth disable",
      firstState: "cooldown",
      resetAt: null,
      cooldownUntil: BASE_TIME + 30_000,
      secondState: "disabled_auth",
    },
    {
      label: "manual disables",
      firstState: "disabled_manual",
      resetAt: null,
      cooldownUntil: null,
      secondState: "disabled_manual",
    },
  ] as const)("preserves legacy $label during cursor migration", async (fixture) => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const stub = keyPool();
    await stub.getStatus();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DELETE FROM lease");
        state.storage.sql.exec(
          `UPDATE slots SET state = ?, reset_at = ?, cooldown_until = ?,
             last_error_code = 'legacy-error', updated_at = ? WHERE slot_id = 'key-01'`,
          fixture.firstState,
          fixture.resetAt,
          fixture.cooldownUntil,
          BASE_TIME - 2,
        );
        state.storage.sql.exec(
          `UPDATE slots SET state = ?, reset_at = NULL, cooldown_until = NULL,
             last_error_code = 'legacy-error', updated_at = ? WHERE slot_id = 'key-02'`,
          fixture.secondState,
          BASE_TIME - 1,
        );
        state.storage.sql.exec("DELETE FROM pool_state");
        state.storage.sql.exec("DELETE FROM _key_pool_schema_migrations WHERE version = 2");
      });
    });
    await evictDurableObject(stub);

    const status = await stub.getStatus();
    expect(status.currentSlotId).toBe("key-01");
    expect(status.slots[0]).toMatchObject({
      slotId: "key-01",
      state: fixture.firstState,
      resetAt: fixture.resetAt,
      cooldownUntil: fixture.cooldownUntil,
      lastErrorCode: "legacy-error",
    });
    expect(status.slots[1]).toMatchObject({
      slotId: "key-02",
      state: fixture.secondState,
      lastErrorCode: "legacy-error",
    });
  });

  it("migrates an all-unknown-reset legacy pool from the latest slot successor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const stub = keyPool();
    await stub.getStatus();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DELETE FROM lease");
        state.storage.sql.exec(
          `UPDATE slots SET state = 'exhausted_until_reset', reset_at = NULL,
             last_error_code = 'daily_quota', updated_at = CASE slot_id
               WHEN 'key-01' THEN ? ELSE ? END`,
          BASE_TIME - 2,
          BASE_TIME - 1,
        );
        state.storage.sql.exec("DELETE FROM pool_state");
        state.storage.sql.exec("DELETE FROM _key_pool_schema_migrations WHERE version = 2");
      });
    });
    await evictDurableObject(stub);

    const status = await stub.getStatus();
    expect(status.currentSlotId).toBe("key-01");
    expect(status.slots).toMatchObject([
      { slotId: "key-01", state: "active", lastErrorCode: "daily_quota" },
      { slotId: "key-02", state: "active", lastErrorCode: "daily_quota" },
    ]);
  });

  it("rejects a stored slot reorder that has no approved migration", async () => {
    const stub = keyPool();
    await stub.getStatus();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE slots SET priority = 99 WHERE slot_id = 'key-01'");
        state.storage.sql.exec("UPDATE slots SET priority = 1 WHERE slot_id = 'key-02'");
        state.storage.sql.exec("UPDATE slots SET priority = 2 WHERE slot_id = 'key-01'");
      });
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        initializeKeyPoolSchema(state.storage, BASE_TIME),
      ),
    ).rejects.toThrow("KEY_SLOT_MANIFEST_REORDER_UNSUPPORTED");
  });

  it("catches a broken priority selector or missing singleton lease by granting key-01 once and reporting busy for overlap", async () => {
    const stub = keyPool();

    const first = await acquireLease(stub, "request-01", BASE_TIME);
    const overlapping = await acquireLease(stub, "request-02", BASE_TIME + 1);

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
    const first = await acquireLease(stub, "request-01", BASE_TIME);
    expect(first.ok).toBe(true);

    const replacement = await acquireLease(stub, "request-02", BASE_TIME + 1_230_000);

    expect(replacement).toMatchObject({
      ok: true,
      slotId: "key-01",
      expiresAt: BASE_TIME + 2_460_000,
    });
    expect(replacement.ok && first.ok && replacement.leaseId).not.toBe(first.leaseId);
  });

  it("catches in-memory-only coordination by preserving the live lease across eviction", async () => {
    const stub = keyPool();
    const lease = await acquireLease(stub, "persistent-holder", BASE_TIME);
    expect(lease).toMatchObject({ ok: true, slotId: "key-01" });

    await evictDurableObject(stub);

    await expect(acquireLease(stub, "after-eviction", BASE_TIME + 1)).resolves.toEqual({
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
      testOutcome: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { name: string }>(
          "PRAGMA table_info(pending_test_outcome)",
        )
        .toArray()
        .map((column) => column.name),
      oauthReplay: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { name: string }>(
          "PRAGMA table_info(oauth_replay_marker)",
        )
        .toArray()
        .map((column) => column.name),
      schemaMigrations: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { name: string }>(
          "PRAGMA table_info(_key_pool_schema_migrations)",
        )
        .toArray()
        .map((column) => column.name),
      poolState: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { name: string }>(
          "PRAGMA table_info(pool_state)",
        )
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
      testOutcome: ["singleton", "slot_id", "category"],
      oauthReplay: ["marker_id", "kind", "expires_at"],
      schemaMigrations: ["version", "applied_at"],
      poolState: ["singleton", "cursor_slot_id", "updated_at"],
    });
  });

  it("atomically consumes an unexpired OAuth replay marker exactly once", async () => {
    const stub = keyPool();
    const markerId = "a".repeat(64);
    await stub.setOAuthReplayMarker({ markerId, kind: "access", now: BASE_TIME });

    const consumed = await Promise.all([
      stub.consumeOAuthReplayMarker({ markerId, kind: "access", now: BASE_TIME + 1 }),
      stub.consumeOAuthReplayMarker({ markerId, kind: "access", now: BASE_TIME + 1 }),
    ]);

    expect(consumed.sort()).toEqual([false, true].sort());
  });

  it("rejects an expired or wrong-kind OAuth replay marker", async () => {
    const stub = keyPool();
    const markerId = "b".repeat(64);
    await stub.setOAuthReplayMarker({ markerId, kind: "consent", now: BASE_TIME });

    await expect(
      stub.consumeOAuthReplayMarker({ markerId, kind: "access", now: BASE_TIME + 1 }),
    ).resolves.toBe(false);
    await expect(
      stub.consumeOAuthReplayMarker({ markerId, kind: "consent", now: BASE_TIME + 600_000 }),
    ).resolves.toBe(false);
  });

  it("strictly rejects malformed OAuth replay RPC inputs", async () => {
    const stub = keyPool();
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.setOAuthReplayMarker({ markerId: "short", kind: "access", now: BASE_TIME }),
      ),
    ).rejects.toThrow("INVALID_OAUTH_REPLAY_MARKER");
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.setOAuthReplayMarker({
          markerId: "c".repeat(64),
          kind: "unexpected",
          now: BASE_TIME,
        } as never),
      ),
    ).rejects.toThrow("INVALID_OAUTH_REPLAY_KIND");
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.setOAuthReplayMarker({ markerId: "d".repeat(64), kind: "access", now: -1 }),
      ),
    ).rejects.toThrow("INVALID_TIMESTAMP");
  });

  it("atomically consumes one anonymous synthetic outcome exactly once", async () => {
    const stub = keyPool();

    await stub.setNextTestOutcome({ slotId: "key-01", category: "daily_quota" });

    const consumed = await Promise.all([
      stub.consumeNextTestOutcome("key-01"),
      stub.consumeNextTestOutcome("key-01"),
    ]);
    expect(consumed.sort()).toEqual(["daily_quota", null].sort());
    await expect(stub.consumeNextTestOutcome("key-02")).resolves.toBeNull();
  });

  it.each([
    ["daily_quota", "exhausted_until_reset"],
    ["balance", "disabled_balance"],
    ["auth", "disabled_auth"],
  ] as const)(
    "catches a wrong %s state transition by disabling the leased slot as %s",
    async (category, expectedState) => {
      const stub = keyPool();
      const lease = await acquireLease(stub, `request-${category}`, BASE_TIME);
      if (!lease.ok) throw new Error("fixture-lease-not-acquired");

      await stub.reportOutcome({
        leaseId: lease.leaseId,
        slotId: lease.slotId,
        category,
        resetAt: category === "daily_quota" ? BASE_TIME + 60_000 : null,
        occurredAt: BASE_TIME + 1,
      });

      const status = await stub.getStatus();
      expect(status.currentSlotId).toBe("key-02");
      expect(status.lease).toBeNull();
      expect(status.slots[0]).toMatchObject({
        slotId: "key-01",
        state: expectedState,
        callCount: 1,
        lastErrorCode: category,
      });
      await expect(acquireLease(stub, "next-request", BASE_TIME + 2)).resolves.toMatchObject({
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
      const lease = await acquireLease(stub, `request-${category}`, BASE_TIME);
      if (!lease.ok) throw new Error("fixture-lease-not-acquired");

      await stub.reportOutcome({
        leaseId: lease.leaseId,
        slotId: lease.slotId,
        category,
        resetAt: null,
        occurredAt: BASE_TIME + 1,
      });

      const next = await acquireLease(stub, "next-request", BASE_TIME + 2);
      expect(next).toMatchObject({ ok: true, slotId: "key-01" });
      const status = await stub.getStatus();
      expect(status.currentSlotId).toBe("key-01");
      expect(status.slots[0]).toMatchObject({
        state: "active",
        callCount: 1,
        lastErrorCode: category === "success" ? null : category,
      });
    },
  );

  it("catches qps failover by blocking the whole pool until key-01 cooldown expires", async () => {
    const stub = keyPool();
    const lease = await acquireLease(stub, "qps-request", BASE_TIME);
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
    expect((await stub.getStatus()).currentSlotId).toBe("key-01");
    await expect(acquireLease(stub, "during-cooldown", BASE_TIME + 2)).resolves.toEqual({
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs: 4_998,
    });
    await expect(acquireLease(stub, "after-cooldown", BASE_TIME + 5_000)).resolves.toMatchObject({
      ok: true,
      slotId: "key-01",
    });
  });

  it("stops after every slot was attempted once and lets the next request probe again", async () => {
    const stub = keyPool();
    const first = await acquireLease(stub, "request-01", BASE_TIME, []);
    if (!first.ok) throw new Error("fixture-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: first.leaseId,
      slotId: first.slotId,
      category: "daily_quota",
      resetAt: null,
      occurredAt: BASE_TIME + 1,
    });

    const second = await acquireLease(stub, "request-01", BASE_TIME + 2, ["key-01"]);
    if (!second.ok) throw new Error("fixture-second-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: second.leaseId,
      slotId: second.slotId,
      category: "daily_quota",
      resetAt: null,
      occurredAt: BASE_TIME + 3,
    });

    await expect(
      acquireLease(stub, "request-01", BASE_TIME + 4, ["key-01", "key-02"]),
    ).resolves.toEqual({ ok: false, code: "KEY_POOL_EXHAUSTED", retryAfterMs: null });
    await expect(acquireLease(stub, "request-02", BASE_TIME + 5)).resolves.toMatchObject({
      ok: true,
      slotId: "key-01",
    });
  });

  it("catches an unprotected manual transition by disabling and restoring only a known slot", async () => {
    const stub = keyPool();

    await stub.disableSlot("key-01", BASE_TIME);
    await expect(acquireLease(stub, "request-01", BASE_TIME + 1)).resolves.toMatchObject({
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
      const lease = await acquireLease(stub, "in-flight", BASE_TIME);
      if (!lease.ok) throw new Error("fixture-lease-not-acquired");

      await stub.disableSlot("key-01", BASE_TIME + 1);
      await expect(acquireLease(stub, "overlap", BASE_TIME + 2)).resolves.toMatchObject({
        ok: false,
        code: "GATEWAY_BUSY",
      });
      await stub.restoreSlot("key-01", BASE_TIME + 3);
      await expect(
        acquireLease(stub, "overlap-after-restore", BASE_TIME + 4),
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
      await expect(acquireLease(stub, "after-report", BASE_TIME + 7)).resolves.toMatchObject({
        ok: true,
        slotId: "key-02",
      });
    },
  );

  it("catches acceptance of stale, mismatched, duplicate, or caller-chosen state reports", async () => {
    const stub = keyPool();
    const lease = await acquireLease(stub, "request-01", BASE_TIME);
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

    const replacement = await acquireLease(stub, "request-02", lease.expiresAt);
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

    const third = await acquireLease(stub, "request-03", lease.expiresAt + 2);
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

    const first = await acquireLease(stub, "request-01", BASE_TIME);
    if (!first.ok) throw new Error("fixture-lease-not-acquired");
    await stub.reportOutcome({
      leaseId: first.leaseId,
      slotId: first.slotId,
      category: "daily_quota",
      resetAt: BASE_TIME + 10_000,
      occurredAt: BASE_TIME + 1,
    });

    const second = await acquireLease(stub, "request-02", BASE_TIME + 2);
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

  it("keeps an unknown-reset daily slot probeable without scheduling a guessed alarm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const stub = keyPool();
    const lease = await acquireLease(stub, "request-01", BASE_TIME);
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
      state: "active",
      resetAt: null,
      lastErrorCode: "daily_quota",
    });
  });
});

async function legacyPersistenceSnapshot(stub: ReturnType<typeof keyPool>) {
  return runInDurableObject(stub, (_instance, state) => ({
    slots: state.storage.sql.exec("SELECT * FROM slots ORDER BY priority").toArray(),
    lease: state.storage.sql.exec("SELECT * FROM lease").toArray(),
    cursor: state.storage.sql.exec("SELECT * FROM pool_state").toArray(),
    markers: state.storage.sql
      .exec("SELECT * FROM oauth_replay_marker ORDER BY marker_id")
      .toArray(),
    versions: state.storage.sql
      .exec("SELECT * FROM _key_pool_schema_migrations ORDER BY version")
      .toArray(),
  }));
}

async function versionedPersistenceSnapshot(stub: ReturnType<typeof primaryKeyPool>) {
  return runInDurableObject(stub, (_instance, state) => ({
    slots: state.storage.sql.exec("SELECT * FROM slots ORDER BY priority").toArray(),
    lease: state.storage.sql.exec("SELECT * FROM lease").toArray(),
    cursor: state.storage.sql.exec("SELECT * FROM pool_state").toArray(),
    manifest: state.storage.sql.exec("SELECT * FROM pool_manifest").toArray(),
    versions: state.storage.sql
      .exec("SELECT * FROM _key_pool_schema_migrations ORDER BY version")
      .toArray(),
  }));
}

function syntheticPersistenceConfiguration(
  layoutId: string,
  orderedSlotIds: readonly string[],
) {
  const knownLayouts = [
    {
      layoutId: "ring-primary-v1",
      generationId: "primary-v2",
      orderedSlotIds: ["key-03", "key-02", "key-01"],
    },
    ...(layoutId === "ring-primary-v3"
      ? [
          {
            layoutId: "ring-primary-v2",
            generationId: "primary-v2",
            orderedSlotIds: ["key-03", "key-02", "key-01", "key-04"],
          },
        ]
      : []),
    ...(layoutId === "ring-primary-v1"
      ? []
      : [{ layoutId, generationId: "primary-v2", orderedSlotIds }]),
  ];
  return {
    catalog: [
      { slotId: "key-01", secretBinding: "WIND_API_KEY_01" },
      { slotId: "key-02", secretBinding: "WIND_API_KEY_02" },
      { slotId: "key-03", secretBinding: "WIND_API_KEY_03" },
      { slotId: "key-04", secretBinding: "WIND_API_KEY_04" },
      { slotId: "key-05", secretBinding: "WIND_API_KEY_05" },
      { slotId: "key-renamed", secretBinding: "WIND_API_KEY_RENAMED" },
    ],
    generation: { generationId: "primary-v2", objectName: "private-key-pool-v2" },
    targetLayout: knownLayouts.at(-1),
    knownLayouts,
    preserveLegacySchema: false,
  };
}
