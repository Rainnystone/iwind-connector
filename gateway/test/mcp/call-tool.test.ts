import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { createIWindMcpServer } from "../../src/mcp/create-server";

describe("iWind MCP tool calls", () => {
  it("passes a manifest-native tool name and input to the invocation service", async () => {
    const received: Array<{ requestId: string; toolName: string; input: Record<string, unknown> }> = [];
    const server = createIWindMcpServer({ era: "modern" }, {
      env: {} as never,
      waitUntil: () => undefined,
      invoke: async (request) => {
        received.push(request);
        return { toolResult: { content: [{ type: "text", text: "ok" }], isError: false }, notice: null };
      },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "get_stock_quote", arguments: { windcode: "600519.SH" } });

    expect(result).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
    expect(received).toHaveLength(1);
    expect(received[0]?.toolName).toBe("get_stock_quote");
    expect(received[0]?.input).toEqual({ windcode: "600519.SH" });
    expect(received[0]?.requestId).toEqual(expect.any(String));
    await Promise.all([client.close(), server.close()]);
  });

  it("routes one native representative from every Wind domain through the invocation boundary", async () => {
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const server = createIWindMcpServer({ era: "modern" }, {
      env: {} as never,
      waitUntil: () => undefined,
      invoke: async ({ toolName, input }) => {
        calls.push({ toolName, input });
        return { toolResult: { content: [{ type: "text", text: toolName }] }, notice: null };
      },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const representatives = [
      ["get_risk_metrics", { question: "600519.SH beta" }],
      ["get_fund_company_info", { question: "易方达公司" }],
      ["get_index_basicinfo", { question: "沪深300" }],
      ["get_economic_data", { metricIdsStr: "中国GDP" }],
      ["get_company_announcements", { query: "贵州茅台年报" }],
      ["get_financial_data", { question: "A股平均成交量" }],
    ] as const;
    for (const [name, argumentsValue] of representatives) {
      await client.callTool({ name, arguments: argumentsValue });
    }

    expect(calls.map(({ toolName }) => toolName)).toEqual(representatives.map(([name]) => name));
    expect(calls.map(({ input }) => input)).toEqual(representatives.map(([, input]) => input));
    await Promise.all([client.close(), server.close()]);
  });
});
