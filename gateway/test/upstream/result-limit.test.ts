import type { CallToolResult, FetchLike } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { createAuthorizedFetch } from "../../src/upstream/authorized-fetch";
import { classifyWindFailure } from "../../src/errors/classifier";
import {
  createWindToolCaller,
  WindCallFailure,
  type McpToolAttempt,
} from "../../src/upstream/call-tool";
import {
  MAX_ERROR_ENVELOPE_BYTES,
  ResponseTooLargeError,
  createResponseRecorder,
  limitResponseBody,
} from "../../src/upstream/result-limit";
import { getUpstream } from "../../src/config/upstreams";

const MAX_BYTES = 8_388_608;
const SECRET = "transport-secret-sentinel";
const RESULT: CallToolResult = {
  content: [{ type: "text", text: "ok" }],
  structuredContent: { answer: 42 },
  isError: false,
  _meta: { preserved: true },
};

describe("bounded Wind response streams", () => {
  it("passes an exact 8 MiB chunked response without eagerly draining the source", async () => {
    const chunks = [
      new Uint8Array(2_000_000),
      new Uint8Array(2_000_000),
      new Uint8Array(2_000_000),
      new Uint8Array(MAX_BYTES - 6_000_000),
    ];
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[pulls];
          pulls += 1;
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
      }),
      { status: 200 },
    );
    const recorder = createResponseRecorder();

    const limited = limitResponseBody(response, MAX_BYTES, recorder);
    await Promise.resolve();
    expect(pulls).toBeLessThanOrEqual(1);
    const reader = limited.body?.getReader();
    if (reader === undefined) throw new Error("fixture body missing");
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(pulls).toBeLessThanOrEqual(2);
    await reader.cancel();

    const completeResponse = limitResponseBody(
      new Response(streamOf(new Uint8Array(MAX_BYTES)), { status: 200 }),
      MAX_BYTES,
      createResponseRecorder(),
    );
    await expect(completeResponse.arrayBuffer()).resolves.toHaveProperty(
      "byteLength",
      MAX_BYTES,
    );
  });

  it("cancels the upstream reader and throws a typed error at 8 MiB plus one byte", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
    const recorder = createResponseRecorder();

    const limited = limitResponseBody(response, MAX_BYTES, recorder);

    await expect(limited.arrayBuffer()).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled).toBe(true);
    expect(recorder.snapshot()).toMatchObject({
      responseBytes: MAX_BYTES + 1,
      responseTooLarge: true,
    });
  });

  it("bounds a non-2xx error envelope at 16 KiB while preserving status and headers", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_ERROR_ENVELOPE_BYTES));
          controller.enqueue(new Uint8Array(10));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 429, headers: { "Retry-After": "2" } },
    );
    const recorder = createResponseRecorder();

    const limited = limitResponseBody(response, MAX_BYTES, recorder);

    await expect(limited.arrayBuffer()).resolves.toHaveProperty(
      "byteLength",
      MAX_ERROR_ENVELOPE_BYTES,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2");
    expect(cancelled).toBe(true);
    expect(recorder.snapshot()).toMatchObject({
      status: 429,
      errorEnvelopeTruncated: true,
      responseBytes: MAX_ERROR_ENVELOPE_BYTES + 10,
    });
    expect(recorder.snapshot().errorBody?.byteLength).toBe(MAX_ERROR_ENVELOPE_BYTES);
  });

  it("accepts an exact 16 KiB structured error envelope without marking it truncated", async () => {
    const body = exactSizedAuthEnvelope();
    const recorder = createResponseRecorder();

    const limited = limitResponseBody(
      new Response(streamOf(new TextEncoder().encode(body)), { status: 401 }),
      MAX_BYTES,
      recorder,
    );

    await expect(limited.text()).resolves.toBe(body);
    expect(recorder.snapshot()).toMatchObject({
      errorEnvelopeTruncated: false,
      responseBytes: MAX_ERROR_ENVELOPE_BYTES,
    });
  });

  it("forces a 16 KiB plus one structured error envelope to response_too_large", async () => {
    const body = `${exactSizedAuthEnvelope()} `;
    const caller = createWindToolCaller({
      baseFetch: async () =>
        new Response(streamOf(new TextEncoder().encode(body)), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });

    const failure = await caller
      .call({
        upstream: getUpstream("stock_data"),
        toolName: "get_stock_quote",
        arguments: {},
        apiKey: SECRET,
        timeoutMs: 600_000,
        maxResponseBytes: MAX_BYTES,
      })
      .then(
        () => {
          throw new Error("expected bounded error-envelope failure");
        },
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(WindCallFailure);
    if (!(failure instanceof WindCallFailure)) throw new Error("unexpected failure shape");
    expect(failure.forcedCategory).toBe("response_too_large");
  });
});

