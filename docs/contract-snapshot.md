# Wind MCP contract snapshot

Captured at: `2026-08-21T09:31:23.782Z`

Source seed commit: `f9e3d4d066f11152a1519559d12f388a75b44410`

All six endpoints initialized over Streamable HTTP with protocol auto negotiation. The snapshot contains 31 unique read-only query tools. No response payload or credential is retained. The sourceCommit field records the official static seed as a provenance baseline; the approved live-only addition `get_economic_data` comes from this authenticated capture and is not claimed to exist in that baseline.

## Upstream counts

- `stock_data`: 10 tools
- `fund_data`: 10 tools
- `index_data`: 6 tools
- `economic_data`: 2 tools
- `financial_docs`: 2 tools
- `analytics_data`: 1 tools

## Known limitations

This is an explicit point-in-time contract. Upstream descriptions and JSON Schemas may drift and must be re-probed and reviewed before updating the snapshot. Representative calls prove only the six recorded read-only paths, not every valid input or vendor data condition.
