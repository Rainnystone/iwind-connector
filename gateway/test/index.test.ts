import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { createMcpRequestHandler } from "../src/mcp/api-handler";
import { createIWindMcpServer } from "../src/mcp/create-server";

describe("gateway worker", () => {
  it("keeps the default Worker surface closed until Task 7 OAuth delegates authenticated props", async () => {
    const responsePromise = worker.fetch(new Request("https://gateway.test/mcp"));

    expect(responsePromise).toBeInstanceOf(Promise);
    const response = await responsePromise;
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("Forbidden");

    const other = await worker.fetch(new Request("https://gateway.test/unknown"));
    expect(other.status).toBe(404);
  });

  it("rejects invalid props before MCP creation and serves isolated HTTP exchanges for exact props", async () => {
    const invalidContexts = [
      {},
      { userId: "user", emailHash: "hash", scopes: [] },
      { userId: "user", emailHash: "hash", scopes: ["mcp:read", "extra"] },
    ];
    for (const props of invalidContexts) {
      let factories = 0;
      const handler = createMcpRequestHandler({
        env: {} as never,
        context: context(props),
        createServer: () => {
          factories += 1;
          throw new Error("must-not-create-server-for-invalid-props");
        },
      });
      await expect(handler(new Request("https://gateway.test/mcp"))).resolves.toMatchObject({ status: 403 });
      expect(factories).toBe(0);
    }
    await expect(
      createMcpRequestHandler({ env: {} as never, context: context(exactProps("one")) })(
        new Request("https://gateway.test/not-mcp"),
      ),
    ).resolves.toMatchObject({ status: 404 });

    const identities = { nextServer: 0, servers: [] as number[], requestIds: [] as string[] };
    const first = await listAndCallOverHttp(exactProps("one"), identities);
    const second = await listAndCallOverHttp(exactProps("two"), identities);
    expect(first).toBe(31);
    expect(second).toBe(31);
    expect(identities.servers.length).toBeGreaterThanOrEqual(4);
    expect(new Set(identities.servers).size).toBe(identities.servers.length);
    expect(identities.requestIds).toHaveLength(2);
    expect(identities.requestIds[0]).not.toBe(identities.requestIds[1]);
  });
});

function exactProps(userId: string) {
  return { userId, emailHash: `hash-${userId}`, scopes: ["mcp:read"] };
}

function context(props: object) {
  return { props, waitUntil: () => undefined } as never;
}

async function listAndCallOverHttp(
  props: ReturnType<typeof exactProps>,
  identities: { nextServer: number; servers: number[]; requestIds: string[] },
): Promise<number> {
  const handler = createMcpRequestHandler({
    env: {} as never,
    context: context(props),
    createServer: (requestContext) => {
      const identity = ++identities.nextServer;
      identities.servers.push(identity);
      return createIWindMcpServer(requestContext, {
        env: {} as never,
        waitUntil: () => undefined,
        invoke: async (request) => {
          identities.requestIds.push(request.requestId);
          return { toolResult: { content: [{ type: "text", text: "ok" }] }, notice: null };
        },
      });
    },
  });
  const transport = new StreamableHTTPClientTransport(new URL("https://gateway.test/mcp"), {
    fetch: (input, init) => handler(new Request(input, init)),
  });
  const client = new Client({ name: "http-test-client", version: "1.0.0" });
  await client.connect(transport);
  const result = await client.listTools();
  await client.callTool({ name: "get_stock_quote", arguments: { windcode: "600519.SH" } });
  await client.close();
  return result.tools.length;
}
