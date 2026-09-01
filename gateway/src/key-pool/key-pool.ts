import { DurableObject } from "cloudflare:workers";

import type { WindFailureCategory } from "../errors/types";
import { nextSlotId, orderSlotRing } from "./slot-ring";
import {
  LEGACY_KEY_POOL_LAYOUT_ID,
  KEY_SLOT_DEFINITIONS,
  isSlotIdInLayout,
} from "./slots";
import { initializeKeyPoolSchema } from "./schema";
import type {
  AcquireLeaseResult,
  AcquireLeaseInput,
  KeyPoolLeaseStatus,
  KeyPoolSlotStatus,
  KeyPoolStatus,
  OAuthReplayMarkerInput,
  PendingTestOutcome,
  ReportOutcomeInput,
  SlotId,
  SlotState,
} from "./types";

export const LEASE_TTL_MS = 1_230_000;
export const OAUTH_REPLAY_TTL_MS = 600_000;

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

type PoolStateRow = Record<string, SqlStorageValue> & {
  cursor_slot_id: string;
  updated_at: number;
};

export class KeyPool extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    initializeKeyPoolSchema(ctx.storage, Date.now());
  }

  async acquireLease(input: AcquireLeaseInput): Promise<AcquireLeaseResult> {
    assertAcquireLeaseInput(input);
    const attemptedSlotIds = new Set<SlotId>(input.attemptedSlotIds);

    const result = this.ctx.storage.transactionSync((): AcquireLeaseResult => {
      this.activateDueSlots(input.now);
      const current = this.readLease();
      if (current !== null && current.expires_at > input.now) {
        return {
          ok: false,
          code: "GATEWAY_BUSY",
          retryAfterMs: current.expires_at - input.now,
        };
      }
      if (current !== null) this.ctx.storage.sql.exec("DELETE FROM lease WHERE singleton = 1");

      const cursorSlotId = this.readCursor();
      const slots = orderSlotRing(
        this.ctx.storage.sql
          .exec<SlotRow>("SELECT * FROM slots ORDER BY priority ASC")
          .toArray()
          .map((row) => ({ ...row, slotId: row.slot_id })),
        cursorSlotId,
      );
      const cursorSlot = slots[0];
      if (cursorSlot?.state === "cooldown") {
        return {
          ok: false,
          code: "GATEWAY_BUSY",
          retryAfterMs:
            cursorSlot.cooldown_until === null
              ? null
              : Math.max(0, cursorSlot.cooldown_until - input.now),
        };
      }
      const slot = slots.find(
        (candidate) =>
          candidate.state === "active" && !attemptedSlotIds.has(asSlotId(candidate.slot_id)),
      );
      if (slot === undefined) {
        const next = this.readNextKnownReset();
        return {
          ok: false,
          code: "KEY_POOL_EXHAUSTED",
          retryAfterMs: next === null ? null : Math.max(0, next - input.now),
        };
      }

      const leaseId = crypto.randomUUID();
      const expiresAt = input.now + LEASE_TTL_MS;
      this.writeCursor(asSlotId(slot.slot_id), input.now);
      this.ctx.storage.sql.exec(
        "INSERT INTO lease (singleton, lease_id, request_id, slot_id, expires_at) VALUES (1, ?, ?, ?, ?)",
        leaseId,
        input.requestId,
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
      if (transition.advanceCursor) {
        this.advanceCursorIfCurrent(input.slotId, input.occurredAt);
      }
    });

    await this.syncNextAlarm();
  }

  getStatus(): Promise<KeyPoolStatus> {
    const status = this.ctx.storage.transactionSync((): KeyPoolStatus => ({
      currentSlotId: this.readCursor(),
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
      this.advanceCursorIfCurrent(slotId, now);
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

  setOAuthReplayMarker(input: OAuthReplayMarkerInput): Promise<void> {
    assertOAuthReplayMarkerInput(input);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM oauth_replay_marker WHERE expires_at <= ?", input.now);
      this.ctx.storage.sql.exec(
        "INSERT INTO oauth_replay_marker (marker_id, kind, expires_at) VALUES (?, ?, ?)",
        input.markerId,
        input.kind,
        input.now + OAUTH_REPLAY_TTL_MS,
      );
    });
    return Promise.resolve();
  }

  consumeOAuthReplayMarker(input: OAuthReplayMarkerInput): Promise<boolean> {
    assertOAuthReplayMarkerInput(input);
    const consumed = this.ctx.storage.transactionSync((): boolean => {
      this.ctx.storage.sql.exec("DELETE FROM oauth_replay_marker WHERE expires_at <= ?", input.now);
      const row = this.ctx.storage.sql
        .exec<Record<string, SqlStorageValue> & { marker_id: string }>(
          `SELECT marker_id FROM oauth_replay_marker
           WHERE marker_id = ? AND kind = ? AND expires_at > ?`,
          input.markerId,
          input.kind,
          input.now,
        )
        .toArray()[0];
      if (row === undefined) return false;
      this.ctx.storage.sql.exec(
        "DELETE FROM oauth_replay_marker WHERE marker_id = ?",
        input.markerId,
      );
      return true;
    });
    return Promise.resolve(consumed);
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

  private readCursor(): SlotId {
    const row = this.ctx.storage.sql
      .exec<PoolStateRow>(
        "SELECT cursor_slot_id, updated_at FROM pool_state WHERE singleton = 1",
      )
      .one();
    return asSlotId(row.cursor_slot_id);
  }

  private writeCursor(slotId: SlotId, now: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE pool_state SET cursor_slot_id = ?, updated_at = ? WHERE singleton = 1",
      slotId,
      now,
    );
  }

  private advanceCursorIfCurrent(slotId: SlotId, now: number): void {
    if (this.readCursor() !== slotId) return;
    const next = nextSlotId(KEY_SLOT_DEFINITIONS, slotId);
    assertSlotId(next);
    this.writeCursor(next, now);
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
  readonly advanceCursor: boolean;
} {
  if (currentState === "disabled_manual") {
    return {
      state: "disabled_manual",
      resetAt: null,
      cooldownUntil: null,
      advanceCursor: false,
    };
  }
  const resetAt = isKnownFutureReset(input.resetAt, input.occurredAt) ? input.resetAt : null;
  switch (input.category) {
    case "daily_quota":
      return {
        state: resetAt === null ? "active" : "exhausted_until_reset",
        resetAt,
        cooldownUntil: null,
        advanceCursor: true,
      };
    case "balance":
      return {
        state: "disabled_balance",
        resetAt: null,
        cooldownUntil: null,
        advanceCursor: true,
      };
    case "auth":
      return {
        state: "disabled_auth",
        resetAt: null,
        cooldownUntil: null,
        advanceCursor: true,
      };
    case "qps":
      return resetAt === null
        ? { state: "active", resetAt: null, cooldownUntil: null, advanceCursor: false }
        : {
            state: "cooldown",
            resetAt: null,
            cooldownUntil: resetAt,
            advanceCursor: false,
          };
    default:
      return { state: "active", resetAt: null, cooldownUntil: null, advanceCursor: false };
  }
}

function isKnownFutureReset(value: number | null, now: number): value is number {
  return value !== null && Number.isFinite(value) && value > now;
}

function assertTimestamp(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_TIMESTAMP");
}

function assertAcquireLeaseInput(input: AcquireLeaseInput): void {
  if (typeof input !== "object" || input === null) throw new Error("INVALID_ACQUIRE_INPUT");
  assertTimestamp(input.now);
  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    throw new Error("INVALID_REQUEST_ID");
  }
  if (
    !Array.isArray(input.attemptedSlotIds) ||
    input.attemptedSlotIds.length > KEY_SLOT_DEFINITIONS.length ||
    input.attemptedSlotIds.some((slotId) => !isSlotIdInLayout(slotId, LEGACY_KEY_POOL_LAYOUT_ID)) ||
    new Set(input.attemptedSlotIds).size !== input.attemptedSlotIds.length
  ) {
    throw new Error("INVALID_ATTEMPTED_SLOTS");
  }
}

function assertOAuthReplayMarkerInput(input: OAuthReplayMarkerInput): void {
  assertTimestamp(input.now);
  if (!/^[a-f0-9]{64}$/u.test(input.markerId)) throw new Error("INVALID_OAUTH_REPLAY_MARKER");
  if (input.kind !== "access" && input.kind !== "consent") {
    throw new Error("INVALID_OAUTH_REPLAY_KIND");
  }
}

function assertSlotId(value: string): asserts value is SlotId {
  if (!isSlotIdInLayout(value, LEGACY_KEY_POOL_LAYOUT_ID)) throw new Error("UNKNOWN_SLOT");
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
