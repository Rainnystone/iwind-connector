import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface Manifest {
  readonly upstreams: ReadonlyArray<{
    readonly id: string;
    readonly tools: ReadonlyArray<{ readonly name: string }>;
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

  it("covers six positive trigger branches and explicit out-of-scope branches", async () => {
    const cases = await parseJson<ReadonlyArray<TriggerCase>>("skill/evals/trigger-cases.json");
    const positive = cases.filter(({ shouldTrigger }) => shouldTrigger);
    const negative = cases.filter(({ shouldTrigger }) => !shouldTrigger);

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
      ]),
    );
    expect(negative.every(({ domain }) => domain === null)).toBe(true);
    expect(cases.find(({ id }) => id === "trigger-fund")?.dateResolution).toEqual({
      required: true,
      start: "2025-08-24",
      end: "2026-08-24",
    });
  });
});
