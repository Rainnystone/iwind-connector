import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import { UPSTREAMS, type UpstreamDefinition, type UpstreamId } from "../src/config/upstreams";
import type {
  ManifestTool,
  ManifestUpstream,
  ToolManifestV1,
} from "../src/contracts/load-manifest";
import { SOURCE_COMMIT, TOOL_SEED } from "../src/contracts/tool-seed";
import {
  createWindSessionFactory,
  summarizeCapabilities,
  type WindProbeSession,
} from "../src/upstream/session";

interface DiscoverySummary {
  readonly domain: UpstreamId;
  readonly status: "success";
  readonly durationMs: number;
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly promptCount: number;
  readonly serverInfo: Readonly<Record<string, unknown>>;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

interface SmokeSummary {
  readonly requestId: string;
  readonly domain: UpstreamId;
  readonly tool: string;
  readonly status: "success";
  readonly durationMs: number;
  readonly responseBytes: number;
  readonly schemaShape: Readonly<Record<string, unknown>>;
}

const representativeCalls: Readonly<Record<UpstreamId, {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}>> = {
  stock_data: {
    tool: "get_stock_price_indicators",
    input: { windcode: "600519.SH" },
  },
  fund_data: {
    tool: "get_fund_info",
    input: { question: "查询易方达蓝筹精选（005827.OF）的现任基金经理和成立日期" },
  },
  index_data: {
    tool: "get_index_price_indicators",
    input: { windcode: "000905.SH" },
  },
  economic_data: {
    tool: "natural_language_get_edb_data",
    input: { executionMode: "search", question: "搜索中国居民消费价格指数相关指标" },
  },
  financial_docs: {
    tool: "get_company_announcements",
    input: { query: "查询贵州茅台2024年的分红公告", top_k: 1 },
  },
  analytics_data: {
    tool: "get_financial_data",
    input: { question: "查询中国A股市场过去一年的平均成交量" },
  },
};

class ContractMismatch extends Error {
  constructor(
    readonly reason: string,
    readonly metadata: Readonly<Record<string, unknown>>,
  ) {
    super(reason);
  }
}

const credentials = (() => {
  try {
    const slot = readSlot(process.argv.slice(2));
    return { slot, apiKey: readApiKey(slot) };
  } catch (error) {
    const failure = error instanceof ContractMismatch
      ? { status: "stop-gate", reason: error.reason, mismatch: error.metadata }
      : { status: "failed", reason: "probe-initialization-failed" };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    return undefined;
  }
})();
if (!credentials) process.exit(1);
const { slot, apiKey } = credentials;
const factory = createWindSessionFactory();
let activeUpstreams = 0;
let maxObservedUpstreamConcurrency = 0;

try {
  const capturedAt = new Date().toISOString();
  const manifestUpstreams: ManifestUpstream[] = [];
  const discoveries: DiscoverySummary[] = [];

  for (const upstream of Object.values(UPSTREAMS)) {
    const startedAt = performance.now();
    const discovery = await withTrackedProbe(upstream, async (session) => {
      const tools = await session.listTools();
      const resources = await session.listResourcesIfSupported();
      const prompts = await session.listPromptsIfSupported();
      return { tools, resources, prompts, session };
    });
    const tools = validateTools(
      upstream,
      discovery.tools,
      discovery.session.declaredWritableToolNames,
    );
    manifestUpstreams.push({
      id: upstream.id,
      url: upstream.url.href,
      transport: "streamable-http",
      serverInfo: discovery.session.serverInfo,
      tools,
    });
    discoveries.push({
      domain: upstream.id,
      status: "success",
      durationMs: elapsedMs(startedAt),
      toolCount: tools.length,
      resourceCount: discovery.resources.length,
      promptCount: discovery.prompts.length,
      serverInfo: discovery.session.serverInfo,
      capabilities: summarizeCapabilities(discovery.session.serverCapabilities),
    });
  }

  const allNames = manifestUpstreams.flatMap(({ tools }) => tools.map(({ name }) => name));
  if (allNames.length !== 31 || new Set(allNames).size !== 31) {
    throw new ContractMismatch("total-or-unique-tool-count", {
      expectedTotal: 31,
      actualTotal: allNames.length,
      actualUnique: new Set(allNames).size,
    });
  }

  const smokes: SmokeSummary[] = [];
  for (const upstream of Object.values(UPSTREAMS)) {
    const representative = representativeCalls[upstream.id];
    const startedAt = performance.now();
    const result = await withTrackedProbe(upstream, (session) =>
      session.callTool(representative.tool, representative.input),
    );
    const serialized = JSON.stringify(result);
    if (serialized === undefined || isToolError(result)) {
      throw new ContractMismatch("representative-call-failed", {
        domain: upstream.id,
        tool: representative.tool,
      });
    }
    smokes.push({
      requestId: randomUUID(),
      domain: upstream.id,
      tool: representative.tool,
      status: "success",
      durationMs: elapsedMs(startedAt),
      responseBytes: Buffer.byteLength(serialized),
      schemaShape: summarizeShape(result),
    });
  }

  const manifest: ToolManifestV1 = {
    schemaVersion: 1,
    capturedAt,
    sourceCommit: SOURCE_COMMIT,
    upstreams: manifestUpstreams,
  };
  await writeSnapshot(manifest, discoveries);

  process.stdout.write(`${JSON.stringify({
    status: "success",
    capturedAt,
    sourceCommit: SOURCE_COMMIT,
    transport: "streamable-http",
    discoveries,
    smokes,
    totalTools: allNames.length,
    uniqueTools: new Set(allNames).size,
    maxObservedUpstreamConcurrency,
  }, null, 2)}\n`);
} catch (error) {
  const failure = error instanceof ContractMismatch
    ? { status: "stop-gate", reason: error.reason, mismatch: error.metadata }
    : { status: "failed", reason: "upstream-probe-failed" };
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}

async function withTrackedProbe<T>(
  upstream: UpstreamDefinition,
  operation: (session: WindProbeSession) => Promise<T>,
): Promise<T> {
  activeUpstreams += 1;
  maxObservedUpstreamConcurrency = Math.max(maxObservedUpstreamConcurrency, activeUpstreams);
  let session: WindProbeSession | undefined;
  try {
    session = await factory.connect(upstream, apiKey);
    return await operation(session);
  } finally {
    try {
      await session?.close();
    } finally {
      activeUpstreams -= 1;
    }
  }
}

function validateTools(
  upstream: UpstreamDefinition,
  liveTools: readonly ManifestTool[],
  declaredWritableToolNames: readonly string[],
): readonly ManifestTool[] {
  const expectedNames = [...TOOL_SEED[upstream.id]].sort();
  const tools = [...liveTools].sort((left, right) => left.name.localeCompare(right.name));
  const actualNames = tools.map(({ name }) => name);
  if (tools.length !== upstream.expectedToolCount || JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new ContractMismatch("upstream-tool-set", {
      domain: upstream.id,
      expectedCount: upstream.expectedToolCount,
      actualCount: tools.length,
      expectedNames,
      actualNames,
    });
  }
  if (declaredWritableToolNames.length > 0) {
    throw new ContractMismatch("declared-write-tools", {
      domain: upstream.id,
      toolNames: [...declaredWritableToolNames].sort(),
    });
  }
  for (const tool of tools) {
    if (tool.description.trim().length === 0) {
      throw new ContractMismatch("empty-tool-description", { domain: upstream.id, tool: tool.name });
    }
    if (tool.inputSchema.type !== "object") {
      throw new ContractMismatch("non-object-input-schema", {
        domain: upstream.id,
        tool: tool.name,
        actualType: tool.inputSchema.type ?? "missing",
      });
    }
  }
  return tools;
}

async function writeSnapshot(
  manifest: ToolManifestV1,
  discoveries: readonly DiscoverySummary[],
): Promise<void> {
  const manifestUrl = new URL("../src/contracts/tool-manifest.json", import.meta.url);
  const hashUrl = new URL("../src/contracts/tool-manifest.sha256", import.meta.url);
  const docsUrl = new URL("../../docs/contract-snapshot.md", import.meta.url);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const hash = createHash("sha256").update(bytes).digest("hex");
  const counts = discoveries.map(({ domain, toolCount }) => `- \`${domain}\`: ${toolCount} tools`).join("\n");
  const docs = `# Wind MCP contract snapshot\n\n` +
    `Captured at: \`${manifest.capturedAt}\`\n\n` +
    `Source seed commit: \`${manifest.sourceCommit}\`\n\n` +
    `All six endpoints initialized over Streamable HTTP with protocol auto negotiation. ` +
    `The snapshot contains 31 unique read-only query tools. No response payload or credential is retained. ` +
    `The sourceCommit field records the official static seed as a provenance baseline; the approved live-only ` +
    `addition \`get_economic_data\` comes from this authenticated capture and is not claimed to exist in that baseline.\n\n` +
    `## Upstream counts\n\n${counts}\n\n` +
    `## Known limitations\n\n` +
    `This is an explicit point-in-time contract. Upstream descriptions and JSON Schemas may drift and must be re-probed and reviewed before updating the snapshot. Representative calls prove only the six recorded read-only paths, not every valid input or vendor data condition.\n`;

  await mkdir(new URL("../../docs/", import.meta.url), { recursive: true });
  await Promise.all([
    writeFile(manifestUrl, bytes, { encoding: "utf8", mode: 0o644 }),
    writeFile(hashUrl, `${hash}\n`, { encoding: "utf8", mode: 0o644 }),
    writeFile(docsUrl, docs, { encoding: "utf8", mode: 0o644 }),
  ]);
}

function summarizeShape(value: unknown): Readonly<Record<string, unknown>> {
  if (Array.isArray(value)) return { type: "array", itemCount: value.length };
  if (!isRecord(value)) return { type: value === null ? "null" : typeof value };
  const content = Array.isArray(value.content) ? value.content : [];
  return {
    type: "object",
    keys: Object.keys(value).sort(),
    contentCount: content.length,
    contentTypes: [...new Set(content.map((item) => isRecord(item) && typeof item.type === "string" ? item.type : "unknown"))].sort(),
  };
}

function isToolError(value: unknown): boolean {
  return isRecord(value) && value.isError === true;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function readSlot(args: readonly string[]): "key-01" {
  const index = args.indexOf("--slot");
  if (index === -1 || args[index + 1] !== "key-01") {
    throw new ContractMismatch("invalid-slot", { expected: "key-01" });
  }
  return "key-01";
}

function readApiKey(slotName: "key-01"): string {
  const key = process.env.WIND_API_KEY_01;
  if (slotName !== "key-01" || !key) {
    throw new ContractMismatch("missing-private-key", { slot: slotName });
  }
  return key;
}
