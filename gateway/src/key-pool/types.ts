import type { WindFailureCategory } from "../errors/types";

export type SlotId = "key-01" | "key-02";

export type SlotState =
  | "active"
  | "exhausted_until_reset"
  | "disabled_balance"
  | "disabled_auth"
  | "disabled_manual"
  | "cooldown";

export type AcquireLeaseResult =
  | {
      readonly ok: true;
      readonly leaseId: string;
      readonly slotId: SlotId;
      readonly expiresAt: number;
    }
  | {
      readonly ok: false;
      readonly code: "GATEWAY_BUSY" | "KEY_POOL_EXHAUSTED";
      readonly retryAfterMs: number | null;
    };

export interface ReportOutcomeInput {
  readonly leaseId: string;
  readonly slotId: SlotId;
  readonly category: WindFailureCategory | "success";
  readonly resetAt: number | null;
  readonly occurredAt: number;
}

export interface KeyPoolSlotStatus {
  readonly slotId: SlotId;
  readonly priority: number;
  readonly state: SlotState;
  readonly resetAt: number | null;
  readonly cooldownUntil: number | null;
  readonly lastErrorCode: string | null;
  readonly callCount: number;
  readonly updatedAt: number;
}

export interface KeyPoolLeaseStatus {
  readonly leaseId: string;
  readonly requestId: string;
  readonly slotId: SlotId;
  readonly expiresAt: number;
}

export interface KeyPoolStatus {
  readonly slots: readonly KeyPoolSlotStatus[];
  readonly lease: KeyPoolLeaseStatus | null;
}

export interface PendingTestOutcome {
  readonly slotId: SlotId;
  readonly category: WindFailureCategory;
}
