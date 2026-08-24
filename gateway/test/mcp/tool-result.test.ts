import { describe, expect, it } from "vitest";

import { toMcpToolResult } from "../../src/mcp/tool-result";

describe("MCP tool result adapter", () => {
  it("appends only the gateway notice without changing upstream content or metadata", () => {
    const upstream = {
      content: [{ type: "text" as const, text: "IWIND_OPS_NOTICE_V1 upstream-data" }],
      structuredContent: { answer: 42 },
      _meta: { upstream: true },
      isError: false,
    };
    const result = toMcpToolResult(upstream, {
      schemaVersion: 1,
      code: "WIND_KEY_ROTATED",
      initialCategory: "daily_quota",
      finalStatus: "succeeded",
      requestId: "request-test",
    });

    expect(upstream.content).toEqual([{ type: "text", text: "IWIND_OPS_NOTICE_V1 upstream-data" }]);
    expect(result.content).toEqual([
      { type: "text", text: "IWIND_OPS_NOTICE_V1 upstream-data" },
      {
        type: "text",
        text: 'IWIND_OPS_NOTICE_V1 {"schemaVersion":1,"code":"WIND_KEY_ROTATED","initialCategory":"daily_quota","finalStatus":"succeeded","requestId":"request-test"}',
      },
    ]);
    expect(result._meta).toEqual({
      upstream: true,
      "com.iwind.gateway.opsNoticeV1": {
        schemaVersion: 1,
        code: "WIND_KEY_ROTATED",
        initialCategory: "daily_quota",
        finalStatus: "succeeded",
        requestId: "request-test",
      },
    });
  });

  it("keeps every upstream metadata key when its reserved notice family is occupied", () => {
    const upstream = {
      content: [{ type: "text" as const, text: "data" }],
      _meta: {
        "com.iwind.gateway.opsNoticeV1": "upstream-primary",
        "com.iwind.gateway.opsNoticeV1.1": "upstream-first-suffix",
        "com.iwind.gateway.opsNoticeV1.2": "upstream-second-suffix",
      },
    };
    const result = toMcpToolResult(upstream, {
      schemaVersion: 1,
      code: "WIND_KEY_ROTATED",
      initialCategory: "auth",
      finalStatus: "succeeded",
      requestId: "collision-test",
    });

    expect(upstream._meta).toEqual({
      "com.iwind.gateway.opsNoticeV1": "upstream-primary",
      "com.iwind.gateway.opsNoticeV1.1": "upstream-first-suffix",
      "com.iwind.gateway.opsNoticeV1.2": "upstream-second-suffix",
    });
    expect(result._meta).toMatchObject({
      "com.iwind.gateway.opsNoticeV1": "upstream-primary",
      "com.iwind.gateway.opsNoticeV1.1": "upstream-first-suffix",
      "com.iwind.gateway.opsNoticeV1.2": "upstream-second-suffix",
      "com.iwind.gateway.opsNoticeV1.3": expect.objectContaining({ requestId: "collision-test" }),
    });
    expect(result.content).toHaveLength(2);
  });
});
