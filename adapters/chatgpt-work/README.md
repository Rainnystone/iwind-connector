# ChatGPT Work adapter

This is a thin installation note, not a platform-specific Skill fork. ChatGPT Work installs the MCP provider and the Skill as two separate items:

1. In Plugins developer mode, create `iWind AIFin Connector` with connection type **Server URL**, set the production value of `{PUBLIC_ORIGIN}/mcp` as the server URL, and select **OAuth**. Keep the automatically discovered OAuth settings, acknowledge the custom-MCP warning, create the Plugin, and complete consent for the approved identity.
2. Generate and upload the same [`dist/iwind-aifin-connector-skill.zip`](../../dist/iwind-aifin-connector-skill.zip) used by every adapter. The Skill supplies routing and fail-closed behavior; it does not install or authenticate the Plugin.

On 2026-08-27, the personal Pro developer-mode Plugin registration, OAuth consent, discovery of exactly 31 read-only tools, and one representative serial stock call were verified. Skill upload, automatic Skill invocation, combined Skill-plus-Plugin behavior after upload, and scheduled-task behavior are not yet verified and remain operator acceptance items.

Do not alter the archive, add `agents/openai.yaml`, paste credentials into configuration fields, override discovered OAuth settings, or substitute an upstream Wind URL for the gateway endpoint. The shared preflight is in [installation](../../docs/installation.md).
