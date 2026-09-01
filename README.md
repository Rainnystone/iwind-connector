# iWind AIFin Connector

English | [中文](README.zh-CN.md)

A self-hosted, read-only bridge between Wind financial-data MCP services and AI agents such as ChatGPT Work, Grok Web, Codex, and other MCP-capable clients.

This repository is not a hosted data service and does not include Wind access. You bring your own Wind entitlement and API keys, deploy the gateway to your own Cloudflare account, and connect your agent to the resulting OAuth MCP endpoint.

## Why this project exists

Wind exposes useful financial data through multiple MCP services. Configuring every service and every API key separately in every agent is difficult to maintain, especially when a key reaches its quota.

iWind AIFin Connector provides one stable, OAuth-protected MCP endpoint and one runtime-neutral Skill:

```text
ChatGPT Work / Grok Web / local agent
              │
              ├── Skill: intent routing, data-quality checks, fail-closed rules
              │
              └── OAuth MCP connection
                         │
                         ▼
               Cloudflare Worker gateway
               ├── OAuth and access control
               ├── 31-tool read-only manifest
               ├── serial ordered key pool (active primary ring: five slots)
               └── sanitized operations notices
                         │
                         ▼
                  Six Wind MCP services
```

The Cloudflare Plugin described below is a setup and maintenance assistant. It can help an agent create or inspect Cloudflare resources, but it is not part of the production Wind-query data path.

## What it can do

| Capability | What it means |
| --- | --- |
| One MCP endpoint | Clients connect to one deployed `{PUBLIC_ORIGIN}/mcp` instead of six Wind endpoints. |
| 31 read-only tools | Stock, fund, index, economic, announcement/news, and supported financial-analysis queries. |
| Runtime-neutral Skill | The same Skill zip provides tool routing, identity validation, serial execution, result checks, and human-readable notices across supported agents. |
| OAuth protection | Wind keys stay behind the gateway. Clients authenticate to the gateway rather than receiving Wind credentials. |
| Quota-aware key rotation | The active primary generation uses `key-05 → key-04 → key-03 → key-02 → key-01`. A persisted cursor keeps the active slot stable and advances only on approved failover events. |
| Strict serialization | At most one Wind request is active in the private key pool at a time. Additional keys increase failover capacity, not parallel throughput. |
| Fail-closed behavior | Missing tools, ambiguous security identities, unsupported markets, and failed requests stop instead of being replaced with guessed or web-sourced data. |
| Reproducible delivery | Tests, a deterministic 11-file Skill archive, clean-room verification, and exact-value Secret scanning protect the release process. |

### Integrated Wind domains

| Domain | Tools | Typical use |
| --- | ---: | --- |
| Stocks | 10 | Identity, snapshots, minute data, K-lines, fundamentals, holders, events, technicals, screening, and risk. |
| Funds and ETFs | 10 | Identity, prices, NAV, holdings, holders, managers, size, financials, and performance. |
| Indexes | 6 | Identity, snapshots, point series, K-lines, valuation, and technical indicators. |
| Economic data | 2 | Macroeconomic, industry, and foreign-exchange series. |
| Financial documents | 2 | Listed-company announcements and financial news. |
| Analytics | 1 | Supported custom financial calculations that predefined tools cannot express. |

The gateway does not expose trading or write actions.

## How key rotation works

The stable catalog contains `key-01` through `key-05`. The active primary layout `ring-primary-v2` orders a new pool `key-05 → key-04 → key-03 → key-02 → key-01`; its KeyPool persists a cursor that identifies the current slot. The prior `key-01 → key-02` pool remains a legacy generation for rollback compatibility and OAuth replay, not for new business calls.

This repository's primary-layout revision is awaiting merge. The currently deployed Cloudflare production environment remains on the legacy two-slot generation until a separately approved cutover; this documentation does not claim that cutover is complete.

1. A new primary v2 pool starts on `key-05`; ordinary success keeps the cursor there, so requests do not alternate between keys.
2. Exact daily-quota, balance, authentication, or operator-disable events move the cursor to the next declared slot: `key-05 → key-04 → key-03 → key-02 → key-01 → key-05`. Balance, authentication, and manual-disable states remain unavailable until explicitly restored.
3. Each logical invocation can acquire every eligible slot at most once. If that bounded pass is exhausted, the call stops; a later independent invocation starts a new bounded pass from the persisted cursor.
4. A trusted future `reset_at` keeps a daily-exhausted slot unavailable until its reset. When no trusted reset is supplied, the slot remains eligible for a later wrap-around probe instead of requiring a guessed reset time or manual restore.
5. QPS cooldown, concurrency errors, timeouts, network failures, oversized responses, upstream 5xx responses, and unknown errors do not move the cursor or burn through the pool.
6. The agent receives a sanitized notice when rotation occurred, failed, or the pool is unavailable. Key values and raw infrastructure details are never included.

