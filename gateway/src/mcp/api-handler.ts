import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import type { McpRequestContext, McpServer } from "@modelcontextprotocol/server";

import { createIWindMcpServer, type AuthProps } from "./create-server";

export interface McpRequestHandlerOptions {
  readonly env: Cloudflare.Env;
  readonly context: ExecutionContext<AuthProps>;
  readonly createServer?: (requestContext: McpRequestContext) => McpServer;
}

export function createMcpRequestHandler(options: McpRequestHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }
    if (!hasReadScope(options.context.props)) {
      return new Response("Forbidden", { status: 403 });
    }

    const createServer = options.createServer ?? ((requestContext: McpRequestContext) =>
      createIWindMcpServer(requestContext, {
        env: options.env,
        waitUntil: (promise) => options.context.waitUntil(promise),
      }));
    const handler = createMcpHandler(createServer);
    return handler(request, options.env, options.context);
  };
}

export class McpApiHandler extends WorkerEntrypoint<Cloudflare.Env, AuthProps> {
  override async fetch(request: Request): Promise<Response> {
    return createMcpRequestHandler({ env: this.env, context: this.ctx })(request);
  }
}

function hasReadScope(props: unknown): props is AuthProps {
  if (!isRecord(props)) return false;
  return (
    typeof props.userId === "string" &&
    props.userId.length > 0 &&
    typeof props.emailHash === "string" &&
    props.emailHash.length > 0 &&
    Array.isArray(props.scopes) &&
    props.scopes.length === 1 &&
    props.scopes[0] === "mcp:read"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
