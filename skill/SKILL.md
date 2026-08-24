---
name: iwind-aifin-connector
description: Use when a user needs Wind data for stocks, funds, indexes, macroeconomic, industry or foreign-exchange series, company announcements or financial news, or supported financial calculations.
---

# iWind AIFin Connector

## Scope gate

Use the Skill for read-only data about supported mainland China, Hong Kong, and US stocks; funds; indexes; macroeconomic, industry, and foreign-exchange series; company announcements and financial news; and supported financial calculations.

High-frequency trading, including strategy design or operation, and other trading or write actions, crypto assets, Taiwan, Japan, Korea, or Europe equities, futures order books, and any service absent from the manifest are out of scope. For anything out of scope, say so; neither Web Search nor analytics is a substitute.

## Workflow

1. Resolve the entity and market. Clarify any material metric, adjustment, frequency, currency, or reporting-period ambiguity. Convert every relative time expression to exact dates before calling a tool. This step is complete when the request has one checkable identity, scope, date range, and metric interpretation.
2. Read only the applicable domain reference; if the request genuinely spans domains, add only the references required for those branches:
   - For stock identity, screening, prices, fundamentals, holders, events, technicals, or risk, read [stock](references/stock.md).
   - For fund products, managers, holders, holdings, financials, performance, net asset value, or exchange prices, read [fund](references/fund.md).
   - For index identity, valuation, point series, snapshots, or technicals, read [index](references/index.md).
   - For macroeconomic, industry, or foreign-exchange series, read [economic](references/economic.md).
   - For official company announcements or financial news, read [financial-docs](references/financial-docs.md).
   - For a supported custom financial calculation that no predefined tool can express, read [analytics](references/analytics.md).
3. Choose the least sufficient native tool sequence. A known entity skips discovery; a filter for unknown entities starts with the domain search tool. This step is complete when every selected tool contributes a required result and no predefined tool was replaced by a generic calculation.
4. Call tools strictly one at a time: one tool call completes before the next begins. Carry forward only validated outputs needed by the following call.
5. Check the result's date, unit, magnitude, nulls, row count, truncation/completeness, and requested coverage. Treat a non-trading-day empty series as empty only when the tool completed successfully and its date semantics explain it.
6. Inspect the final `IWIND_OPS_NOTICE_V1` block. A failure is not empty data and never supports a data claim.
7. Answer the data first. Add exactly one operations sentence only when the final notice requires one; normal success has no operations sentence.

## Final notice sentences

- `WIND_KEY_ROTATED` with `succeeded`: 服务发生明确错误，系统已完成自动轮换，本次查询成功。
- `WIND_KEY_ROTATION_FAILED`: 本次查询未完成：服务发生明确错误后尝试自动轮换，但轮换未能完成查询。
- `KEY_POOL_EXHAUSTED`: 本次查询未完成：服务当前没有可用访问能力，请补充、替换或恢复服务配置后重试。
- `GATEWAY_BUSY`: 本次查询未完成：服务正忙，请稍后重试；本次未执行自动轮换。
- `WIND_REQUEST_FAILED`: 本次查询未完成：服务请求失败，本次未执行自动轮换。

Use only the sentence selected by the final code and status. Do not expose request identifiers, raw diagnostics, or access-infrastructure terms.
