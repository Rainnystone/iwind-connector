# Economic routing

Use this reference for macroeconomic, industry-level, policy, or foreign-exchange series. Clarify the indicator definition, geography, exact dates, frequency, magnitude, currency, and price/seasonal-adjustment convention whenever they change interpretation.

| Tool | Use and material choices | Boundary |
|---|---|---|
| `get_economic_data` | Direct retrieval of a described economic series with basic exact-date, frequency, magnitude, currency, and search-mode choices. | Best for a straightforward series that needs no indicator-code workflow or cross-series alignment. |
| `natural_language_get_edb_data` | Discover indicators, extract known indicator codes, or discover and extract in one request; choose the matching execution mode. Use either exact dates or an observation count, and set target frequency, magnitude, or currency only for explicit conversion or required comparability. | Not for definitions without data access; date parameters carry time intent rather than free text. |

Industry-company facts use the stock domain. Financial news about an economic topic uses the documents domain. Cross-country comparison remains economic when the economic tool can align the requested series.
