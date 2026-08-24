import { DurableObject } from "cloudflare:workers";

import type { WindFailureCategory } from "../errors/types";
import { initializeKeyPoolSchema } from "./schema";
import type {
  AcquireLeaseResult,
  KeyPoolLeaseStatus,
  KeyPoolSlotStatus,
  KeyPoolStatus,
  PendingTestOutcome,
  ReportOutcomeInput,
  SlotId,
  SlotState,
} from "./types";

export const LEASE_TTL_MS = 1_230_000;

type SlotRow = Record<string, SqlStorageValue> & {
  slot_id: string;
  priority: number;
  state: string;
  reset_at: number | null;
  cooldown_until: number | null;
  last_error_code: string | null;
  call_count: number;
  updated_at: number;
};

type LeaseRow = Record<string, SqlStorageValue> & {
  lease_id: string;
  request_id: string;
  slot_id: string;
  expires_at: number;
};

type PendingTestOutcomeRow = Record<string, SqlStorageValue> & {
  slot_id: string;
  category: string;
};

export class KeyPool extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    initializeKeyPoolSchema(ctx.storage.sql);
  }

  async acquireLease(requestId: string, now: number): Promise<AcquireLeaseResult> {
    assertTimestamp(now);
    if (requestId.length === 0) throw new Error("INVALID_REQUEST_ID");

    const result = this.ctx.storage.transactionSync((): AcquireLeaseResult => {
      this.activateDueSlots(now);
      const current = this.readLease();
      if (current !== null && current.expires_at > now) {
        return {
          ok: false,
          code: "GATEWAY_BUSY",
          retryAfterMs: current.expires_at - now,
        };
      }
      if (current !== null) this.ctx.storage.sql.exec("DELETE FROM lease WHERE singleton = 1");

      const slot = this.ctx.storage.sql
        .exec<SlotRow>(
          "SELECT * FROM slots WHERE state IN ('active', 'cooldown') ORDER BY priority ASC LIMIT 1",
        )
        .toArray()[0];
      if (slot === undefined) {
        const next = this.readNextKnownReset();
        return {
          ok: false,
          code: "KEY_POOL_EXHAUSTED",
          retryAfterMs: next === null ? null : Math.max(0, next - now),
        };
      }
      if (slot.state === "cooldown") {
        return {
          ok: false,
          code: "GATEWAY_BUSY",
          retryAfterMs:
            slot.cooldown_until === null ? null : Math.max(0, slot.cooldown_until - now),
        };
      }

      const leaseId = crypto.randomUUID();
      const expiresAt = now + LEASE_TTL_MS;
      this.ctx.storage.sql.exec(
        "INSERT INTO lease (singleton, lease_id, request_id, slot_id, expires_at) VALUES (1, ?, ?, ?, ?)",
        leaseId,
        requestId,
        slot.slot_id,
        expiresAt,
      );
      return { ok: true, leaseId, slotId: asSlotId(slot.slot_id), expiresAt };
    });

    await this.syncNextAlarm();
    return result;
  }

  async reportOutcome(input: ReportOutcomeInput): Promise<void> {
    assertTimestamp(input.occurredAt);
    assertSlotId(input.slotId);
    if (!isOutcomeCategory(input.category)) throw new Error("INVALID_OUTCOME_CATEGORY");

    this.ctx.storage.transactionSync(() => {
      const lease = this.readLease();
      if (lease === null) throw new Error("LEASE_ALREADY_REPORTED");
      if (lease.lease_id !== input.leaseId) throw new Error("LEASE_ID_MISMATCH");
      if (lease.slot_id !== input.slotId) throw new Error("LEASE_SLOT_MISMATCH");
      if (lease.expires_at <= input.occurredAt) throw new Error("LEASE_EXPIRED");

      const currentSlot = this.ctx.storage.sql
        .exec<SlotRow>("SELECT * FROM slots WHERE slot_id = ?", input.slotId)
        .one();
      const transition = outcomeTransition(input, asSlotState(currentSlot.state));
      this.ctx.storage.sql.exec(
        `UPDATE slots
         SET state = ?, reset_at = ?, cooldown_until = ?, last_error_code = ?,
             call_count = call_count + 1, updated_at = ?
         WHERE slot_id = ?`,
        transition.state,
        transition.resetAt,
        transition.cooldownUntil,
        input.category === "success" ? null : input.category,
        input.occurredAt,
        input.slotId,
      );
      this.ctx.storage.sql.exec("DELETE FROM lease WHERE singleton = 1");
    });

    await this.syncNextAlarm();
  }

  getStatus(): Promise<KeyPoolStatus> {
    const status = this.ctx.storage.transactionSync((): KeyPoolStatus => ({
      slots: this.ctx.storage.sql
        .exec<SlotRow>("SELECT * FROM slots ORDER BY priority ASC")
        .toArray()
        .map(toSlotStatus),
      lease: toLeaseStatus(this.readLease()),
    }));
    return Promise.resolve(status);
  }

  async restoreSlot(slotId: SlotId, now: number): Promise<void> {
    assertTimestamp(now);
    assertSlotId(slotId);
    this.ctx.storage.transactionSync(() => {
      this.assertStoredSlot(slotId);
      this.ctx.storage.sql.exec(
        `UPDATE slots
         SET state = 'active', reset_at = NULL, cooldown_until = NULL,
             last_error_code = NULL, updated_at = ?
         WHERE slot_id = ?`,
        now,
        slotId,
      );
    });
    await this.syncNextAlarm();
  }

  async disableSlot(slotId: SlotId, now: number): Promise<void> {
    assertTimestamp(now);
    assertSlotId(slotId);
    this.ctx.storage.transactionSync(() => {
      this.assertStoredSlot(slotId);
      this.ctx.storage.sql.exec(
        `UPDATE slots
         SET state = 'disabled_manual', reset_at = NULL, cooldown_until = NULL,
             last_error_code = NULL, updated_at = ?
         WHERE slot_id = ?`,
        now,
        slotId,
      );
    });
    await this.syncNextAlarm();
  }

  setNextTestOutcome(input: PendingTestOutcome): Promise<void> {
    assertSlotId(input.slotId);
    if (!isFailureCategory(input.category)) throw new Error("INVALID_TEST_OUTCOME_CATEGORY");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM pending_test_outcome WHERE singleton = 1");
      this.ctx.storage.sql.exec(
        "INSERT INTO pending_test_outcome (singleton, slot_id, category) VALUES (1, ?, ?)",
        input.slotId,
        input.category,
      );
    });
    return Promise.resolve();
  }

  consumeNextTestOutcome(slotId: SlotId): Promise<WindFailureCategory | null> {
    assertSlotId(slotId);
    const category = this.ctx.storage.transactionSync((): WindFailureCategory | null => {
      const row = this.ctx.storage.sql
        .exec<PendingTestOutcomeRow>(
          "SELECT slot_id, category FROM pending_test_outcome WHERE singleton = 1",
        )
        .toArray()[0];
      if (row === undefined || row.slot_id !== slotId) return null;
      if (!isFailureCategory(row.category)) throw new Error("INVALID_STORED_TEST_OUTCOME");
      this.ctx.storage.sql.exec("DELETE FROM pending_test_outcome WHERE singleton = 1");
      return row.category;
    });
    return Promise.resolve(category);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => this.activateDueSlots(now));
    await this.syncNextAlarm();
  }

  private readLease(): LeaseRow | null {
    return (
      this.ctx.storage.sql.exec<LeaseRow>("SELECT * FROM lease WHERE singleton = 1").toArray()[0] ??
      null
    );
  }

  private assertStoredSlot(slotId: SlotId): void {
    const row = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue> & { slot_id: string }>(
        "SELECT slot_id FROM slots WHERE slot_id = ?",
        slotId,
      )
      .toArray()[0];
    if (row === undefined) throw new Error("UNKNOWN_SLOT");
  }

  private activateDueSlots(now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE slots
       SET state = 'active', reset_at = NULL, last_error_code = NULL, updated_at = ?
       WHERE state = 'exhausted_until_reset' AND reset_at IS NOT NULL AND reset_at <= ?`,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE slots
       SET state = 'active', cooldown_until = NULL, last_error_code = NULL, updated_at = ?
       WHERE state = 'cooldown' AND cooldown_until IS NOT NULL AND cooldown_until <= ?`,
      now,
      now,
    );
  }

  private readNextKnownReset(): number | null {
    const row = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue> & { next_at: number | null }>(
        `SELECT MIN(next_at) AS next_at FROM (
           SELECT reset_at AS next_at FROM slots
           WHERE state = 'exhausted_until_reset' AND reset_at IS NOT NULL
           UNION ALL
           SELECT cooldown_until AS next_at FROM slots
           WHERE state = 'cooldown' AND cooldown_until IS NOT NULL
         )`,
      )
      .toArray()[0];
    return row?.next_at ?? null;
  }

  private async syncNextAlarm(): Promise<void> {
    const next = this.readNextKnownReset();
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }
}

