import { describe, expect, it } from "vitest";

import {
  getUpstream,
  UPSTREAMS,
  type UpstreamId,
} from "../../src/config/upstreams";

const EXPECTED_UPSTREAM_URLS: Record<UpstreamId, string> = {
  stock_data: "https://mcp.wind.com.cn/vserver_stock_data/mcp/",
  fund_data: "https://mcp.wind.com.cn/vserver_fund_data/mcp/",
  index_data: "https://mcp.wind.com.cn/vserver_index_data/mcp/",
  economic_data: "https://mcp.wind.com.cn/vserver_economic_data/mcp/",
  financial_docs: "https://mcp.wind.com.cn/vserver_financial_docs/mcp/",
  analytics_data: "https://mcp.wind.com.cn/vserver_analytics_data/mcp/",
};

const EXPECTED_UPSTREAM_TOOL_COUNTS: Record<UpstreamId, number> = {
  stock_data: 10,
  fund_data: 10,
  index_data: 6,
  economic_data: 1,
  financial_docs: 2,
  analytics_data: 1,
};

describe("Wind upstream registry", () => {
  it("registers exactly the six supported upstreams with their canonical URLs", () => {
    expect(Object.keys(UPSTREAMS).sort()).toEqual([
      "analytics_data",
      "economic_data",
      "financial_docs",
      "fund_data",
      "index_data",
      "stock_data",
    ]);
    expect(
      Object.fromEntries(
        Object.entries(UPSTREAMS).map(([id, definition]) => [
          id,
          definition.url.href,
        ]),
      ),
    ).toEqual(EXPECTED_UPSTREAM_URLS);
    expect(Object.keys(UPSTREAMS)).not.toContain("bond_data");
  });

  it("uses HTTPS, unique paths, and a total expected tool count of 30", () => {
    const definitions = Object.values(UPSTREAMS);

    expect(definitions).toHaveLength(6);
    expect(definitions.every(({ url }) => url.protocol === "https:")).toBe(true);
    expect(new Set(definitions.map(({ url }) => url.pathname)).size).toBe(6);
    expect(
      definitions.reduce((total, { expectedToolCount }) => total + expectedToolCount, 0),
    ).toBe(30);
  });

  it("assigns the exact expected tool count to each upstream", () => {
    expect(
      Object.fromEntries(
        Object.entries(UPSTREAMS).map(([id, definition]) => [
          id,
          definition.expectedToolCount,
        ]),
      ),
    ).toEqual(EXPECTED_UPSTREAM_TOOL_COUNTS);
  });

  it("returns the definition registered for an upstream ID", () => {
    expect(getUpstream("financial_docs")).toBe(UPSTREAMS.financial_docs);
  });
});
