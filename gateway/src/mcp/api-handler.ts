import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import type { McpRequestContext } from "@modelcontextprotocol/server";

import { createIWindMcpServer, type AuthProps } from "./create-server";

export class McpApiHandler extends WorkerEntrypoint<Cloudflare.Env, AuthProps> {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }
    if (!hasReadScope(this.ctx.props)) {
      return new Response("Forbidden", { status: 403 });
    }

    const handler = createMcpHandler((requestContext: McpRequestContext) =>
      createIWindMcpServer(requestContext, {
        env: this.env,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
      }),
    );
    return handler(request, this.env, this.ctx);
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
