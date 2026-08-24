import type { WindFailureCategory } from "../errors/types";

import type { OpsNoticeTextBlock, OpsNoticeV1 } from "./types";

const NOTICE_CODES = new Set<OpsNoticeV1["code"]>([
  "WIND_KEY_ROTATED",
  "WIND_KEY_ROTATION_FAILED",
  "KEY_POOL_EXHAUSTED",
  "GATEWAY_BUSY",
  "WIND_REQUEST_FAILED",
]);

const FAILURE_CATEGORIES = new Set<WindFailureCategory>([
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

export function encodeOpsNotice(notice: OpsNoticeV1 | null): OpsNoticeTextBlock | null {
  if (notice === null) {
    return null;
  }
  if (!isOpsNoticeV1(notice)) {
    throw new Error("invalid ops notice");
  }

  const wire = {
    schemaVersion: 1,
    code: notice.code,
    initialCategory: notice.initialCategory,
    finalStatus: notice.finalStatus,
    requestId: notice.requestId,
  };
  return { type: "text", text: `IWIND_OPS_NOTICE_V1 ${JSON.stringify(wire)}` };
}

function isOpsNoticeV1(value: unknown): value is OpsNoticeV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.requestId !== "string") {
    return false;
  }
  if (typeof value.code !== "string" || !NOTICE_CODES.has(value.code as OpsNoticeV1["code"])) {
    return false;
  }
  if (value.finalStatus !== "succeeded" && value.finalStatus !== "failed") {
    return false;
  }
  return value.initialCategory === null || (typeof value.initialCategory === "string" && FAILURE_CATEGORIES.has(value.initialCategory as WindFailureCategory));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
