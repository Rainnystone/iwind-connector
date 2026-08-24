export class BoundedBodyTooLargeError extends Error {
  constructor() {
    super("BODY_TOO_LARGE");
    this.name = "BoundedBodyTooLargeError";
  }
}

export async function rebuildRequestWithBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<Request> {
  const body = await readBoundedBody(request.body, request.headers, maximumBytes);
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
  });
}

export async function rebuildResponseWithBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Response> {
  const body = await readBoundedBody(response.body, response.headers, maximumBytes);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  headers: Headers,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("INVALID_BODY_LIMIT");
  }
  if (stream === null) return new Uint8Array();
  const reader = stream.getReader();
  const declaredLength = headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await reader.cancel();
    reader.releaseLock();
    throw new BoundedBodyTooLargeError();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new BoundedBodyTooLargeError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
