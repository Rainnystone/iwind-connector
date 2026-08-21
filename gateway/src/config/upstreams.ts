import type { UpstreamDefinition, UpstreamId } from "../contracts/domain";

export type { UpstreamDefinition, UpstreamId } from "../contracts/domain";

export const UPSTREAMS: Readonly<Record<UpstreamId, UpstreamDefinition>> = {
  stock_data: {
    id: "stock_data",
    url: new URL("https://mcp.wind.com.cn/vserver_stock_data/mcp/"),
    expectedToolCount: 10,
  },
  fund_data: {
    id: "fund_data",
    url: new URL("https://mcp.wind.com.cn/vserver_fund_data/mcp/"),
    expectedToolCount: 10,
  },
  index_data: {
    id: "index_data",
    url: new URL("https://mcp.wind.com.cn/vserver_index_data/mcp/"),
    expectedToolCount: 6,
  },
  economic_data: {
    id: "economic_data",
    url: new URL("https://mcp.wind.com.cn/vserver_economic_data/mcp/"),
    expectedToolCount: 1,
  },
  financial_docs: {
    id: "financial_docs",
    url: new URL("https://mcp.wind.com.cn/vserver_financial_docs/mcp/"),
    expectedToolCount: 2,
  },
  analytics_data: {
    id: "analytics_data",
    url: new URL("https://mcp.wind.com.cn/vserver_analytics_data/mcp/"),
    expectedToolCount: 1,
  },
};

export function getUpstream(id: UpstreamId): UpstreamDefinition {
  return UPSTREAMS[id];
}
