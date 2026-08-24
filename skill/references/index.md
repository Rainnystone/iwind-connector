# Index routing

Use this reference for a named supported index or code. Keep index-level weighted measures distinct from constituent-level facts and from custom aggregation.

| Tool | Use and material choices | Boundary |
|---|---|---|
| `get_index_basicinfo` | Name, publisher, base date/value, methodology, classification, constituents, constituent count, or tracked funds; identify the index. | Static or quasi-static profile, not constituent financial detail. |
| `get_index_fundamentals` | Predefined weighted fundamentals or valuation such as PE, PB, dividend yield, or weighted financial measures; distinguish report period from trading date. | No temporary custom aggregation; constituent facts belong to the stock domain. |
| `get_index_kline` | Aggregated index point series over exact dates; choose the exposed period. For an exact date-range return, use the first and last validated close and calculate it as transparent arithmetic. | This completes the requested path without adding technicals. Use minute series for an intraday path. |
| `get_index_price_indicators` | Current point-in-time snapshot for one or more known indexes; request only exposed fields. | Snapshot only, not a historical or minute series. |
| `get_index_quote` | Minute-by-minute point series for a known index over exact dates; bound long ranges. | Minute series, not current snapshot or aggregated history. |
| `get_index_technicals` | Native rolling or derived measures such as moving measures, volatility, trend, momentum, MFI, support/resistance, or other technicals; give the anchor date/window. | Derived measures, not raw points, exact-range endpoint returns, or stock risk metrics. |

Use the stock or fund reference only for a requested constituent or tracker attribute. Use analytics only when no predefined index measure expresses the custom result.
