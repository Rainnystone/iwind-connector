export type WindFailureCategory =
  | "daily_quota"
  | "balance"
  | "auth"
  | "qps"
  | "concurrency"
  | "network"
  | "upstream_5xx"
  | "timeout"
  | "response_too_large"
  | "unknown";

export type RetryDecision =
  | {
      readonly kind: "failover_slot";
      readonly disableAs: "exhausted_until_reset" | "disabled_balance" | "disabled_auth";
    }
  | { readonly kind: "retry_same_slot"; readonly delayMs: number; readonly maxRetries: 1 }
  | { readonly kind: "stop" };

export interface ClassifiedFailure {
  readonly category: WindFailureCategory;
  readonly stableCode: string;
  readonly decision: RetryDecision;
  readonly resetAt: number | null;
}

export interface WindFailureInput {
  readonly status?: number;
  readonly headers?: Headers | Readonly<Record<string, string | undefined>>;
  readonly body?: string | Uint8Array;
  readonly error?: unknown;
  readonly now?: number;
}
