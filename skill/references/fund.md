# Fund routing

First distinguish a fund product from its management company, and an exchange-traded ETF/LOF price from an off-exchange fund net asset value. A known fund skips discovery.

| Tool | Use and material choices | Boundary |
|---|---|---|
| `get_fund_company_info` | Management-company identity, team, assets under management, rankings, or company-level allocation; identify the fund that points to the manager. | Manager facts, not product facts. |
| `get_fund_financials` | Fund profit, income, expenses, report-period net assets, or distributions; state the report period and accounting item. | Financial statements and distributions, not net asset value history or performance. |
| `get_fund_holders` | Units, size changes, holder composition, holder count, subscriptions, or redemptions; state the reporting period. | Ownership and scale, not portfolio holdings. |
| `get_fund_holdings` | Asset allocation, heavy positions, industry allocation, concentration, portfolio valuation, or turnover; state the disclosure period and classification convention. | Portfolio-level holdings; query an underlying security in its own domain for security detail. |
| `get_fund_info` | Product code/name, type, style, benchmark, risk level, fees, manager tenure, lifecycle, operating status, custodian, or tracked index. | Static or quasi-static product profile, not size, performance, or holdings. |
| `get_fund_kline` | Aggregated exchange price series for an ETF/LOF over exact dates; choose the exposed period and settle adjustment and suspension treatment when material. | Not available for off-exchange price history; use net asset value performance there. |
| `get_fund_performance` | Net asset value, returns, rankings, Alpha/Beta/Sharpe, drawdown, volatility, tracking error, ratings, style, or ETF/LOF evaluation measures; specify the exact window and metric convention. | Off-exchange fund price questions route here as net asset value, not to quote or snapshot tools. |
| `get_fund_price_indicators` | Current exchange snapshot for one or more known ETFs/LOFs, including exposed price, flow, net asset value, or IOPV fields. | Exchange snapshot only; not an off-exchange net asset value series. |
| `get_fund_quote` | Minute-by-minute exchange price series for a known ETF/LOF over exact dates. | Not for off-exchange funds or long aggregated ranges. |
| `search_funds` | Discover or filter products by classification, manager, benchmark, performance, scale, fees, or holdings characteristics. | Skip when the fund is known; output is a product list, not custom analytics. |

Fund announcements use the documents reference. Underlying stock or index attributes use the corresponding entity reference only when the request actually asks for those attributes.
