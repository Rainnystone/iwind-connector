# Installation and deployment preparation

## Boundary

The Skill and gateway are separate deliverables. The Skill is runtime-neutral and contains no executable adapter, endpoint, schema copy, credential, or platform metadata. A runtime loads the Skill archive; an MCP-capable client separately connects to the deployed OAuth endpoint at `{PUBLIC_ORIGIN}/mcp`.

Creating or changing Cloudflare resources, Access/OAuth policy, public endpoints, or deployments requires explicit human approval. The commands in the deployment section are a runbook for an approved operator; installation alone does not authorize running them.

## Prerequisites

- Node.js `>=24.13.1`, matching `package.json`.
- Dependencies installed from the committed lockfile with `npm ci`; do not update dependencies as part of installation.
- For gateway deployment only: an authenticated Cloudflare account with Workers, Durable Objects, KV, and the intended Access/OIDC application already reviewed by a human.
- A private workspace file at `../.secrets/iwind.keys.env`. Keep it outside this delivery directory and restrict it to its owner.

## Verify and package

Run from this directory:

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run contract:verify
npm run build
npm run skill:package
npm run secret:scan -- --secrets-file '../.secrets/iwind.keys.env'
```

`npm run skill:package` always writes `dist/iwind-aifin-connector-skill.zip`. The scanner covers delivery source files and the uncompressed bytes of every entry in that archive. Stop on any non-zero result; diagnostics contain only a relative location and a stable rule ID.

## Install the Skill locally

Set an absolute directory that the chosen agent runtime documents as its Skill root, then extract the fixed package root into it:

```bash
IWIND_SKILL_ROOT=/absolute/path/to/the/runtime/skills
mkdir -p "$IWIND_SKILL_ROOT"
unzip -q dist/iwind-aifin-connector-skill.zip -d "$IWIND_SKILL_ROOT"
```

Completion is checkable: `$IWIND_SKILL_ROOT/iwind-aifin-connector/SKILL.md`, its `references/`, and its `evals/` exist, while no gateway code or platform metadata exists under that package root. Restart or refresh the runtime's Skill discovery mechanism as documented by that runtime.

For a local MCP client, continue with the [local adapter](../adapters/local/README.md). Cloud clients use the same archive and endpoint contract described in their adapter notes.

## Prepare an approved Cloudflare deployment

The checked-in `gateway/wrangler.jsonc` is the source configuration and retains safe local sentinels. Never edit it with production IDs or origins. After a human approves the target account, resource names, public origin, and Access/OAuth policy:

1. Create or select the KV namespace through the approved Cloudflare process. For an approved CLI creation, replace the namespace name and run the following without `--update-config`, so the source config keeps its sentinel:

   ```bash
   npx --no-install wrangler kv namespace create iwind-connector-oauth \
     --binding OAUTH_KV \
     --config gateway/wrangler.jsonc
   ```

   Record the returned 32-character namespace ID; do not put Secret values in this ID field.
2. Render the deploy-only config with exactly five non-Secret inputs, including the approved active layout:

   ```bash
   npm run deploy:render -- \
     --oauth-kv-id 1234567890abcdef1234567890abcdef \
     --worker-name iwind-connector-production \
     --public-origin https://iwind.example.invalid \
     --deployment-stage production \
     --key-pool-layout-id ring-primary-v1
   ```

   Replace every example value. Production origins must be HTTPS. The renderer rejects the all-zero KV sentinel, unknown stages or layouts, extra flags, and source-config writeback, and writes only ignored `dist/wrangler.deploy.jsonc`. The source configuration currently requires 13 Secret binding names, including `WIND_API_KEY_01`, `WIND_API_KEY_02`, and `WIND_API_KEY_03`; list them from the source rather than copying values into this document.
3. Treat `gateway/wrangler.jsonc` → `secrets.required` as the single source of truth for required bindings. List the current names without values:

   ```bash
   node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync("gateway/wrangler.jsonc","utf8"));for(const name of c.secrets.required)console.log(name)'
   ```

4. For each listed name, use Wrangler's interactive prompt so the value never appears in command arguments:

   ```bash
   npx --no-install wrangler secret put NAME_FROM_REQUIRED_LIST --config dist/wrangler.deploy.jsonc
   ```

5. Re-run the full verification and Secret scan. Inspect `dist/wrangler.deploy.jsonc`; it may contain only the approved Worker name, KV ID, public origin, and stage changes.
6. Only after separate human approval to deploy, run `npx --no-install wrangler deploy --config dist/wrangler.deploy.jsonc`. This repository's `npm run build` remains a dry run and is safe for the pre-deploy gate.

Deployment completion requires an operator-owned check of the public HTTPS origin, OAuth authorization, one representative read-only MCP call, and the key-pool status. This project has no write or trading actions.
