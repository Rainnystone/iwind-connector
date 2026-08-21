export type UpstreamId =
  | "stock_data"
  | "fund_data"
  | "index_data"
  | "economic_data"
  | "financial_docs"
  | "analytics_data";

export interface UpstreamDefinition {
  readonly id: UpstreamId;
  readonly url: URL;
  readonly expectedToolCount: number;
}
