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

  it("drops runtime extra properties from a structurally assignable event object", () => {
    const output: string[] = [];
    const taintedEvent = {
      requestId: "request-03",
      domain: "stock_data" as const,
      toolName: "get_stock_quote",
      slotId: "key-01" as const,
      status: "lease_repair_required",
      durationMs: 13,
      responseBytes: null,
      noticeCode: "WIND_REQUEST_FAILED" as const,
      arguments: ARGUMENT_SENTINEL,
      Authorization: SECRET_SENTINEL,
      key: SECRET_SENTINEL,
      result: RESULT_SENTINEL,
      errorBody: "error-body-must-never-appear",
    };

    emitLogEvent(taintedEvent, (line) => output.push(line));

    const parsed: unknown = JSON.parse(output[0] ?? "");
    expect(parsed).toEqual({
      requestId: "request-03",
      domain: "stock_data",
      toolName: "get_stock_quote",
      slotId: "key-01",
      status: "lease_repair_required",
      durationMs: 13,
      responseBytes: null,
      noticeCode: "WIND_REQUEST_FAILED",
    });
    const serialized = output.join("\n");
    expect(serialized).not.toContain(ARGUMENT_SENTINEL);
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toContain(RESULT_SENTINEL);
    expect(serialized).not.toContain("error-body-must-never-appear");
  });
});
