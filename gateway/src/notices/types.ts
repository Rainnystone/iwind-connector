import type { WindFailureCategory } from "../errors/types";

export interface OpsNoticeV1 {
  readonly schemaVersion: 1;
  readonly code:
    | "WIND_KEY_ROTATED"
    | "WIND_KEY_ROTATION_FAILED"
    | "KEY_POOL_EXHAUSTED"
    | "GATEWAY_BUSY"
    | "WIND_REQUEST_FAILED";
  readonly initialCategory: WindFailureCategory | null;
  readonly finalStatus: "succeeded" | "failed";
  readonly requestId: string;
}

export interface OpsNoticeTextBlock {
  readonly type: "text";
  readonly text: string;
}