function outcomeTransition(input: ReportOutcomeInput, currentState: SlotState): {
  readonly state: SlotState;
  readonly resetAt: number | null;
  readonly cooldownUntil: number | null;
} {
  if (currentState === "disabled_manual") {
    return { state: "disabled_manual", resetAt: null, cooldownUntil: null };
  }
  const resetAt = isKnownFutureReset(input.resetAt, input.occurredAt) ? input.resetAt : null;
  switch (input.category) {
    case "daily_quota":
      return { state: "exhausted_until_reset", resetAt, cooldownUntil: null };
    case "balance":
      return { state: "disabled_balance", resetAt: null, cooldownUntil: null };
    case "auth":
      return { state: "disabled_auth", resetAt: null, cooldownUntil: null };
    case "qps":
      return resetAt === null
        ? { state: "active", resetAt: null, cooldownUntil: null }
        : { state: "cooldown", resetAt: null, cooldownUntil: resetAt };
    default:
      return { state: "active", resetAt: null, cooldownUntil: null };
  }
}

function isKnownFutureReset(value: number | null, now: number): value is number {
  return value !== null && Number.isFinite(value) && value > now;
}

function assertTimestamp(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_TIMESTAMP");
}

function assertSlotId(value: string): asserts value is SlotId {
  if (value !== "key-01" && value !== "key-02") throw new Error("UNKNOWN_SLOT");
}

