import type { WindFailureCategory } from "../errors/types";
import { isSlotId } from "../key-pool/slots";
import type { PendingTestOutcome } from "../key-pool/types";

const ALLOWED_CATEGORIES = new Set<WindFailureCategory>([
  "daily_quota",
  "balance",
  "auth",
  "qps",
  "concurrency",
  "network",
  "upstream_5xx",
  "timeout",
  "response_too_large",
  "unknown",
]);

export function parseTestControl(value: unknown): PendingTestOutcome | null {
  if (!isRecord(value) || !hasExactKeys(value, ["slotId", "category", "times"])) return null;
  if (!isSlotId(value.slotId) || !isFailureCategory(value.category) || value.times !== 1) return null;
  return { slotId: value.slotId, category: value.category };
}

function isFailureCategory(value: unknown): value is WindFailureCategory {
  return typeof value === "string" && ALLOWED_CATEGORIES.has(value as WindFailureCategory);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
