import type { CallToolResult } from "@modelcontextprotocol/client";

import { encodeOpsNotice } from "../notices/encode";
import type { OpsNoticeV1 } from "../notices/types";

export const OPS_NOTICE_META_KEY = "com.iwind.gateway.opsNoticeV1";

export function toMcpToolResult(
  upstream: CallToolResult,
  notice: OpsNoticeV1 | null,
): CallToolResult {
  const encoded = encodeOpsNotice(notice);
  if (encoded === null || notice === null) return { ...upstream, content: [...upstream.content] };
  const noticeValue = notice;

  return {
    ...upstream,
    content: [...upstream.content, encoded],
    _meta: {
      ...(upstream._meta ?? {}),
      [OPS_NOTICE_META_KEY]: {
        schemaVersion: noticeValue.schemaVersion,
        code: noticeValue.code,
        initialCategory: noticeValue.initialCategory,
        finalStatus: noticeValue.finalStatus,
        requestId: noticeValue.requestId,
      },
    },
  };
}