This is event-driven ring failover, not per-request round-robin load balancing and not a way to bypass Wind account or contract limits. Only use keys you are legally allowed to pool under your Wind agreement.

`gateway/src/key-pool/slots.ts` is the single non-Secret catalog, layout, and generation declaration. Slot identity and binding are stable; priority is runtime topology derived from the persisted layout, not identity or global number sorting. An ordinary future expansion appends only new catalog bindings, then defines an approved successor block that is inserted immediately before the **actual persisted cursor** and becomes the new cursor; it preserves the old effective ring order. Replacement updates the same binding and restores the same slot. Reorder, deletion, rename, or any layout that is not a cursor-relative successor block requires a new generation and blue-green cutover. The release never discovers undeclared Secrets automatically. The MCP endpoint, 31-tool manifest, OAuth flow, administration URL shape, and Skill package remain unchanged.

An ordinary future append is deliberately two-stage: deploy an **expand candidate** that recognizes the new catalog entry, Secret binding, and candidate layout while keeping the active layout unchanged; then deploy an **activate candidate** that switches to that prefix-compatible layout. After activation, rollback may target only the expand candidate (or a newer revision) that recognizes the activated layout. See [operations](docs/operations.md) for the complete runbook.

## Prerequisites

You need:

- A Wind AIFin account or entitlement that can use the integrated MCP services.
- Five Wind API keys for the repository's active primary layout. The keys must never be committed to this repository.
- A Cloudflare account with Workers, KV, Durable Objects, Cron Triggers, and an approved Access/OIDC application.
- Git, npm, and Node.js `>=24.13.1`.
- An MCP-capable agent or client for using the deployed service.

Cloudflare, Wind, identity-provider, and AI-platform charges or limits are controlled by those services and are not included with this repository.

## Recommended: install the Cloudflare Plugin first

If you want ChatGPT or Codex to help provision and maintain the Cloudflare resources, install the official Cloudflare Plugin before starting deployment:

