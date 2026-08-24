# Financial document routing

Choose by source authority: issuer or exchange disclosure is an official announcement; third-party reporting is financial news. Put entity/topic and exact date bounds in the query.

| Tool | Use and material choices | Boundary |
|---|---|---|
| `get_company_announcements` | Official disclosure text such as annual/quarterly reports, dividend notices, or prospectuses; set `top_k` from 1 to 20 with the narrowest useful query. | Structured event fields belong to the entity tool. A capped result is not proof of completeness; disclose the cap and narrow or paginate the question when full coverage matters. |
| `get_financial_news` | Third-party financial news by topic, event, entity, industry, and exact date range; set `top_k` from 1 to 20. | Issuer announcements and broker research are not news results; structured quoted values must be verified in the relevant data domain. |

When the user asks for both a disclosure and its structured effect, read the stock or fund reference only after the document call completes, then make the second call serially.
