import { describe, expect, it, vi } from "vitest";

import { getUpstream } from "../../src/config/upstreams";
import { createAuthorizedFetch } from "../../src/upstream/authorized-fetch";
import { createResponseRecorder } from "../../src/upstream/result-limit";
import {
  createWindSessionFactory,
  withWindSession,
  type McpClientAdapter,
} from "../../src/upstream/session";

const SECRET_SENTINEL = "key-that-must-never-be-logged";

describe("Wind MCP session", () => {
  it("overwrites caller Authorization and sends exactly one Bearer header without logging the key", async () => {
    let receivedHeaders = new Headers();
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const authorizedFetch = createAuthorizedFetch({
      apiKey: SECRET_SENTINEL,
      baseFetch,
      maxResponseBytes: 8_388_608,
      recorder: createResponseRecorder(),
    });

    await authorizedFetch("https://example.test/mcp", {
      headers: [
        ["Authorization", "Bearer stale"],
        ["Accept", "application/json"],
      ],
    });

    expect(receivedHeaders.get("authorization")).toBe(`Bearer ${SECRET_SENTINEL}`);
    expect([...receivedHeaders.keys()].filter((name) => name === "authorization")).toHaveLength(1);
    expect(receivedHeaders.get("accept")).toBe("application/json");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("closes the MCP client when connection fails", async () => {
    const adapter = fakeAdapter({ connectError: new Error("connect failed") });
    const factory = createWindSessionFactory(() => adapter);

    await expect(factory.connect(getUpstream("stock_data"), SECRET_SENTINEL)).rejects.toThrow(
      "connect failed",
    );
    expect(adapter.close).toHaveBeenCalledOnce();
  });

  it("closes the MCP client in finally when a tool call fails", async () => {
    const adapter = fakeAdapter({ callError: new Error("tool failed") });
    const factory = createWindSessionFactory(() => adapter);

    await expect(
      withWindSession(factory, getUpstream("stock_data"), SECRET_SENTINEL, (session) =>
        session.callTool("get_stock_quote", { windcode: "600519.SH" }),
      ),
    ).rejects.toThrow("tool failed");
    expect(adapter.close).toHaveBeenCalledOnce();
  });
});

function fakeAdapter(options: { connectError?: Error; callError?: Error }): McpClientAdapter & {
  close: ReturnType<typeof vi.fn>;
} {
  return {
    declaredWritableToolNames: [],
    connect: vi.fn(async () => {
      if (options.connectError) throw options.connectError;
    }),
    listTools: vi.fn(async () => []),
    listResources: vi.fn(async () => []),
    listPrompts: vi.fn(async () => []),
    callTool: vi.fn(async () => {
      if (options.callError) throw options.callError;
      return {};
    }),
    close: vi.fn(async () => undefined),
    getServerInfo: vi.fn(() => ({ name: "fixture", version: "1" })),
    getServerCapabilities: vi.fn(() => ({ tools: {} })),
  };
}
