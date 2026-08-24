import type { FetchLike } from "@modelcontextprotocol/client";

import { limitResponseBody, type ResponseRecorder } from "./result-limit";

export interface AuthorizedFetchOptions {
  readonly apiKey: string;
  readonly maxResponseBytes: number;
  readonly recorder: ResponseRecorder;
  readonly baseFetch?: FetchLike;
}

export function createAuthorizedFetch(options: AuthorizedFetchOptions): FetchLike {
  const baseFetch = options.baseFetch ?? fetch;
  return async (url, init) => {
    options.recorder.startRequest();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${options.apiKey}`);
    const response = await baseFetch(url, { ...init, headers });
    return limitResponseBody(response, options.maxResponseBytes, options.recorder);
  };
}
