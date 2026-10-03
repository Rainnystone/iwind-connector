import { DurableObject } from "cloudflare:workers";

import type { WindFailureCategory } from "../errors/types";
import { MAX_SAME_SLOT_RETRY_DELAY_MS } from "../errors/classifier";
import { WIND_ATTEMPT_TIMEOUT_MS } from "../upstream/attempt-timeout";
import { nextSlotId, orderSlotRing } from "./slot-ring";
import { getKeyPoolConfigurationForObject } from "./slots";
import {
  initializeKeyPoolSchema,
  runtimeKeyPoolPersistenceConfiguration,
} from "./schema";
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

const LEASE_MARGIN_MS = 5_000;
export const LEASE_TTL_MS =
  2 * WIND_ATTEMPT_TIMEOUT_MS + MAX_SAME_SLOT_RETRY_DELAY_MS + LEASE_MARGIN_MS;
export const OAUTH_REPLAY_TTL_MS = 600_000;
const WAITLIST_STALE_AFTER_MS = 5_000;
const RESERVATION_TTL_MS = 2_000;
const DEFAULT_HOLD_MS = 8_000;
const MIN_REFUSAL_RETRY_MS = 1_000;

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
  granted_at: number | null;
};

type ReservationRow = Record<string, SqlStorageValue> & {
  request_id: string;
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

type StoredSlotDefinitionRow = Record<string, SqlStorageValue> & {
  slot_id: string;
  priority: number;
};

export class KeyPool extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const configuration = getKeyPoolConfigurationForObject(ctx.id.name, env.KEY_POOL_LAYOUT_ID);
    initializeKeyPoolSchema(
      ctx.storage,
      Date.now(),
      runtimeKeyPoolPersistenceConfiguration(configuration.layout.layoutId),
    );
  }

  async acquireLease(input: AcquireLeaseInput): Promise<AcquireLeaseResult> {
    assertAcquireLeaseInputShape(input);
    const attemptedSlotIds = new Set<string>(input.attemptedSlotIds);

    const result = this.ctx.storage.transactionSync((): AcquireLeaseResult => {
      const storedDefinitions = this.readStoredSlotDefinitions();
      assertAttemptedSlotIds(input.attemptedSlotIds, storedDefinitions);
      this.activateDueSlots(input.now);
      this.dropDepartedWaiters(input.now);
      const lease = this.readLease();
      const liveLease = lease !== null && lease.expires_at > input.now ? lease : null;
      const reservation = this.readLiveReservation(input.now);
      const holdsReservation = reservation !== null && reservation.request_id === input.requestId;
      const otherReservation = holdsReservation ? null : reservation;

      if (holdsReservation) {
        this.ctx.storage.sql.exec("DELETE FROM reservation WHERE singleton = 1");
      } else {
        const waitMs = this.estimatedWaitMs(input.requestId, input.now, liveLease, otherReservation);
        if (this.isWaiting(input.requestId)) {
          this.refreshWaiter(input.requestId, input.now);
        } else {
          const budgetMs = input.deadlineAt - input.now;
          if (waitMs > budgetMs) return this.refuse(input.now, waitMs, budgetMs);
          this.joinWaitlist(input.requestId, input.now, input.deadlineAt);
        }
        if (liveLease !== null || otherReservation !== null || !this.isHead(input.requestId)) {
          return this.busy(waitMs, true);
        }
      }
      if (lease !== null) this.ctx.storage.sql.exec("DELETE FROM lease WHERE singleton = 1");

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
        const retryAfterMs =
          cursorSlot.cooldown_until === null
            ? null
            : Math.max(0, cursorSlot.cooldown_until - input.now);
        return this.busy(retryAfterMs, !holdsReservation);
      }
      const slot = slots.find(
        (candidate) =>
          candidate.state === "active" && !attemptedSlotIds.has(candidate.slot_id),
      );
      if (slot === undefined) {
        this.deleteWaitlistRow(input.requestId);
        const next = this.readNextKnownReset();
        return {
          ok: false,
          code: "KEY_POOL_EXHAUSTED",
          retryAfterMs: next === null ? null : Math.max(0, next - input.now),
          queueDepth: this.waitlistDepth(),
          inLine: false,
        };
      }

      this.deleteWaitlistRow(input.requestId);
      const queueDepth = this.waitlistDepth();
      const leaseId = crypto.randomUUID();
      const expiresAt = input.now + LEASE_TTL_MS;
      const slotId = this.asPersistedSlotId(slot.slot_id);
      this.writeCursor(slotId, input.now);
      this.ctx.storage.sql.exec(
        `INSERT INTO lease (singleton, lease_id, request_id, slot_id, expires_at, granted_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
        leaseId,
        input.requestId,
        slot.slot_id,
        expiresAt,
        input.now,
      );
      return { ok: true, leaseId, slotId, expiresAt, queueDepth };
    });

    await this.syncNextAlarm();
    return result;
  }

  async reportOutcome(input: ReportOutcomeInput): Promise<void> {
    assertTimestamp(input.occurredAt);
    if (!isOutcomeCategory(input.category)) throw new Error("INVALID_OUTCOME_CATEGORY");

    this.ctx.storage.transactionSync(() => {
      this.assertStoredSlot(input.slotId);
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
      if (lease.granted_at !== null) this.recordHold(input.occurredAt - lease.granted_at);
      this.ctx.storage.sql.exec("DELETE FROM lease WHERE singleton = 1");
      if (input.continuing === true) {
        this.ctx.storage.sql.exec("DELETE FROM reservation WHERE singleton = 1");
        this.ctx.storage.sql.exec(
          "INSERT INTO reservation (singleton, request_id, expires_at) VALUES (1, ?, ?)",
          lease.request_id,
          input.occurredAt + RESERVATION_TTL_MS,
        );
      }
      if (transition.advanceCursor) {
        this.advanceCursorIfCurrent(input.slotId, input.occurredAt);
      }
    });

    await this.syncNextAlarm();
  }

  getStatus(): Promise<KeyPoolStatus> {
    const status = this.ctx.storage.transactionSync((): KeyPoolStatus => {
      const slots = this.ctx.storage.sql
        .exec<SlotRow>("SELECT * FROM slots ORDER BY priority ASC")
        .toArray()
        .map((row) => this.toSlotStatus(row));
      return {
        currentSlotId: this.readCursor(),
        slots,
        lease: this.toLeaseStatus(this.readLease()),
      };
    });
    return Promise.resolve(status);
  }

  async restoreSlot(slotId: SlotId, now: number): Promise<void> {
    assertTimestamp(now);
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
    if (!isFailureCategory(input.category)) throw new Error("INVALID_TEST_OUTCOME_CATEGORY");
    this.ctx.storage.transactionSync(() => {
      this.assertStoredSlot(input.slotId);
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
    const category = this.ctx.storage.transactionSync((): WindFailureCategory | null => {
      this.assertStoredSlot(slotId);
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

  private dropDepartedWaiters(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM waitlist WHERE deadline_at <= ? OR last_seen_at < ?",
      now,
      now - WAITLIST_STALE_AFTER_MS,
    );
  }

  private isWaiting(requestId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM waitlist WHERE request_id = ?", requestId)
        .toArray().length > 0
    );
  }

  private joinWaitlist(requestId: string, now: number, deadlineAt: number): void {
    const nextTicket =
      this.ctx.storage.sql
        .exec<Record<string, SqlStorageValue> & { ticket: number }>(
          "SELECT COALESCE(MAX(ticket), 0) AS ticket FROM waitlist",
        )
        .one().ticket + 1;
    this.ctx.storage.sql.exec(
      "INSERT INTO waitlist (request_id, ticket, deadline_at, last_seen_at) VALUES (?, ?, ?, ?)",
      requestId,
      nextTicket,
      deadlineAt,
      now,
    );
  }

  private refreshWaiter(requestId: string, now: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE waitlist SET last_seen_at = ? WHERE request_id = ?",
      now,
      requestId,
    );
  }

  private isHead(requestId: string): boolean {
    const head = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue> & { request_id: string }>(
        "SELECT request_id FROM waitlist ORDER BY ticket ASC LIMIT 1",
      )
      .toArray()[0];
    return head?.request_id === requestId;
  }

  private estimatedWaitMs(
    requestId: string,
    now: number,
    liveLease: LeaseRow | null,
    otherReservation: ReservationRow | null,
  ): number {
    const medianMs = this.medianHoldMs();
    let blockerMs = this.cursorCooldownRemainingMs(now);
    if (liveLease !== null) blockerMs = holderRemainingMs(liveLease, now, medianMs);
    else if (otherReservation !== null) blockerMs = otherReservation.expires_at - now + medianMs;
    return blockerMs + this.callersAhead(requestId) * medianMs;
  }

  private busy(retryAfterMs: number | null, inLine: boolean): AcquireLeaseResult {
    return {
      ok: false,
      code: "GATEWAY_BUSY",
      retryAfterMs,
      queueDepth: this.waitlistDepth(),
      inLine,
    };
  }

  private waitlistDepth(): number {
    return this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue> & { count: number }>(
        "SELECT COUNT(*) AS count FROM waitlist",
      )
      .one().count;
  }

  private deleteWaitlistRow(requestId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM waitlist WHERE request_id = ?", requestId);
  }

  private recordHold(durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1) return;
    this.ctx.storage.sql.exec("INSERT INTO lease_hold (duration_ms) VALUES (?)", durationMs);
    this.ctx.storage.sql.exec(
      `DELETE FROM lease_hold WHERE id NOT IN (
         SELECT id FROM lease_hold ORDER BY id DESC LIMIT 16
       )`,
    );
  }

  private refuse(now: number, waitMs: number, budgetMs: number): AcquireLeaseResult {
    const horizonAt =
      this.ctx.storage.sql
        .exec<Record<string, SqlStorageValue> & { at: number }>(
          "SELECT at FROM refusal_horizon WHERE singleton = 1",
        )
        .toArray()[0]?.at ?? now;
    const rejoinAt = Math.max(now + waitMs - budgetMs, now + MIN_REFUSAL_RETRY_MS, horizonAt);
    this.ctx.storage.sql.exec(
      `INSERT INTO refusal_horizon (singleton, at) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET at = excluded.at`,
      rejoinAt + this.medianHoldMs(),
    );
    return this.busy(rejoinAt - now, false);
  }

  private holdSamples(): readonly number[] {
    const samples = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue> & { duration_ms: number }>(
        "SELECT duration_ms FROM lease_hold WHERE duration_ms >= 1 ORDER BY duration_ms ASC",
      )
      .toArray()
      .map((row) => row.duration_ms);
    return samples.length === 0 ? [DEFAULT_HOLD_MS] : samples;
  }

  private medianHoldMs(): number {
    return median(this.holdSamples());
  }

  private cursorCooldownRemainingMs(now: number): number {
    const row = this.ctx.storage.sql
      .exec<SlotRow>("SELECT * FROM slots WHERE slot_id = ?", this.readCursor())
      .one();
    if (row.state !== "cooldown" || row.cooldown_until === null) return 0;
    return Math.max(0, row.cooldown_until - now);
  }

  private callersAhead(requestId: string): number {
    const existing = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue> & { ticket: number }>(
        "SELECT ticket FROM waitlist WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];
    if (existing === undefined) {
      return this.ctx.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          "SELECT COUNT(*) AS count FROM waitlist",
        )
        .one().count;
    }
    return this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue> & { count: number }>(
        "SELECT COUNT(*) AS count FROM waitlist WHERE ticket < ?",
        existing.ticket,
      )
      .one().count;
  }

  private readLease(): LeaseRow | null {
    return (
      this.ctx.storage.sql.exec<LeaseRow>("SELECT * FROM lease WHERE singleton = 1").toArray()[0] ??
      null
    );
  }

  private readLiveReservation(now: number): ReservationRow | null {
    const row =
      this.ctx.storage.sql
        .exec<ReservationRow>("SELECT request_id, expires_at FROM reservation WHERE singleton = 1")
        .toArray()[0] ?? null;
    if (row === null || row.expires_at > now) return row;
    this.ctx.storage.sql.exec("DELETE FROM reservation WHERE singleton = 1");
    return null;
  }

  private readCursor(): SlotId {
    const row = this.ctx.storage.sql
      .exec<PoolStateRow>(
        "SELECT cursor_slot_id, updated_at FROM pool_state WHERE singleton = 1",
      )
      .one();
    return this.asPersistedSlotId(row.cursor_slot_id);
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
    const next = nextSlotId(this.readStoredSlotDefinitions(), slotId);
    this.writeCursor(this.asPersistedSlotId(next), now);
  }

  private assertStoredSlot(slotId: string): void {
    const row = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue> & { slot_id: string }>(
        "SELECT slot_id FROM slots WHERE slot_id = ?",
        slotId,
      )
      .toArray()[0];
    if (row === undefined) throw new Error("UNKNOWN_SLOT");
  }

  private readStoredSlotDefinitions(): readonly { readonly slotId: string; readonly priority: number }[] {
    const definitions = this.ctx.storage.sql
      .exec<StoredSlotDefinitionRow>("SELECT slot_id, priority FROM slots ORDER BY priority ASC")
      .toArray()
      .map(({ slot_id: slotId, priority }) => ({ slotId, priority }));
    const first = definitions[0];
    if (first === undefined) throw new Error("INVALID_SLOT_RING");
    orderSlotRing(definitions, first.slotId);
    return definitions;
  }

  private asPersistedSlotId(value: string): SlotId {
    this.assertStoredSlot(value);
    return value as SlotId;
  }

  private toSlotStatus(row: SlotRow): KeyPoolSlotStatus {
    return {
      slotId: this.asPersistedSlotId(row.slot_id),
      priority: row.priority,
      state: asSlotState(row.state),
      resetAt: row.reset_at,
      cooldownUntil: row.cooldown_until,
      lastErrorCode: row.last_error_code,
      callCount: row.call_count,
      updatedAt: row.updated_at,
    };
  }

  private toLeaseStatus(row: LeaseRow | null): KeyPoolLeaseStatus | null {
    return row === null
      ? null
      : {
          leaseId: row.lease_id,
          requestId: row.request_id,
          slotId: this.asPersistedSlotId(row.slot_id),
          expiresAt: row.expires_at,
        };
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

// Every blocker counts down at least as fast as the clock, so a refused caller that returns at its
// rejoin time fits its budget unless the line is still full behind an overdue holder.
function holderRemainingMs(lease: LeaseRow, now: number, medianMs: number): number {
  if (lease.granted_at === null) return 0;
  return Math.max(0, medianMs - (now - lease.granted_at));
}

function median(ascending: readonly number[]): number {
  const mid = Math.floor(ascending.length / 2);
  const upper = ascending[mid] ?? 0;
  if (ascending.length % 2 === 1) return upper;
  const lower = ascending[mid - 1] ?? upper;
  return Math.round((lower + upper) / 2);
}

function isKnownFutureReset(value: number | null, now: number): value is number {
  return value !== null && Number.isFinite(value) && value > now;
}

function assertTimestamp(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_TIMESTAMP");
}

function assertAcquireLeaseInputShape(input: AcquireLeaseInput): void {
  if (typeof input !== "object" || input === null) throw new Error("INVALID_ACQUIRE_INPUT");
  assertTimestamp(input.now);
  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    throw new Error("INVALID_REQUEST_ID");
  }
  if (!Array.isArray(input.attemptedSlotIds)) {
    throw new Error("INVALID_ATTEMPTED_SLOTS");
  }
  if (typeof input.deadlineAt !== "number" || !Number.isFinite(input.deadlineAt)) {
    throw new Error("INVALID_ACQUIRE_INPUT");
  }
}

function assertAttemptedSlotIds(
  attemptedSlotIds: readonly SlotId[],
  storedDefinitions: readonly { readonly slotId: string }[],
): void {
  const storedSlotIds = new Set(storedDefinitions.map(({ slotId }) => slotId));
  if (
    attemptedSlotIds.length > storedDefinitions.length ||
    attemptedSlotIds.some((slotId) => !storedSlotIds.has(slotId)) ||
    new Set(attemptedSlotIds).size !== attemptedSlotIds.length
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