function isOutcomeCategory(value: unknown): value is ReportOutcomeInput["category"] {
  return (
    value === "success" ||
    value === "daily_quota" ||
    value === "balance" ||
    value === "auth" ||
    value === "qps" ||
    value === "concurrency" ||
    value === "network" ||
    value === "upstream_5xx" ||
    value === "timeout" ||
    value === "response_too_large" ||
    value === "unknown"
  );
}

function isFailureCategory(value: unknown): value is WindFailureCategory {
  return value !== "success" && isOutcomeCategory(value);
}

function asSlotId(value: string): SlotId {
  assertSlotId(value);
  return value;
}

function asSlotState(value: string): SlotState {
  if (
    value !== "active" &&
    value !== "exhausted_until_reset" &&
    value !== "disabled_balance" &&
    value !== "disabled_auth" &&
    value !== "disabled_manual" &&
    value !== "cooldown"
  ) {
    throw new Error("INVALID_STORED_SLOT_STATE");
  }
  return value;
}

function toSlotStatus(row: SlotRow): KeyPoolSlotStatus {
  return {
    slotId: asSlotId(row.slot_id),
    priority: row.priority,
    state: asSlotState(row.state),
    resetAt: row.reset_at,
    cooldownUntil: row.cooldown_until,
    lastErrorCode: row.last_error_code,
    callCount: row.call_count,
    updatedAt: row.updated_at,
  };
}

function toLeaseStatus(row: LeaseRow | null): KeyPoolLeaseStatus | null {
  return row === null
    ? null
    : {
        leaseId: row.lease_id,
        requestId: row.request_id,
        slotId: asSlotId(row.slot_id),
        expiresAt: row.expires_at,
      };
}
