import { McpServer, fromJsonSchema, type McpRequestContext } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";

import { loadManifest } from "../contracts/load-manifest";
import { invokeWindTool } from "../invocation/invoke";
import type { InvocationDependencies } from "../invocation/types";
import { toMcpToolResult } from "./tool-result";

export interface AuthProps {
  readonly userId: string;
  readonly emailHash: string;
  readonly scopes: readonly ["mcp:read"];
}

export interface CreateIWindMcpServerOptions {
  readonly env: InvocationDependencies["env"];
  readonly waitUntil: InvocationDependencies["waitUntil"];
  readonly invoke?: typeof invokeWindTool;
}

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * The SDK v2 factory context is non-generic. Auth is checked by McpApiHandler
 * before this function is reachable; requestInfo is kept only for protocol
 * lifecycle compatibility.
 */
export function createIWindMcpServer(
  _requestContext: McpRequestContext,
  options: CreateIWindMcpServerOptions,
): McpServer {
  const server = new McpServer({ name: "iwind-connector", version: "0.1.0" });
  const schemaValidator = new CfWorkerJsonSchemaValidator();
  const invoke = options.invoke ?? invokeWindTool;

  for (const upstream of loadManifest().upstreams) {
    for (const tool of upstream.tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: fromJsonSchema<Record<string, unknown>>(
            tool.inputSchema,
            schemaValidator,
          ),
          annotations: TOOL_ANNOTATIONS,
        },
        async (input) => {
          const result = await invoke(
            { requestId: crypto.randomUUID(), toolName: tool.name, input },
            { env: options.env, waitUntil: options.waitUntil },
          );
          return toMcpToolResult(result.toolResult, result.notice);
        },
      );
    }
  }
  return server;
}

export { TOOL_ANNOTATIONS };
