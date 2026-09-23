import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ConnectOptions,
  type FetchLike,
  type RequestOptions,
} from "@modelcontextprotocol/client";

import { isStatusOnlyQuotaStatus } from "../errors/classifier";
import type { WindFailureInput } from "../errors/types";
import type { WindToolCaller } from "../invocation/types";

import { createAuthorizedFetch } from "./authorized-fetch";
import {
  MAX_ERROR_ENVELOPE_BYTES,
  ResponseTooLargeError,
  createResponseRecorder,
  type ResponseRecord,
  type ResponseRecorder,
} from "./result-limit";

type BoundedRequestOptions = Required<Pick<RequestOptions, "timeout" | "maxTotalTimeout" | "signal">>;

export interface McpToolAttempt {
  connect(options: BoundedRequestOptions): Promise<void>;
  callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options: BoundedRequestOptions,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface McpToolAttemptFactoryInput {
  readonly upstreamUrl: URL;
  readonly apiKey: string;
  readonly maxResponseBytes: number;
  readonly recorder: ResponseRecorder;
  readonly baseFetch?: FetchLike;
}

export type McpToolAttemptFactory = (input: McpToolAttemptFactoryInput) => McpToolAttempt;

export interface WindToolCallerOptions {
  readonly createAttempt?: McpToolAttemptFactory;
  readonly baseFetch?: FetchLike;
  readonly onResponseBytes?: (bytes: number) => void;
  readonly onCloseError?: () => void;
}

export class WindCallFailure extends Error {
  constructor(
    readonly classificationInput: WindFailureInput,
    readonly responseBytes: number | null = null,
    readonly forcedCategory: "response_too_large" | null = null,
  ) {
    super("WIND_CALL_FAILED");
    this.name = "WindCallFailure";
  }
}

export function createWindToolCaller(options: WindToolCallerOptions = {}): WindToolCaller {
  const createAttempt = options.createAttempt ?? createSdkAttempt;
  return {
    async call(input) {
      const recorder = createResponseRecorder();
      const attempt = createAttempt({
        upstreamUrl: input.upstream.url,
        apiKey: input.apiKey,
        maxResponseBytes: input.maxResponseBytes,
        recorder,
        ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
      });

      try {
        const attemptSignal = AbortSignal.timeout(input.timeoutMs);
        const connectOptions = boundedOptions(input.timeoutMs, attemptSignal);
        await attempt.connect(connectOptions);
        const callOptions = boundedOptions(input.timeoutMs, attemptSignal);
        const result = await attempt.callTool(input.toolName, input.arguments, callOptions);
        safeRecordResponseBytes(options.onResponseBytes, recorder.snapshot().responseBytes);
        return result;
      } catch (error) {
        const record = recorder.snapshot();
        safeRecordResponseBytes(options.onResponseBytes, record.responseBytes);
        throw toWindCallFailure(error, record);
      } finally {
        try {
          await attempt.close();
        } catch {
          safeObserveCloseError(options.onCloseError);
        }
      }
    },
  };
}

function safeObserveCloseError(observer: WindToolCallerOptions["onCloseError"]): void {
  try {
    observer?.();
  } catch {
    // Cleanup observations must not change the primary Wind request outcome.
  }
}

function createSdkAttempt(input: McpToolAttemptFactoryInput): McpToolAttempt {
  const client = new Client(
    { name: "iwind-gateway", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(input.upstreamUrl, {
    fetch: createAuthorizedFetch({
      apiKey: input.apiKey,
      maxResponseBytes: input.maxResponseBytes,
      recorder: input.recorder,
      ...(input.baseFetch === undefined ? {} : { baseFetch: input.baseFetch }),
    }),
  });

  return {
    connect: (options) => client.connect(transport, options satisfies ConnectOptions),
    callTool: (name, arguments_, options) =>
      client.callTool({ name, arguments: { ...arguments_ } }, options),
    close: () => client.close(),
  };
}

function boundedOptions(timeoutMs: number, signal: AbortSignal): BoundedRequestOptions {
  return {
    timeout: timeoutMs,
    maxTotalTimeout: timeoutMs,
    signal,
  };
}

function toWindCallFailure(error: unknown, record: ResponseRecord): WindCallFailure {
  if (error instanceof WindCallFailure) return error;
  // Status-only 401/403 is classified even when the HTML page exceeds the envelope.
  // Dropping that body keeps the page from being filed as response_too_large.
  const rejectedStatus = error instanceof SdkHttpError ? error.status : record.status;
  if (isStatusOnlyQuotaStatus(rejectedStatus)) {
    const boundedBody = record.errorEnvelopeTruncated || record.errorBody === undefined ? {} : { body: record.errorBody };
    return new WindCallFailure({ status: rejectedStatus, headers: record.headers, ...boundedBody }, record.responseBytes);
  }
  if (record.errorEnvelopeTruncated) {
    return new WindCallFailure({}, record.responseBytes, "response_too_large");
  }
  if (error instanceof ResponseTooLargeError || record.responseTooLarge) {
    return new WindCallFailure({}, record.responseBytes, "response_too_large");
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return timeoutFailure(record.responseBytes);
  }
  if (isTimeoutError(error)) {
    return timeoutFailure(record.responseBytes);
  }
  const httpStatus = error instanceof SdkHttpError ? error.status : record.status;
  if (typeof httpStatus === "number" && httpStatus >= 200 && httpStatus < 300) {
    return new WindCallFailure(
      {
        status: httpStatus,
        headers: record.headers,
        ...retainedStructuredBody(record.errorBody),
      },
      record.responseBytes,
    );
  }
  if (error instanceof SdkHttpError || (record.status !== null && (record.status < 200 || record.status >= 300))) {
    const status = error instanceof SdkHttpError ? error.status : record.status;
    if (status === null) return new WindCallFailure({}, record.responseBytes);
    return new WindCallFailure(
      {
        status,
        headers: record.headers,
        ...(record.errorBody === undefined ? {} : { body: record.errorBody }),
      },
      record.responseBytes,
    );
  }
  if (error instanceof TypeError) {
    return new WindCallFailure({ error }, record.responseBytes);
  }
  return new WindCallFailure({}, record.responseBytes);
}

function retainedStructuredBody(
  body: Uint8Array | undefined,
): { readonly body: Uint8Array } | undefined {
  if (body === undefined || body.byteLength === 0 || body.byteLength > MAX_ERROR_ENVELOPE_BYTES) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
    if (!isRecord(parsed) || !isRecord(parsed.error) || typeof parsed.error.code !== "string") {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { body };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRecordResponseBytes(
  recorder: WindToolCallerOptions["onResponseBytes"],
  bytes: number,
): void {
  try {
    recorder?.(bytes);
  } catch {
    // Metrics must not change the Wind request outcome.
  }
}

function timeoutFailure(responseBytes: number): WindCallFailure {
  const timeout = new Error("WIND_REQUEST_TIMEOUT");
  timeout.name = "AbortError";
  return new WindCallFailure({ error: timeout }, responseBytes);
}

function isTimeoutError(value: unknown): boolean {
  return (
    value instanceof Error &&
    (value.name === "AbortError" || value.name === "TimeoutError")
  );
}
