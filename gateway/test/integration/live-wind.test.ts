import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { UPSTREAMS, type UpstreamId } from "../../src/config/upstreams";
import { loadManifest } from "../../src/contracts/load-manifest";
import { createWindSessionFactory } from "../../src/upstream/session";

const LIVE_ENABLED = process.env.IWIND_LIVE_TEST === "1";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const REPRESENTATIVES: Readonly<Record<UpstreamId, {
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}>> = {
  stock_data: {
    id: "LIVE-STOCK-01",
    tool: "get_stock_price_indicators",
    input: { windcode: "600519.SH" },
  },
  fund_data: {
    id: "LIVE-FUND-01",
    tool: "get_fund_info",
    input: { question: "查询易方达蓝筹精选（005827.OF）的现任基金经理和成立日期" },
  },
  index_data: {
    id: "LIVE-INDEX-01",
    tool: "get_index_price_indicators",
    input: { windcode: "000905.SH" },
  },
  economic_data: {
    id: "LIVE-ECONOMIC-01",
    tool: "natural_language_get_edb_data",
    input: { executionMode: "search", question: "搜索中国居民消费价格指数相关指标" },
  },
  financial_docs: {
    id: "LIVE-DOCS-01",
    tool: "get_company_announcements",
    input: { query: "查询贵州茅台2024年的分红公告", top_k: 1 },
  },
  analytics_data: {
    id: "LIVE-ANALYTICS-01",
    tool: "get_financial_data",
    input: { question: "查询中国A股市场过去一年的平均成交量" },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Task 10 live Wind acceptance", () => {
  it.skipIf(!LIVE_ENABLED)(
    "initializes, verifies tools/list, and performs six strictly serial read-only calls",
    async () => {
      const apiKey = process.env.WIND_API_KEY_01;
      if (apiKey === undefined || apiKey.trim().length === 0) {
        throw new Error("LIVE_WIND_KEY_01_MISSING");
      }
      const factory = createWindSessionFactory();
      const manifest = loadManifest();
      let inFlight = 0;
      let maximumInFlight = 0;
      let totalTools = 0;
      const summaries: string[] = [];

      for (const upstream of Object.values(UPSTREAMS)) {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        const startedAt = performance.now();
        let session: Awaited<ReturnType<typeof factory.connect>> | undefined;
        try {
          session = await factory.connect(upstream, apiKey);
          const tools = await session.listTools();
          const expected = manifest.upstreams.find(({ id }) => id === upstream.id);
          expect(expected, upstream.id).toBeDefined();
          expect(tools.map(({ name }) => name).sort(), upstream.id).toEqual(
            expected?.tools.map(({ name }) => name).sort(),
          );
          totalTools += tools.length;

          const representative = REPRESENTATIVES[upstream.id];
          const result = await session.callTool(representative.tool, representative.input);
          expect(isToolError(result), representative.id).toBe(false);
          const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
          summaries.push(
            `${representative.id} PASS duration_ms=${Math.round(performance.now() - startedAt)} bytes=${bytes}`,
          );
        } finally {
          try {
            await session?.close();
          } finally {
            inFlight -= 1;
          }
        }
      }

      expect(totalTools).toBe(31);
      expect(maximumInFlight).toBe(1);
      process.stdout.write(`${summaries.join("\n")}\nLIVE-SERIAL-01 PASS max_inflight=1\n`);
    },
    180_000,
  );
});

