import type { UpstreamId } from "./domain";

export const SOURCE_COMMIT = "f9e3d4d066f11152a1519559d12f388a75b44410" as const;

export const TOOL_SEED = {
  stock_data: [
    "get_stock_price_indicators",
    "get_risk_metrics",
    "get_stock_events",
    "get_stock_kline",
    "get_stock_basicinfo",
    "get_stock_equity_holders",
    "get_stock_fundamentals",
    "get_stock_quote",
    "get_stock_technicals",
    "search_stocks",
  ],
  fund_data: [
    "get_fund_price_indicators",
    "get_fund_kline",
    "get_fund_financials",
    "get_fund_holdings",
    "get_fund_company_info",
    "get_fund_quote",
    "get_fund_info",
    "get_fund_holders",
    "get_fund_performance",
    "search_funds",
  ],
  index_data: [
    "get_index_technicals",
    "get_index_quote",
    "get_index_kline",
    "get_index_fundamentals",
    "get_index_price_indicators",
    "get_index_basicinfo",
  ],
  economic_data: ["get_economic_data", "natural_language_get_edb_data"],
  financial_docs: ["get_company_announcements", "get_financial_news"],
  analytics_data: ["get_financial_data"],
} as const satisfies Readonly<Record<UpstreamId, readonly string[]>>;
