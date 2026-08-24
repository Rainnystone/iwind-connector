# Stock routing

Use this reference only after the scope gate admits the stock market. A known company or code goes directly to its property tool; entity discovery or conditional screening uses the search tool first.

| Tool | Use and material choices | Boundary |
|---|---|---|
| `get_risk_metrics` | Beta, alpha, volatility, Sharpe ratio, maximum drawdown, VaR, financial-safety ratios, or benchmark correlation; include the entity, exact window, benchmark, and requested risk convention. | Risk statistics, not chart technicals or raw prices. |
| `get_stock_basicinfo` | Current identity, listing board/date, industry, concepts, business profile, registration facts, or current status; identify the company or code. | Current/static profile, not status history, financials, or holders. |
| `get_stock_equity_holders` | Share capital, free-float shares, top holders, institutional holdings, controller, or unlock schedule; state the report period. | Holder and capital structure, not market value or fund holders. |
| `get_stock_events` | Structured dividends, financing, restructuring, ownership changes, unlocks, risk-warning changes, penalties, or litigation; give an exact range and event type. | Structured event fields; official disclosure text belongs to the documents domain. |
| `get_stock_fundamentals` | Statements, financial ratios, industry-specific fundamentals, valuation, dividend yield, or market value; distinguish report period from trading date and state the metric convention. | Ordinary circulating market value is not free-float market cap. No price series, technical signals, or holder detail. |
| `get_stock_kline` | Aggregated OHLCV for an exact range; choose the exposed period and settle adjustment and suspension treatment when material. | Use minute series for an intraday path and technicals for rolling returns or signals. |
| `get_stock_price_indicators` | Current snapshot for one or more known stocks; request only exposed snapshot fields. | A point-in-time cross-section, not a minute or historical series. |
| `get_stock_quote` | Minute-by-minute price and volume for a known stock; pass exact begin/end dates and keep long ranges bounded. | A minute series, not a current snapshot or aggregated long-window chart. |
| `get_stock_technicals` | Rolling returns, highs/lows, benchmark-relative performance, MACD, KDJ, RSI, BOLL, moving averages, or technical patterns; give the anchor date/window. | Derived technicals, not raw series or risk statistics. |
| `search_stocks` | Discover or filter supported stocks by market, industry, concept, price, valuation, financial, fund-flow, or technical conditions. | Skip when the entity is already known; output is an entity list, not computed analytics. |

For free-float market cap, take free-float shares from the holders row, pair them with the same-date current price from the snapshot row or the close from the K-line row for a historical date, then multiply and sum transparently.

Official announcements and financial news use the documents reference. A request outside the admitted stock markets remains out of scope even if a code-like string is supplied.
