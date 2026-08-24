import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface Manifest {
  readonly upstreams: ReadonlyArray<{
    readonly id: string;
    readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  }>;
}

interface RoutingCase {
  readonly id: string;
  readonly prompt: string;
  readonly domain: string;
  readonly reference: string;
  readonly expectedTools: ReadonlyArray<string>;
  readonly clarification: { readonly required: boolean; readonly subject: string | null };
  readonly dateResolution: {
    readonly required: boolean;
    readonly start: string | null;
    readonly end: string | null;
  };
  readonly forbiddenAlternatives: ReadonlyArray<string>;
  readonly derivedResult?: {
    readonly method: string;
    readonly inputs: ReadonlyArray<string>;
    readonly formula: string;
  };
}

interface CrossToolCase {
  readonly id: string;
  readonly prompt: string;
  readonly domain: string;
  readonly references: ReadonlyArray<string>;
  readonly primaryCoverage: boolean;
  readonly expectedTools: ReadonlyArray<string>;
  readonly historicalPriceTool: string;
  readonly calculation: {
    readonly method: string;
    readonly formula: string;
    readonly sameDateRequired: boolean;
  };
  readonly forbiddenAlternatives: ReadonlyArray<string>;
  readonly forbiddenAssumptions: ReadonlyArray<string>;
}

interface TriggerCase {
  readonly id: string;
  readonly prompt: string;
  readonly shouldTrigger: boolean;
  readonly domain: string | null;
  readonly reason: string;
  readonly dateResolution: {
    readonly required: boolean;
    readonly start: string | null;
    readonly end: string | null;
  };
}

const ROOT = path.resolve(import.meta.dirname, "../..");
const DOMAIN_BY_UPSTREAM: Readonly<Record<string, string>> = {
  stock_data: "stock",
  fund_data: "fund",
  index_data: "index",
  economic_data: "economic",
  financial_docs: "financial-docs",
  analytics_data: "analytics",
};

async function parseJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(ROOT, file), "utf8")) as T;
}

function parseToolRows(source: string): ReadonlyMap<string, { readonly use: string; readonly boundary: string }> {
  const rows = source.split("\n").flatMap((line) => {
    const match = /^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/.exec(line);
    return match === null
      ? []
      : [[match[1] ?? "", { use: (match[2] ?? "").trim(), boundary: (match[3] ?? "").trim() }] as const];
  });
  return new Map(rows);
}

function parseMarkdownSection(source: string, heading: string): string {
  const marker = `## ${heading}\n\n`;
  const start = source.indexOf(marker);
  expect(start, `${heading} section`).toBeGreaterThanOrEqual(0);
  const remainder = source.slice(start + marker.length);
  const end = remainder.indexOf("\n## ");
  return end === -1 ? remainder.trim() : remainder.slice(0, end).trim();
}