describe("authorized bounded fetch", () => {
  it("overwrites Authorization, preserves safe headers and the caller signal, and never logs the key", async () => {
    let receivedHeaders = new Headers();
    let receivedSignal: AbortSignal | null | undefined;
    const baseFetch: FetchLike = vi.fn(async (_url, init) => {
      receivedHeaders = new Headers(init?.headers);
      receivedSignal = init?.signal;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const controller = new AbortController();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = createAuthorizedFetch({
      apiKey: SECRET,
      baseFetch,
      maxResponseBytes: MAX_BYTES,
      recorder: createResponseRecorder(),
    });

    const response = await fetcher("https://example.test/mcp", {
      headers: {
        Authorization: "Bearer stale",
        Accept: "application/json",
        "Mcp-Session-Id": "safe-session",
      },
      signal: controller.signal,
    });
    await response.text();

    expect(receivedHeaders.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect([...receivedHeaders.keys()].filter((name) => name === "authorization")).toHaveLength(1);
    expect(receivedHeaders.get("accept")).toBe("application/json");
    expect(receivedHeaders.get("mcp-session-id")).toBe("safe-session");
    expect(receivedSignal).toBe(controller.signal);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("returns non-2xx responses to the SDK instead of preempting version negotiation", async () => {
    const fetcher = createAuthorizedFetch({
      apiKey: SECRET,
      baseFetch: async () => new Response("legacy", { status: 404 }),
      maxResponseBytes: MAX_BYTES,
      recorder: createResponseRecorder(),
    });

    const response = await fetcher("https://example.test/mcp");

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("legacy");
  });
});

describe("MCP v2 call lifecycle", () => {
  it("applies a 600 second total bound and AbortSignal to both connect and call, then closes", async () => {
    const attempt = fakeAttempt();
    const caller = createWindToolCaller({ createAttempt: () => attempt });

    const result = await caller.call({
      upstream: getUpstream("stock_data"),
      toolName: "get_stock_quote",
      arguments: { windcode: "600519.SH" },
      apiKey: SECRET,
      timeoutMs: 600_000,
      maxResponseBytes: MAX_BYTES,
    });

    expect(result).toBe(RESULT);
    expect(attempt.connectOptions).toMatchObject({
      timeout: 600_000,
      maxTotalTimeout: 600_000,
    });
    expect(attempt.connectOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(attempt.callOptions).toMatchObject({
      timeout: 600_000,
      maxTotalTimeout: 600_000,
    });
    expect(attempt.callOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(attempt.callOptions?.signal).toBe(attempt.connectOptions?.signal);
    expect(attempt.closeCount).toBe(1);
  });

  it.each(["connect", "call", "fetch"] as const)(
    "closes the MCP client on a %s failure",
    async (phase) => {
      const failure = new TypeError(`synthetic ${phase} failure`);
      const attempt = fakeAttempt({
        connectError: phase === "connect" ? failure : undefined,
        callError: phase === "call" || phase === "fetch" ? failure : undefined,
      });
      const caller = createWindToolCaller({ createAttempt: () => attempt });

      await expect(
        caller.call({
          upstream: getUpstream("stock_data"),
          toolName: "get_stock_quote",
          arguments: {},
          apiKey: SECRET,
          timeoutMs: 600_000,
          maxResponseBytes: MAX_BYTES,
        }),
      ).rejects.toThrow("WIND_CALL_FAILED");
      expect(attempt.closeCount).toBe(1);
    },
  );

  it("projects an SDK/AbortSignal timeout into the exact timeout classifier path", async () => {
    const timeout = new Error("synthetic timeout");
    timeout.name = "AbortError";
    const caller = createWindToolCaller({
      createAttempt: () => fakeAttempt({ callError: timeout }),
    });

    const failure = await caller
      .call({
        upstream: getUpstream("stock_data"),
        toolName: "get_stock_quote",
        arguments: {},
        apiKey: SECRET,
        timeoutMs: 600_000,
        maxResponseBytes: MAX_BYTES,
      })
      .then(
        () => {
          throw new Error("expected timeout failure");
        },
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(WindCallFailure);
    if (!(failure instanceof WindCallFailure)) throw new Error("unexpected timeout shape");
    expect(classifyWindFailure(failure.classificationInput).category).toBe("timeout");
  });

  it("preserves success when close rejects and observes the close failure without its value", async () => {
    const onCloseError = vi.fn<() => void>();
    const caller = createWindToolCaller({
      createAttempt: () => fakeAttempt({ closeError: new Error("close-secret") }),
      onCloseError,
    });

    const result = await caller.call(toolCallInput());

    expect(result).toBe(RESULT);
    expect(onCloseError).toHaveBeenCalledOnce();
    expect(onCloseError.mock.calls[0]).toHaveLength(0);
  });

  it.each([
    ["network", new TypeError("primary network"), "network"],
    ["timeout", namedError("AbortError"), "timeout"],
    [
      "response-too-large",
      new ResponseTooLargeError(MAX_BYTES, MAX_BYTES + 1),
      "response_too_large",
    ],
  ] as const)(
    "preserves a primary %s failure when close also rejects",
    async (_name, primaryError, category) => {
      const onCloseError = vi.fn<() => void>();
      const caller = createWindToolCaller({
        createAttempt: () =>
          fakeAttempt({ callError: primaryError, closeError: new Error("close-secret") }),
        onCloseError,
      });

      const failure = await caller.call(toolCallInput()).then(
        () => {
          throw new Error("expected primary failure");
        },
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(WindCallFailure);
      if (!(failure instanceof WindCallFailure)) throw new Error("unexpected failure shape");
      const actualCategory =
        failure.forcedCategory ?? classifyWindFailure(failure.classificationInput).category;
      expect(actualCategory).toBe(category);
      expect(onCloseError).toHaveBeenCalledOnce();
      expect(onCloseError.mock.calls[0]).toHaveLength(0);
    },
  );

  it("lets MCP v2 auto negotiation consume a legacy 404 probe and complete the tool call", async () => {
    const methods: string[] = [];
    const responseBytes: number[] = [];
    let toolResponseBytes = 0;
    const baseFetch: FetchLike = async (_url, init) => {
      const message: unknown = JSON.parse(String(init?.body));
      if (!isRecord(message) || typeof message.method !== "string") {
        return new Response(null, { status: 202 });
      }
      methods.push(message.method);
      if (message.method === "server/discover") {
        return new Response("legacy endpoint", { status: 404 });
      }
      if (message.method === "initialize") {
        return jsonRpc(message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        });
      }
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "tools/call") {
        const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: RESULT });
        toolResponseBytes = new TextEncoder().encode(body).byteLength;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const caller = createWindToolCaller({
      baseFetch,
      onResponseBytes: (bytes) => responseBytes.push(bytes),
    });

    const result = await caller.call({
      upstream: getUpstream("stock_data"),
      toolName: "get_stock_quote",
      arguments: {},
      apiKey: SECRET,
      timeoutMs: 600_000,
      maxResponseBytes: MAX_BYTES,
    });

    expect(result).toEqual(RESULT);
    expect(methods).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(responseBytes).toEqual([toolResponseBytes]);
  });

  it("retains a bounded exact structured envelope when MCP v2 rejects an HTTP auth response", async () => {
    const baseFetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: { code: "AUTH_ERROR" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const caller = createWindToolCaller({ baseFetch });

    const failure = await caller
      .call({
        upstream: getUpstream("stock_data"),
        toolName: "get_stock_quote",
        arguments: {},
        apiKey: SECRET,
        timeoutMs: 600_000,
        maxResponseBytes: MAX_BYTES,
      })
      .then(
        () => {
          throw new Error("expected Wind call failure");
        },
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(WindCallFailure);
    if (!(failure instanceof WindCallFailure)) throw new Error("unexpected failure shape");
    const classified = classifyWindFailure(failure.classificationInput);
    expect(classified.category).toBe("auth");
  });
});

interface FakeAttempt extends McpToolAttempt {
  connectOptions?: Parameters<McpToolAttempt["connect"]>[0];
  callOptions?: Parameters<McpToolAttempt["callTool"]>[2];
  closeCount: number;
}

function fakeAttempt(
  options: { connectError?: Error; callError?: Error; closeError?: Error } = {},
): FakeAttempt {
  return {
    closeCount: 0,
    async connect(requestOptions) {
      this.connectOptions = requestOptions;
      if (options.connectError) throw options.connectError;
    },
    async callTool(_name, _arguments, requestOptions) {
      this.callOptions = requestOptions;
      if (options.callError) throw options.callError;
      return RESULT;
    },
    async close() {
      this.closeCount += 1;
      if (options.closeError) throw options.closeError;
    },
  };
}

function toolCallInput() {
  return {
    upstream: getUpstream("stock_data"),
    toolName: "get_stock_quote",
    arguments: {},
    apiKey: SECRET,
    timeoutMs: 600_000 as const,
    maxResponseBytes: MAX_BYTES as 8_388_608,
  };
}

function namedError(name: string): Error {
  const error = new Error(`synthetic ${name}`);
  error.name = name;
  return error;
}

function streamOf(chunk: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

function exactSizedAuthEnvelope(): string {
  const prefix = '{"error":{"code":"AUTH_ERROR"},"padding":"';
  const suffix = '"}';
  const paddingBytes = MAX_ERROR_ENVELOPE_BYTES - prefix.length - suffix.length;
  const body = `${prefix}${"x".repeat(paddingBytes)}${suffix}`;
  if (new TextEncoder().encode(body).byteLength !== MAX_ERROR_ENVELOPE_BYTES) {
    throw new Error("invalid exact error-envelope fixture");
  }
  return body;
}

function jsonRpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