1. Open the [OpenAI Plugin directory](https://developers.openai.com/plugins), search for **Cloudflare**, install it, and complete Cloudflare OAuth.
2. Review the requested Cloudflare permissions before approving them.
3. Ask the agent to read this repository's [installation runbook](docs/installation.md) and [security boundary](docs/security.md) before it changes any resource.

The reusable Cloudflare Skills are also published in the Apache-2.0 licensed [cloudflare/skills](https://github.com/cloudflare/skills) repository:

```bash
npx skills add https://github.com/cloudflare/skills
```

The OpenAI-distributed package structure is visible in [openai/plugins › cloudflare](https://github.com/openai/plugins/tree/main/plugins/cloudflare). These open repositories contain the Plugin/Skill instructions and connection packaging. The hosted Cloudflare API MCP service they connect to is a separate remote service; do not assume its server implementation is included in either repository.

Installing this Plugin is recommended for agent-guided setup, but the deployed iWind gateway does not depend on the Plugin at runtime. A qualified operator can follow the Wrangler runbook directly.

## Quick start

### 1. Clone the repository

```bash
git clone https://github.com/Rainnystone/iwind-connector.git
cd iwind-connector
npm ci
```

### 2. Prepare private Wind keys

Create a private env file outside the repository. This project's local convention is `../.secrets/iwind.keys.env`:

```dotenv
WIND_API_KEY_01=replace-with-your-first-key
WIND_API_KEY_02=replace-with-your-second-key
WIND_API_KEY_03=replace-with-your-third-key
WIND_API_KEY_04=replace-with-your-fourth-key
WIND_API_KEY_05=replace-with-your-fifth-key
```

Restrict the file to its owner. Do not paste real values into source files, Markdown, chat messages, screenshots, command arguments, or deployment JSON.

Cloudflare deployment also requires the Secret binding names listed in `gateway/wrangler.jsonc` under `secrets.required`. Supply their values through approved protected input; never replace the checked-in safe sentinels with production values.

For an approved deployment, use the complete owner-only Cloudflare Secret file described in [installation](docs/installation.md): an existing Worker receives an un-deployed `versions upload` candidate, exact `versions view <candidate> --config dist/wrangler.deploy.jsonc --json` names-only inspection, then an explicit exact `@100%` deployment with that same rendered config; first creation uses one complete `deploy --secrets-file`. Do not use per-binding `secret put`, because it immediately deploys a version.

### 3. Verify the checkout

Run from the repository root:

```bash
npm test
npm run typecheck
npm run lint
npm run contract:verify
npm run build
```

`npm run build` is a Wrangler dry run; it does not deploy. It may clear the shared `dist/` directory, so always package the Skill after the build:

```bash
npm run skill:package
npm run secret:scan -- --secrets-file '../.secrets/iwind.keys.env'
```

The generated archive is:

```text
dist/iwind-aifin-connector-skill.zip
```

### 4. Deploy the gateway to your Cloudflare account

Follow [docs/installation.md](docs/installation.md) exactly. It explains how to:

- create or select the OAuth KV namespace;
- render a deploy-only Wrangler config without changing source sentinels;
- supply all required Secrets through protected input;
- review the Worker, Durable Object, KV, cron, origin, and OAuth configuration;
- perform a dry run before the separately approved deployment;
- verify OAuth, 31 read-only tools, one representative query, and key-pool status.

If an agent is helping, a safe starter request is:

> Read `README.md`, `docs/installation.md`, and `docs/security.md`. Explain the Cloudflare resources and Secret bindings I need. Do not create, modify, or deploy anything until you show me the exact plan and I approve it.

Deployment mutates external infrastructure. Review the target Cloudflare account, resource names, OAuth policy, public origin, and estimated service costs before approving it.

### 5. Connect an agent

Use the same Skill archive and the same deployed OAuth MCP endpoint everywhere:

- [ChatGPT Work](adapters/chatgpt-work/README.md): register the deployed `/mcp` URL as an OAuth custom Plugin, then upload the Skill zip as a separate item.
- [Grok Web](adapters/grok-web/README.md): register the OAuth MCP connector and install the same Skill archive according to the current product UI.
- [Local clients](adapters/local/README.md): install the Skill archive and adapt the provided MCP configuration example.

The Skill does not install or authenticate the MCP connection, and the MCP connection does not automatically install the Skill. Cloud runtimes require both steps.

### 6. Run a read-only smoke test

Start with a known canonical Wind code and a simple snapshot request. Confirm that:

- the client uses the iWind MCP rather than Web Search;
- the selected tool matches the requested data type;
- calls are serial;
- the response preserves dates, units, nulls, and coverage;
- ordinary success has no operations warning;
- no credential or raw diagnostic appears in the answer.

For a company name or uncertain code, the Skill should first search the identity, validate the company, canonical Wind code, and market, and only then call a property or price tool.

## Operations and maintenance

- [Operations](docs/operations.md): inspect the pool, replace/add/disable/restore a key, or refresh the Wind schema snapshot.
- [Troubleshooting](docs/troubleshooting.md): interpret stable OAuth, gateway, key-pool, and Wind error codes.
- [Security](docs/security.md): Secret handling, logging allowlist, package scanning, and release gates.
- [Acceptance checklist](docs/acceptance-checklist.md): the full verified release boundary and remaining platform-specific checks.

Do not change key-pool size, rotation semantics, OAuth policy, public endpoints, tool schemas, or read-only scope as an operations shortcut. Those are architecture changes and require implementation and review.

## Repository layout

```text
skill/                 Runtime-neutral Agent Skill, references, and evals
gateway/               Cloudflare Worker OAuth MCP gateway
adapters/              ChatGPT Work, Grok Web, and local installation notes
scripts/               Packaging, verification, Secret scanning, and deploy rendering
docs/                  Installation, operations, security, troubleshooting, and acceptance
dist/                  Generated and ignored release artifacts
```

The Skill package contains only `SKILL.md`, `references/*.md`, and `evals/*.json` under a fixed `iwind-aifin-connector/` root. It contains no endpoint, Wind key, OAuth credential, gateway code, platform metadata, or copied tool schema.

## Verification status

The repository has automated unit, integration, MCP/OAuth, five-slot cursor-relative rotation, serialization, packaging, Secret-scan, and dry-run build coverage. Historical production evidence must not be treated as evidence that this v0.6 `ring-primary-v2` layout has been deployed; Cloudflare rollout requires separate approval.

ChatGPT Work custom-Plugin registration, OAuth, tool discovery, and a representative query have been verified. Final Skill upload, automatic Skill invocation, and scheduled-task behavior remain account-level acceptance steps. The Grok Web adapter is provided but has not yet been verified in a real Grok account. See the [acceptance checklist](docs/acceptance-checklist.md) for the current boundary.

## Repository licensing and data access

The delivery repository's code and documentation are Secret-free and designed to be auditable. That does not make any deployed gateway a public data service, and it does not include, grant, or authorize redistribution of Wind data access. Every operator must use their own Cloudflare account, identity configuration, Wind entitlement, and private API keys.

This repository currently has no `LICENSE` file. Source availability or access alone does not grant a general open-source reuse license, so the project should not be described as licensed open source unless and until a license is added. Choose and add an appropriate license before encouraging redistribution or third-party contributions.

If you fork, deploy, or redistribute this project:

- never commit credentials, OAuth artifacts, account identifiers, private deployment records, temporary callback URLs, or business responses;
- run the full verification, deterministic packaging, and exact-value Secret scan against your own private key file;
- review your Wind agreement before redistributing generated contract information or offering a service to other people;
- keep the gateway read-only unless a different security boundary has been deliberately designed, authorized, implemented, and reviewed.

Wind and iWind product names belong to their respective owner. This is an independent integration project and is not affiliated with or endorsed by Wind. It does not provide, resell, or grant access to Wind data.
