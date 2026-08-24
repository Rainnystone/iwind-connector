import type { WindFailureCategory } from "../errors/types";

interface OpsNoticeBase {
  readonly schemaVersion: 1;
  readonly initialCategory: WindFailureCategory | null;
  readonly requestId: string;
}

export type OpsNoticeV1 =
  | (OpsNoticeBase & {
      readonly code: "WIND_KEY_ROTATED";
      readonly finalStatus: "succeeded";
    })
  | (OpsNoticeBase & {
      readonly code: "WIND_KEY_ROTATION_FAILED" | "KEY_POOL_EXHAUSTED" | "GATEWAY_BUSY" | "WIND_REQUEST_FAILED";
      readonly finalStatus: "failed";
    });

export interface OpsNoticeTextBlock {
  readonly type: "text";
  readonly text: string;
}
