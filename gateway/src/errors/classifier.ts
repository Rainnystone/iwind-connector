import rulesJson from "./wind-signal-rules.json";

import type {
  ClassifiedFailure,
  RetryDecision,
  WindFailureCategory,
  WindFailureInput,
} from "./types";

const MAX_ERROR_ENVELOPE_BYTES = 16 * 1024;
const STOP: RetryDecision = { kind: "stop" };
const RETRY_ONCE_500: RetryDecision = { kind: "retry_same_slot", delayMs: 500, maxRetries: 1 };
const RETRY_ONCE_3000: RetryDecision = { kind: "retry_same_slot", delayMs: 3000, maxRetries: 1 };

type RuleEvidence = "live_fixture" | "vendor_structured_contract";

interface SignalRule {
  readonly code: string;
  readonly category: WindFailureCategory;
  readonly stableCode: string;
  readonly evidence: RuleEvidence;
}

interface WindSignalRules {
  readonly schemaVersion: 1;
  readonly codeFieldPath: readonly ["error", "code"];
  readonly resetFieldPath: readonly ["error", "reset_at"];
  readonly rules: readonly SignalRule[];
}

const FAILOVER_DECISIONS: Readonly<
  Partial<Record<WindFailureCategory, Extract<RetryDecision, { readonly kind: "failover_slot" }>>>
> = {
  daily_quota: { kind: "failover_slot", disableAs: "exhausted_until_reset" },
  balance: { kind: "failover_slot", disableAs: "disabled_balance" },
  auth: { kind: "failover_slot", disableAs: "disabled_auth" },
};

const RETRY_CODES: Readonly<Record<Exclude<WindFailureCategory, "daily_quota" | "balance" | "auth" | "unknown" | "response_too_large">, string>> = {
  qps: "WIND_QPS",
  concurrency: "WIND_CONCURRENCY",
  network: "WIND_NETWORK",
  upstream_5xx: "WIND_UPSTREAM_5XX",
  timeout: "WIND_TIMEOUT",
};

const SIGNAL_RULES = validateWindSignalRules(rulesJson);

export function classifyWindFailure(input: WindFailureInput): ClassifiedFailure {
  const now = input.now ?? Date.now();
  const envelope = readBoundedEnvelope(input.body);

  if (envelope.kind === "too_large") {
    return failure("response_too_large", "WIND_RESPONSE_TOO_LARGE", STOP);
  }

  if (envelope.kind === "structured") {
    const rule = SIGNAL_RULES.rules.find((candidate) => candidate.code === envelope.code);
    if (rule !== undefined) {
      return structuredFailure(rule, envelope.resetAt, now, input.headers);
    }
  }

  if (input.status === 429) {
    return failure("qps", RETRY_CODES.qps, retryAfterDecision(input.headers, now));
  }

  if (input.status !== undefined && input.status >= 500 && input.status <= 599) {
    return failure("upstream_5xx", RETRY_CODES.upstream_5xx, RETRY_ONCE_500);
  }

  if (isAbortError(input.error)) {
    return failure("timeout", RETRY_CODES.timeout, RETRY_ONCE_500);
  }

  if (isErrorLike(input.error)) {
    return failure("network", RETRY_CODES.network, RETRY_ONCE_500);
  }

  return failure("unknown", "WIND_UNKNOWN", STOP);
}

export function validateWindSignalRules(value: unknown): WindSignalRules {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isExactPath(value.codeFieldPath, ["error", "code"]) || !isExactPath(value.resetFieldPath, ["error", "reset_at"]) || !Array.isArray(value.rules)) {
    throw new Error("invalid Wind signal rules");
  }

  const rules = value.rules.map((rule): SignalRule => {
    if (!isRecord(rule) || typeof rule.code !== "string" || !isCategory(rule.category) || typeof rule.stableCode !== "string" || !isRuleEvidence(rule.evidence)) {
      throw new Error("invalid Wind signal rules");
    }
    return {
      code: rule.code,
      category: rule.category,
      stableCode: rule.stableCode,
      evidence: rule.evidence,
    };
  });

  if (new Set(rules.map((rule) => rule.code)).size !== rules.length) {
    throw new Error("invalid Wind signal rules");
  }

  return { schemaVersion: 1, codeFieldPath: ["error", "code"], resetFieldPath: ["error", "reset_at"], rules };
}

function structuredFailure(
  rule: SignalRule,
  structuredResetAt: unknown,
  now: number,
  headers: WindFailureInput["headers"],
): ClassifiedFailure {
  const decision = FAILOVER_DECISIONS[rule.category];
  if (decision !== undefined) {
    return failure(rule.category, rule.stableCode, decision, parseFutureEpoch(structuredResetAt, now) ?? parseFutureHttpDate(header(headers, "x-ratelimit-reset"), now));
  }

  if (rule.category === "qps") {
    return failure(rule.category, rule.stableCode, retryAfterDecision(headers, now));
  }

  if (rule.category === "concurrency") {
    return failure(rule.category, rule.stableCode, RETRY_ONCE_3000);
  }

  return failure("unknown", "WIND_UNKNOWN", STOP);
}

function readBoundedEnvelope(body: WindFailureInput["body"]):
  | { readonly kind: "absent" }
  | { readonly kind: "too_large" }
  | { readonly kind: "malformed" }
  | { readonly kind: "structured"; readonly code: string; readonly resetAt: unknown } {
  if (body === undefined) {
    return { kind: "absent" };
  }

  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength > MAX_ERROR_ENVELOPE_BYTES) {
    return { kind: "too_large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { kind: "malformed" };
  }

  if (!isRecord(parsed) || !isRecord(parsed.error) || typeof parsed.error.code !== "string") {
    return { kind: "malformed" };
  }

  return { kind: "structured", code: parsed.error.code, resetAt: parsed.error.reset_at };
}

function retryAfterDecision(headers: WindFailureInput["headers"], now: number): RetryDecision {
  const retryAfter = header(headers, "retry-after");
  const delayMs = parseRetryAfter(retryAfter, now);
  return { kind: "retry_same_slot", delayMs: delayMs ?? 3000, maxRetries: 1 };
}

function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (value === undefined) {
    return null;
  }

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return inRetryRange(Number(value) * 1000) ? Number(value) * 1000 : null;
  }

  const parsed = Date.parse(value);
  const delay = parsed - now;
  return Number.isFinite(parsed) && inRetryRange(delay) ? delay : null;
}

function parseFutureEpoch(value: unknown, now: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const epochMs = value < 100_000_000_000 ? value * 1000 : value;
  return epochMs > now ? epochMs : null;
}

function parseFutureHttpDate(value: string | undefined, now: number): number | null {
  if (value === undefined || !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

function header(headers: WindFailureInput["headers"], name: string): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function failure(category: WindFailureCategory, stableCode: string, decision: RetryDecision, resetAt: number | null = null): ClassifiedFailure {
  return { category, stableCode, decision, resetAt };
}

function isExactPath(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function isCategory(value: unknown): value is WindFailureCategory {
  return value === "daily_quota" || value === "balance" || value === "auth" || value === "qps" || value === "concurrency" || value === "network" || value === "upstream_5xx" || value === "timeout" || value === "response_too_large" || value === "unknown";
}

function isRuleEvidence(value: unknown): value is RuleEvidence {
  return value === "live_fixture" || value === "vendor_structured_contract";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(value: unknown): boolean {
  return isRecord(value) && value.name === "AbortError";
}

function isErrorLike(value: unknown): boolean {
  return value instanceof Error;
}

function inRetryRange(delayMs: number): boolean {
  return Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 5000;
}
