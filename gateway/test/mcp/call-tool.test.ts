import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { createIWindMcpServer } from "../../src/mcp/create-server";
import { invokeWindTool } from "../../src/invocation/invoke";
import type { InvocationKeyPool, WindToolCaller } from "../../src/invocation/types";

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
    const calls: Array<{ upstreamId: string; upstreamUrl: string; toolName: string; arguments: Record<string, unknown> }> = [];
    let nextLease = 0;
    const keyPool: InvocationKeyPool = {
      acquire: async () => ({ ok: true, leaseId: `lease-${++nextLease}`, slotId: "key-01", expiresAt: 1 }),
      report: async () => undefined,
    };
    const caller: WindToolCaller = {
      call: async ({ upstream, toolName, arguments: argumentsValue }) => {
        calls.push({ upstreamId: upstream.id, upstreamUrl: upstream.url.href, toolName, arguments: { ...argumentsValue } });
        return { content: [{ type: "text", text: toolName }], isError: false };
      },
    };
    const waitUntil: Promise<void>[] = [];
    const server = createIWindMcpServer({ era: "modern" }, {
      env: { KEY_POOL: {} as never, WIND_API_KEY_01: "unit-key-one", WIND_API_KEY_02: "unit-key-two" },
      waitUntil: (promise) => waitUntil.push(promise),
      invoke: (request, dependencies) => invokeWindTool(request, { ...dependencies, keyPool, caller }),
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

    expect(calls).toEqual([
      { upstreamId: "stock_data", upstreamUrl: "https://mcp.wind.com.cn/vserver_stock_data/mcp/", toolName: "get_risk_metrics", arguments: { question: "600519.SH beta" } },
      { upstreamId: "fund_data", upstreamUrl: "https://mcp.wind.com.cn/vserver_fund_data/mcp/", toolName: "get_fund_company_info", arguments: { question: "易方达公司" } },
      { upstreamId: "index_data", upstreamUrl: "https://mcp.wind.com.cn/vserver_index_data/mcp/", toolName: "get_index_basicinfo", arguments: { question: "沪深300" } },
      { upstreamId: "economic_data", upstreamUrl: "https://mcp.wind.com.cn/vserver_economic_data/mcp/", toolName: "get_economic_data", arguments: { metricIdsStr: "中国GDP" } },
      { upstreamId: "financial_docs", upstreamUrl: "https://mcp.wind.com.cn/vserver_financial_docs/mcp/", toolName: "get_company_announcements", arguments: { query: "贵州茅台年报" } },
      { upstreamId: "analytics_data", upstreamUrl: "https://mcp.wind.com.cn/vserver_analytics_data/mcp/", toolName: "get_financial_data", arguments: { question: "A股平均成交量" } },
    ]);
    expect(waitUntil).toEqual([]);
    await Promise.all([client.close(), server.close()]);
  });
});
