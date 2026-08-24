import {
  BoundedBodyTooLargeError,
  rebuildRequestWithBoundedBody,
} from "../http/bounded-body";

export const OAUTH_TOKEN_BODY_LIMIT = 64 * 1024;
export const OAUTH_REGISTER_BODY_LIMIT = 1024 * 1024;

export async function enforceOAuthProviderBodyLimit(request: Request): Promise<Request | Response> {
  if (request.method !== "POST") return request;
  const pathname = new URL(request.url).pathname;
  const maximum =
    pathname === "/oauth/token"
      ? OAUTH_TOKEN_BODY_LIMIT
      : pathname === "/oauth/register"
        ? OAUTH_REGISTER_BODY_LIMIT
        : null;
  if (maximum === null) return request;

  try {
    return await rebuildRequestWithBoundedBody(request, maximum);
  } catch (error) {
    if (!(error instanceof BoundedBodyTooLargeError)) throw error;
    return new Response("Payload Too Large", {
      status: 413,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
