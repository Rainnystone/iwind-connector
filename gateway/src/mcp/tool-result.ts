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
      [availableNoticeMetaKey(upstream._meta)]: {
        schemaVersion: noticeValue.schemaVersion,
        code: noticeValue.code,
        initialCategory: noticeValue.initialCategory,
        finalStatus: noticeValue.finalStatus,
        requestId: noticeValue.requestId,
      },
    },
  };
}

function availableNoticeMetaKey(meta: CallToolResult["_meta"]): string {
  const occupied = meta ?? {};
  let suffix = 0;
  while (true) {
    const candidate = suffix === 0 ? OPS_NOTICE_META_KEY : `${OPS_NOTICE_META_KEY}.${suffix}`;
    if (!(candidate in occupied)) return candidate;
    suffix += 1;
  }
}
