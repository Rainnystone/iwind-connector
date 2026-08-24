import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { createIWindMcpServer } from "../../src/mcp/create-server";

describe("iWind MCP request isolation", () => {
  it("creates a different server and request identity for separate protocol exchanges", async () => {
    const requestIds: string[] = [];
    const options = {
      env: {} as never,
      waitUntil: () => undefined,
      invoke: async (request: { readonly requestId: string }) => {
        requestIds.push(request.requestId);
        return { toolResult: { content: [{ type: "text" as const, text: "ok" }] }, notice: null };
      },
    };
    const first = createIWindMcpServer({ era: "modern" }, options);
    const second = createIWindMcpServer({ era: "modern" }, options);
    expect(first).not.toBe(second);

    await Promise.all([call(first), call(second)]);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });
});

async function call(server: ReturnType<typeof createIWindMcpServer>): Promise<void> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.callTool({ name: "get_stock_quote", arguments: { windcode: "600519.SH" } });
  await Promise.all([client.close(), server.close()]);
}
