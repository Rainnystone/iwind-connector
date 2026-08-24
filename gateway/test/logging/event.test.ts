import { describe, expect, it, vi } from "vitest";

import { emitLogEvent, type GatewayLogEvent } from "../../src/logging/event";

const SECRET_SENTINEL = "secret-value-must-never-appear";
const ARGUMENT_SENTINEL = "argument-value-must-never-appear";
const RESULT_SENTINEL = "result-value-must-never-appear";

describe("gateway structured logs", () => {
  it("serializes only the approved metadata fields", () => {
    const output: string[] = [];
    const event: GatewayLogEvent = {
      requestId: "request-01",
      domain: "stock_data",
      toolName: "get_stock_quote",
      slotId: "key-01",
      status: "success",
      durationMs: 12,
      responseBytes: 128,
      noticeCode: null,
    };

    emitLogEvent(event, (line) => output.push(line));

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "")).toEqual(event);
    const serialized = output.join("\n");
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toContain(ARGUMENT_SENTINEL);
    expect(serialized).not.toContain(RESULT_SENTINEL);
    expect(Object.keys(event).sort()).toEqual([
      "domain",
      "durationMs",
      "noticeCode",
      "requestId",
      "responseBytes",
      "slotId",
      "status",
      "toolName",
    ]);
  });

  it("uses one structured console call without expanding arbitrary error objects", () => {
    const sink = vi.fn<(line: string) => void>();
    const event: GatewayLogEvent = {
      requestId: "request-02",
      domain: "unknown",
      toolName: "not-a-tool",
      slotId: null,
      status: "WIND_UNKNOWN",
      durationMs: 0,
      responseBytes: null,
      noticeCode: "WIND_REQUEST_FAILED",
    };

    emitLogEvent(event, sink);

    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]).toHaveLength(1);
    expect(() => JSON.parse(sink.mock.calls[0]?.[0] ?? "")).not.toThrow();
  });
});