describe("deterministic Skill routing evals", () => {
  it("maps all 31 manifest tools exactly once to their owning reference", async () => {
    const manifest = await parseJson<Manifest>("gateway/src/contracts/tool-manifest.json");
    const cases = await parseJson<ReadonlyArray<RoutingCase>>("skill/evals/routing-cases.json");
    const manifestTools = manifest.upstreams.flatMap((upstream) =>
      upstream.tools.map((tool) => ({
        name: tool.name,
        domain: DOMAIN_BY_UPSTREAM[upstream.id],
      })),
    );
    const routedTools = cases.flatMap((testCase) =>
      testCase.expectedTools.map((name) => ({ name, domain: testCase.domain })),
    );

    expect(manifestTools).toHaveLength(31);
    expect(new Set(manifestTools.map(({ name }) => name))).toHaveLength(31);
    expect(cases).toHaveLength(31);
    expect(routedTools).toEqual(manifestTools);
    expect(new Set(routedTools.map(({ name }) => name))).toHaveLength(31);

    for (const { name, domain } of manifestTools) {
      const expectedReference = `references/${domain}.md`;
      const owningCase = cases.find((testCase) => testCase.expectedTools.includes(name));
      expect(owningCase?.reference, name).toBe(expectedReference);

      for (const referenceDomain of Object.values(DOMAIN_BY_UPSTREAM)) {
        const reference = await readFile(path.join(ROOT, "skill", "references", `${referenceDomain}.md`), "utf8");
        const occurrences = reference.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
        expect(occurrences, `${name} in ${referenceDomain}.md`).toBe(referenceDomain === domain ? 1 : 0);
      }
    }
  });

  it("makes every case independently executable and rejects alternative routes", async () => {
    const cases = await parseJson<ReadonlyArray<RoutingCase>>("skill/evals/routing-cases.json");

    for (const testCase of cases) {
      expect(testCase.id).toMatch(/^[a-z0-9-]+$/);
      expect(testCase.prompt.trim().length).toBeGreaterThan(12);
      expect(testCase.expectedTools.length).toBeGreaterThan(0);
      expect(testCase.forbiddenAlternatives.length).toBeGreaterThan(0);
      expect(testCase.forbiddenAlternatives).not.toEqual(
        expect.arrayContaining(testCase.expectedTools as Array<string>),
      );
      expect(typeof testCase.clarification.required).toBe("boolean");
      expect(testCase.clarification.required ? testCase.clarification.subject : null).toBe(
        testCase.clarification.subject,
      );
      expect(typeof testCase.dateResolution.required).toBe("boolean");
    }
  });

  it("encodes the approved routing priorities and absolute-date gate", async () => {
    const cases = await parseJson<ReadonlyArray<RoutingCase>>("skill/evals/routing-cases.json");
    const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));

    expect(byId.get("docs-official-announcements")?.expectedTools).toEqual(["get_company_announcements"]);
    expect(byId.get("docs-financial-news")?.expectedTools).toEqual(["get_financial_news"]);
    expect(byId.get("stock-entity-screening")?.expectedTools).toEqual(["search_stocks"]);
    expect(byId.get("fund-screening")?.expectedTools).toEqual(["search_funds"]);
    expect(byId.get("stock-basic-info")?.forbiddenAlternatives).toContain("search_stocks");
    expect(byId.get("fund-product-info")?.forbiddenAlternatives).not.toContain("search_funds");
    expect(byId.get("stock-current-snapshot")?.expectedTools).toEqual(["get_stock_price_indicators"]);
    expect(byId.get("stock-minute-series")?.expectedTools).toEqual(["get_stock_quote"]);
    expect(byId.get("stock-kline-relative-date")?.expectedTools).toEqual(["get_stock_kline"]);
    expect(byId.get("stock-technicals")?.expectedTools).toEqual(["get_stock_technicals"]);
    expect(byId.get("economic-direct-series")?.domain).toBe("economic");
    expect(byId.get("economic-discover-and-align")?.domain).toBe("economic");
    expect(byId.get("analytics-custom-cross-entity")?.expectedTools).toEqual(["get_financial_data"]);
    expect(byId.get("analytics-custom-cross-entity")?.forbiddenAlternatives).toContain("web_search");
    expect(byId.get("stock-kline-relative-date")?.dateResolution).toEqual({
      required: true,
      start: "2026-07-01",
      end: "2026-07-31",
    });
  });

  it("uses only index K-lines for an exact-range comparison and derives endpoint return transparently", async () => {
    const cases = await parseJson<ReadonlyArray<RoutingCase>>("skill/evals/routing-cases.json");
    const testCase = cases.find(({ id }) => id === "index-kline");
    const rows = parseToolRows(await readFile(path.join(ROOT, "skill/references/index.md"), "utf8"));
    const kline = rows.get("get_index_kline");
    const technicals = rows.get("get_index_technicals");

    expect(testCase).toMatchObject({
      prompt: "比较沪深 300 和中证 500 在 2026 年上半年的日度走势和区间涨跌幅。",
      expectedTools: ["get_index_kline"],
      dateResolution: { required: false, start: "2026-01-01", end: "2026-06-30" },
      derivedResult: {
        method: "transparent-arithmetic",
        inputs: ["first-validated-close", "last-validated-close"],
        formula: "last / first - 1",
      },
      forbiddenAlternatives: ["get_index_technicals", "get_financial_data"],
    });
    expect(`${kline?.use} ${kline?.boundary}`).toMatch(/exact date-range return/i);
    expect(`${kline?.use} ${kline?.boundary}`).toMatch(/first and last validated close/i);
    expect(`${kline?.use} ${kline?.boundary}`).toMatch(/transparent arithmetic/i);
    expect(`${kline?.use} ${kline?.boundary}`).toMatch(/complete[^.]+without[^.]+technicals/i);
    expect(`${technicals?.use} ${technicals?.boundary}`).toMatch(/native rolling or derived measures/i);
  });

  it("derives free-float market cap from declared share and same-date price fields without analytics", async () => {
    const manifest = await parseJson<Manifest>("gateway/src/contracts/tool-manifest.json");
    const cases = await parseJson<ReadonlyArray<CrossToolCase>>("skill/evals/cross-tool-cases.json");
    const testCase = cases[0];
    const tools = new Map(manifest.upstreams.flatMap(({ tools: upstreamTools }) => upstreamTools).map((tool) => [tool.name, tool]));
    const stockSource = await readFile(path.join(ROOT, "skill/references/stock.md"), "utf8");
    const stockRows = parseToolRows(stockSource);
    const analyticsRows = parseToolRows(await readFile(path.join(ROOT, "skill/references/analytics.md"), "utf8"));

    expect(cases).toHaveLength(1);
    expect(testCase).toEqual({
      id: "stock-free-float-market-cap",
      prompt: "按贵州茅台和招商银行截至 2026-08-24 最新披露的自由流通股本，乘以 2026-08-24 当日最新价格，计算两家公司的自由流通市值合计。",
      domain: "stock",
      references: ["references/stock.md", "references/analytics.md"],
      primaryCoverage: false,
      expectedTools: ["get_stock_equity_holders", "get_stock_price_indicators"],
      historicalPriceTool: "get_stock_kline",
      calculation: {
        method: "transparent-arithmetic",
        formula: "sum(free-float shares * same-date price)",
        sameDateRequired: true,
      },
      forbiddenAlternatives: ["get_stock_fundamentals", "get_financial_data"],
      forbiddenAssumptions: [
        "ordinary circulating market value equals free-float market capitalization",
      ],
    });

    expect(tools.get("get_stock_equity_holders")?.description).toMatch(/自由流通股本/);
    expect(tools.get("get_stock_fundamentals")?.description).toMatch(/总市值.*流通市值/);
    expect(tools.get("get_stock_fundamentals")?.description).not.toMatch(/自由流通市值/);
    expect(tools.get("get_stock_price_indicators")?.description).toMatch(/当前时刻.*快照/);
    expect(tools.get("get_stock_kline")?.description).toMatch(/给定时间范围/);

    expect(`${stockRows.get("get_stock_equity_holders")?.use} ${stockRows.get("get_stock_equity_holders")?.boundary}`).toMatch(/free-float shares/i);
    expect(`${stockRows.get("get_stock_fundamentals")?.use} ${stockRows.get("get_stock_fundamentals")?.boundary}`).toMatch(/ordinary circulating market value[^.]+not[^.]+free-float market cap/i);
    expect(stockSource).toMatch(/same-date current price[^.]+historical date[^.]+multiply and sum transparently/i);
    expect(`${analyticsRows.get("get_financial_data")?.use} ${analyticsRows.get("get_financial_data")?.boundary}`).toMatch(/free-float market cap[^.]+transparent arithmetic/i);
  });

  it("covers six positive trigger branches and explicit out-of-scope branches", async () => {
    const cases = await parseJson<ReadonlyArray<TriggerCase>>("skill/evals/trigger-cases.json");
    const positive = cases.filter(({ shouldTrigger }) => shouldTrigger);
    const negative = cases.filter(({ shouldTrigger }) => !shouldTrigger);
    const highFrequencyTrading = cases.find(({ id }) => id === "reject-high-frequency-trading");
    const scopeGate = parseMarkdownSection(
      await readFile(path.join(ROOT, "skill/SKILL.md"), "utf8"),
      "Scope gate",
    );

    expect(new Set(positive.map(({ domain }) => domain))).toEqual(
      new Set(["stock", "fund", "index", "economic", "financial-docs", "analytics"]),
    );
    expect(negative.length).toBeGreaterThanOrEqual(6);
    expect(new Set(negative.map(({ reason }) => reason))).toEqual(
      new Set([
        "trading-write",
        "crypto",
        "japan-equity",
        "taiwan-equity",
        "korea-equity",
        "europe-equity",
        "futures-order-book",
        "service-not-in-manifest",
        "high-frequency-trading",
      ]),
    );
    expect(negative.every(({ domain }) => domain === null)).toBe(true);
    expect(highFrequencyTrading).toEqual({
      id: "reject-high-frequency-trading",
      prompt: "用 Wind 分钟行情和金融计算设计 A 股高频交易策略，并在盘中按信号持续自动调仓。",
      shouldTrigger: false,
      domain: null,
      reason: "high-frequency-trading",
      dateResolution: { required: false, start: null, end: null },
    });
    expect(scopeGate).toMatch(/high-frequency trading/i);
    expect(cases.find(({ id }) => id === "trigger-fund")?.dateResolution).toEqual({
      required: true,
      start: "2025-08-24",
      end: "2026-08-24",
    });
  });
});
