import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import { loadManifest } from "../../src/contracts/load-manifest";
import { createIWindMcpServer } from "../../src/mcp/create-server";

describe("iWind MCP tool discovery", () => {
  it("constructs and discovers all tools when runtime Function compilation is forbidden", async () => {
    const forbiddenFunction = vi.fn(() => {
      throw new Error("runtime Function compilation is forbidden");
    });
    let server: ReturnType<typeof createIWindMcpServer> | undefined;
    vi.stubGlobal("Function", forbiddenFunction);
    try {
      server = createIWindMcpServer({ era: "modern" }, {
        env: {} as never,
        waitUntil: () => undefined,
        invoke: async () => ({ toolResult: { content: [] }, notice: null }),
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(forbiddenFunction).not.toHaveBeenCalled();
    expect(server).toBeDefined();
    if (server === undefined) throw new Error("MCP server construction failed");

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.listTools();
    expect(result.tools).toHaveLength(31);
    await Promise.all([client.close(), server.close()]);
  });

  it("exposes exactly the frozen 31 native schemas and read-only annotations", async () => {
    const server = createIWindMcpServer({ era: "modern" }, {
      env: {} as never,
      waitUntil: () => undefined,
      invoke: async () => ({ toolResult: { content: [] }, notice: null }),
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.listTools();
    const expected = loadManifest().upstreams.flatMap((upstream) => upstream.tools);

    expect(result.tools).toHaveLength(31);
    expect(result.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).toEqual(expected);
    for (const tool of result.tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
    await Promise.all([client.close(), server.close()]);
  });
});
