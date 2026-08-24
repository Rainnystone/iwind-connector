export const MAX_RESPONSE_BYTES = 8_388_608;
export const MAX_ERROR_ENVELOPE_BYTES = 16 * 1024;

export interface ResponseRecord {
  readonly status: number | null;
  readonly headers: Headers;
  readonly errorBody: Uint8Array | undefined;
  readonly errorEnvelopeTruncated: boolean;
  readonly responseBytes: number;
  readonly responseTooLarge: boolean;
}

export interface ResponseRecorder {
  startRequest(): void;
  begin(response: Response): void;
  count(bytes: number): void;
  captureErrorChunk(chunk: Uint8Array): void;
  markErrorEnvelopeTruncated(): void;
  markResponseTooLarge(): void;
  snapshot(): ResponseRecord;
}

export class ResponseTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly observedBytes: number,
  ) {
    super("WIND_RESPONSE_TOO_LARGE");
    this.name = "ResponseTooLargeError";
  }
}

export function createResponseRecorder(): ResponseRecorder {
  let status: number | null = null;
  let headers = new Headers();
  let responseBytes = 0;
  let responseTooLarge = false;
  let errorEnvelopeTruncated = false;
  let errorBodyBytes = 0;
  let errorChunks: Uint8Array[] = [];

  return {
    startRequest() {
      status = null;
      headers = new Headers();
      responseBytes = 0;
      responseTooLarge = false;
      errorEnvelopeTruncated = false;
      errorBodyBytes = 0;
      errorChunks = [];
    },
    begin(response) {
      status = response.status;
      headers = new Headers(response.headers);
      responseBytes = 0;
      responseTooLarge = false;
      errorEnvelopeTruncated = false;
      errorBodyBytes = 0;
      errorChunks = [];
    },
    count(bytes) {
      responseBytes += bytes;
    },
    captureErrorChunk(chunk) {
      if (chunk.byteLength === 0 || errorBodyBytes >= MAX_ERROR_ENVELOPE_BYTES) return;
      const remaining = MAX_ERROR_ENVELOPE_BYTES - errorBodyBytes;
      const captured = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      errorChunks.push(captured.slice());
      errorBodyBytes += captured.byteLength;
    },
    markErrorEnvelopeTruncated() {
      errorEnvelopeTruncated = true;
    },
    markResponseTooLarge() {
      responseTooLarge = true;
    },
    snapshot() {
      return {
        status,
        headers: new Headers(headers),
        errorBody: errorBodyBytes === 0 ? undefined : concatenate(errorChunks, errorBodyBytes),
        errorEnvelopeTruncated,
        responseBytes,
        responseTooLarge,
      };
    },
  };
}

export function limitResponseBody(
  response: Response,
  maxResponseBytes: number,
  recorder: ResponseRecorder,
): Response {
  assertLimit(maxResponseBytes);
  recorder.begin(response);
  if (response.body === null) {
    return new Response(null, responseInit(response));
  }

  const reader = response.body.getReader();
  const isErrorResponse = !response.ok;
  let totalBytes = 0;
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
          return;
        }

        const rawChunk: unknown = next.value;
        const chunk = requireByteChunk(rawChunk);

        totalBytes += chunk.byteLength;
        recorder.count(chunk.byteLength);

        if (isErrorResponse) {
          const alreadyCaptured = Math.min(totalBytes - chunk.byteLength, MAX_ERROR_ENVELOPE_BYTES);
          const remaining = MAX_ERROR_ENVELOPE_BYTES - alreadyCaptured;
          if (remaining > 0) {
            const emitted = chunk.slice(0, remaining);
            recorder.captureErrorChunk(emitted);
            controller.enqueue(emitted);
          }
          if (totalBytes > MAX_ERROR_ENVELOPE_BYTES) {
            recorder.markErrorEnvelopeTruncated();
            try {
              await reader.cancel("bounded error envelope");
            } catch {
              // The bounded response still closes even if upstream cancellation fails.
            }
            release();
            controller.close();
          }
          return;
        }

        if (totalBytes > maxResponseBytes) {
          const error = new ResponseTooLargeError(maxResponseBytes, totalBytes);
          recorder.markResponseTooLarge();
          try {
            await reader.cancel(error);
          } catch {
            // Preserve the typed size failure even if upstream cancellation fails.
          }
          release();
          controller.error(error);
          return;
        }

        controller.enqueue(chunk);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });

  return new Response(stream, responseInit(response));
}

function responseInit(response: Response): ResponseInit {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("INVALID_RESPONSE_LIMIT");
}

function concatenate(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function requireByteChunk(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("INVALID_RESPONSE_CHUNK");
  return value;
}