describe("Task 10 architecture audit", () => {
  it("keeps 31 unique tools on six unique URLs and one KeyPool coordination atom", async () => {
    const manifest = loadManifest();
    const tools = manifest.upstreams.flatMap(({ tools: entries }) => entries);
    const urls = manifest.upstreams.map(({ url }) => url);
    const wrangler = JSON.parse(
      await readFile(path.join(ROOT, "gateway/wrangler.jsonc"), "utf8"),
    ) as {
      durable_objects: { bindings: Array<{ name: string; class_name: string }> };
    };

    expect(tools).toHaveLength(31);
    expect(new Set(tools.map(({ name }) => name))).toHaveLength(31);
    expect(new Set(urls)).toHaveLength(6);
    expect(wrangler.durable_objects.bindings).toEqual([
      { name: "KEY_POOL", class_name: "KeyPool" },
    ]);
    expect(tools.every(({ name }) => !/(?:write|trade|trading|bond)/iu.test(name))).toBe(true);
  });

  it("has no cache, McpAgent, round-robin, or parallel-upstream implementation path", async () => {
    const productionFiles = await sourceFiles(path.join(ROOT, "gateway/src"));
    const production = (await Promise.all(
      productionFiles.map(async (file) => `${file}\n${await readFile(file, "utf8")}`),
    )).join("\n");
    const upstreamExecution = [
      "gateway/src/invocation/invoke.ts",
      "gateway/src/upstream/call-tool.ts",
      "gateway/src/upstream/session.ts",
      "gateway/src/key-pool/client.ts",
    ].map((file) => path.join(ROOT, file));
    const upstreamSource = (await Promise.all(
      upstreamExecution.map((file) => readFile(file, "utf8")),
    )).join("\n");

    expect(production).not.toMatch(/\bMcpAgent\b/u);
    expect(production).not.toMatch(/round[-_ ]?robin/iu);
    expect(production).not.toMatch(/\bcaches?\.(?:default|open|match|put|delete)\b/u);
    expect(upstreamSource).not.toMatch(/Promise\.(?:all|allSettled|race|any)\s*\(/u);
  });
});

describe("offline Wind session transport acceptance", () => {
  it("uses the real default MCP adapter for initialize, capabilities, list, call, and close", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const message: unknown = JSON.parse(String(init?.body));
      if (!isRecord(message) || typeof message.method !== "string") {
        return new Response(null, { status: 202 });
      }
      methods.push(message.method);
      if (message.method === "server/discover") {
        return new Response("legacy endpoint", { status: 404 });
      }
      if (message.method === "initialize") {
        return jsonRpc(message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "offline-session-fixture", version: "1" },
        });
      }
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "tools/list") {
        return jsonRpc(message.id, {
          tools: [
            {
              name: "read_fixture",
              description: "read-only fixture",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true, destructiveHint: false },
            },
            {
              name: "declared_writable_fixture",
              description: "fixture used to prove declaration capture",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: false, destructiveHint: false },
            },
          ],
        });
      }
      if (message.method === "resources/list") {
        return jsonRpc(message.id, { resources: [{ uri: "fixture://resource", name: "fixture" }] });
      }
      if (message.method === "prompts/list") {
        return jsonRpc(message.id, { prompts: [{ name: "fixture-prompt" }] });
      }
      if (message.method === "tools/call") {
        return jsonRpc(message.id, {
          content: [{ type: "text", text: "synthetic-session-success" }],
          isError: false,
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const factory = createWindSessionFactory();
    const session = await factory.connect(UPSTREAMS.stock_data, "offline-session-key");
    expect(session.serverInfo).toEqual({ name: "offline-session-fixture", version: "1" });
    expect(session.serverCapabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
    expect((await session.listTools()).map(({ name }) => name)).toEqual([
      "read_fixture",
      "declared_writable_fixture",
    ]);
    expect(session.declaredWritableToolNames).toEqual(["declared_writable_fixture"]);
    await expect(session.listResourcesIfSupported()).resolves.toHaveLength(1);
    await expect(session.listPromptsIfSupported()).resolves.toHaveLength(1);
    await expect(session.callTool("read_fixture", {})).resolves.toMatchObject({ isError: false });
    await session.close();

    expect(methods).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/list",
      "resources/list",
      "prompts/list",
      "tools/call",
    ]);
  });

  it("returns empty resource and prompt lists when the real adapter sees no capabilities", async () => {
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const message: unknown = JSON.parse(String(init?.body));
      if (!isRecord(message) || typeof message.method !== "string") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "server/discover") return new Response("legacy", { status: 404 });
      if (message.method === "initialize") {
        return jsonRpc(message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "offline-session-fixture", version: "1" },
        });
      }
      return new Response(null, { status: 202 });
    });

    const session = await createWindSessionFactory().connect(
      UPSTREAMS.stock_data,
      "offline-session-key",
    );
    await expect(session.listResourcesIfSupported()).resolves.toEqual([]);
    await expect(session.listPromptsIfSupported()).resolves.toEqual([]);
    await session.close();
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(target)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files.sort();
}

function isToolError(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "isError") === true;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
