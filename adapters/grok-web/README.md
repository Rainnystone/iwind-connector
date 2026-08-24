# Grok Web adapter

This is a thin installation note, not a platform-specific Skill fork. Its complete contract is:

1. Generate and upload the same [`dist/iwind-aifin-connector-skill.zip`](../../dist/iwind-aifin-connector-skill.zip) used by every adapter.
2. Register the same OAuth MCP endpoint concept: `{PUBLIC_ORIGIN}/mcp`.
3. Complete the OAuth authorization and consent flow for the approved identity.

Use Grok Web's current product documentation for the UI route and field labels. Do not alter the archive, add platform metadata, paste credentials into configuration fields, or substitute an upstream Wind URL for the gateway endpoint.

This engineering thread has **not** tested these steps in a Grok Web account. The platform UI, upload acceptance, registration flow, and authorization completion remain an operator verification item. The shared preflight is in [installation](../../docs/installation.md).
