# Local MCP adapter

Use the same generated [`dist/iwind-aifin-connector-skill.zip`](../../dist/iwind-aifin-connector-skill.zip) and the same OAuth MCP endpoint concept, `{PUBLIC_ORIGIN}/mcp`, as the cloud adapters.

1. Follow the [local Skill installation](../../docs/installation.md#install-the-skill-locally).
2. Copy [`mcp.example.json`](mcp.example.json) into the MCP configuration surface documented by the chosen local client.
3. Replace `https://runtime-configuration.invalid/mcp` with the approved deployed `{PUBLIC_ORIGIN}/mcp`. The example domain is intentionally non-routable and cannot be used as-is.
4. Start the client and complete its OAuth authorization and consent flow. Do not add Wind credentials to local MCP configuration; the gateway owns them.

Client-specific configuration locations and field names are outside the runtime-neutral core. Confirm the chosen client's current documentation rather than changing the shared Skill archive.
