import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";

import type { UpstreamDefinition } from "../config/upstreams";
import type { ManifestTool } from "../contracts/load-manifest";

declare global {
  type Buffer = Uint8Array;
}

export interface WindSessionFactory {
  connect(upstream: UpstreamDefinition, apiKey: string): Promise<WindSession>;
}

export interface WindSession {
  listTools(): Promise<readonly ManifestTool[]>;
  listResourcesIfSupported(): Promise<readonly unknown[]>;
  listPromptsIfSupported(): Promise<readonly unknown[]>;
  callTool(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
}

export interface WindProbeSession extends WindSession {
  readonly serverInfo: Readonly<Record<string, unknown>>;
  readonly serverCapabilities: Readonly<Record<string, unknown>>;
  readonly declaredWritableToolNames: readonly string[];
}

export interface WindProbeSessionFactory extends WindSessionFactory {
  connect(upstream: UpstreamDefinition, apiKey: string): Promise<WindProbeSession>;
}

export interface McpClientAdapter {
  connect(): Promise<void>;
  listTools(): Promise<readonly ManifestTool[]>;
  listResources(): Promise<readonly unknown[]>;
  listPrompts(): Promise<readonly unknown[]>;
  callTool(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
  getServerInfo(): Readonly<Record<string, unknown>>;
  getServerCapabilities(): Readonly<Record<string, unknown>>;
  readonly declaredWritableToolNames: readonly string[];
}

export type McpClientAdapterFactory = (
  upstream: UpstreamDefinition,
  apiKey: string,
) => McpClientAdapter;

export function createAuthorizedFetch(apiKey: string, baseFetch: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("Authorization", `Bearer ${apiKey}`);
    return baseFetch(input, { ...init, headers });
  };
}

export function createWindSessionFactory(
  createAdapter: McpClientAdapterFactory = createSdkAdapter,
): WindProbeSessionFactory {
  return {
    async connect(upstream, apiKey) {
      const adapter = createAdapter(upstream, apiKey);
      try {
        await adapter.connect();
      } catch (error) {
        await adapter.close();
        throw error;
      }

      return {
        serverInfo: adapter.getServerInfo(),
        serverCapabilities: adapter.getServerCapabilities(),
        declaredWritableToolNames: adapter.declaredWritableToolNames,
        listTools: () => adapter.listTools(),
        listResourcesIfSupported: () => adapter.listResources(),
        listPromptsIfSupported: () => adapter.listPrompts(),
        callTool: (name, input) => adapter.callTool(name, input),
        close: () => adapter.close(),
      };
    },
  };
}

export async function withWindSession<T>(
  factory: WindSessionFactory,
  upstream: UpstreamDefinition,
  apiKey: string,
  operation: (session: WindSession) => Promise<T>,
): Promise<T> {
  let session: WindSession | undefined;
  try {
    session = await factory.connect(upstream, apiKey);
    return await operation(session);
  } finally {
    await session?.close();
  }
}

function createSdkAdapter(upstream: UpstreamDefinition, apiKey: string): McpClientAdapter {
  const client = new Client(
    { name: "iwind-contract-probe", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(upstream.url, {
    fetch: createAuthorizedFetch(apiKey),
  });
  const declaredWritableToolNames: string[] = [];

  return {
    declaredWritableToolNames,
    connect: async () => client.connect(transport),
    listTools: async () => {
      const { tools } = await client.listTools();
      declaredWritableToolNames.splice(
        0,
        declaredWritableToolNames.length,
        ...tools
          .filter(
            ({ annotations }) =>
              annotations?.readOnlyHint === false || annotations?.destructiveHint === true,
          )
          .map(({ name }) => name),
      );
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: asRecord(tool.inputSchema),
      }));
    },
    listResources: async () =>
      client.getServerCapabilities()?.resources ? (await client.listResources()).resources : [],
    listPrompts: async () =>
      client.getServerCapabilities()?.prompts ? (await client.listPrompts()).prompts : [],
    callTool: async (name, input) => client.callTool({ name, arguments: { ...input } }),
    close: async () => client.close(),
    getServerInfo: () => asRecord(client.getServerVersion()),
    getServerCapabilities: () => asRecord(client.getServerCapabilities()),
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeCapabilities(
  capabilities: Readonly<Record<string, unknown>>,
): Readonly<Record<string, boolean>> {
  return Object.fromEntries(
    Object.keys(capabilities)
      .sort()
      .map((name) => [name, true]),
  );
}
