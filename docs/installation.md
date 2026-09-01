# Installation and deployment preparation

## Boundary

The Skill and gateway are separate deliverables. The Skill is runtime-neutral and contains no executable adapter, endpoint, schema copy, credential, or platform metadata. A runtime loads the Skill archive; an MCP-capable client separately connects to the deployed OAuth endpoint at `{PUBLIC_ORIGIN}/mcp`.

Creating or changing Cloudflare resources, Access/OAuth policy, public endpoints, or deployments requires explicit human approval. The commands in the deployment section are a runbook for an approved operator; installation alone does not authorize running them.

## Prerequisites

- Node.js `>=24.13.1`, matching `package.json`.
- Dependencies installed from the committed lockfile with `npm ci`; do not update dependencies as part of installation.
- For gateway deployment only: an authenticated Cloudflare account with Workers, Durable Objects, KV, and the intended Access/OIDC application already reviewed by a human.
- Owner-only private workspace files at `../.secrets/iwind.keys.env` and `../.secrets/iwind.cloudflare.env`. Keep both outside this delivery directory with mode `600`.

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
     --key-pool-layout-id ring-primary-v2
   ```

   Replace every example value. Production origins must be HTTPS. The renderer accepts both `ring-primary-v1` expand and `ring-primary-v2` activate candidates from this commit, rejects invalid inputs, and writes only ignored `dist/wrangler.deploy.jsonc`. The source configuration requires 15 Secret binding names, including `WIND_API_KEY_01` through `WIND_API_KEY_05`; list them from the source rather than copying values into this document.
3. Treat `gateway/wrangler.jsonc` → `secrets.required` as the single source of truth for required bindings. List the current names without values:

   ```bash
   node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync("gateway/wrangler.jsonc","utf8"));for(const name of c.secrets.required)console.log(name)'
   ```

4. Prepare the complete owner-only `../.secrets/iwind.cloudflare.env` file with every required binding. Do not print, copy, or pass any value as a command argument. The names-only list above is the sole public inventory; the file must remain mode `600`.
5. **For an existing Worker**, create an un-deployed candidate version from the complete file, then inspect its binding names and candidate identity without exposing values:

   ```bash
   npx --no-install wrangler versions upload \
     --config dist/wrangler.deploy.jsonc \
     --secrets-file ../.secrets/iwind.cloudflare.env
   ```

   Re-run the full verification and Secret scan, inspect `dist/wrangler.deploy.jsonc`, then inspect the **exact** candidate through the same rendered config. This fail-closed filter emits only binding names plus the non-Secret layout/stage values; it never prints values, account data, author data, or the candidate ID. Compare `secretBindingNames` with the required-names list from step 3, and confirm the expected `keyPoolLayoutId` and `deploymentStage` before cutover:

   ```bash
   npx --no-install wrangler versions view <candidate> \
     --config dist/wrangler.deploy.jsonc \
     --json |
   node -e '
   let input="";
   process.stdin.setEncoding("utf8");
   process.stdin.on("data", (chunk) => { input += chunk; });
   process.stdin.on("end", () => {
     try {
       const bindings = JSON.parse(input)?.resources?.bindings;
       if (!Array.isArray(bindings)) process.exit(1);
       const text = (name) => bindings.find((binding) => binding?.name === name && binding?.type === "plain_text")?.text;
       const summary = {
         bindingNames: bindings.map((binding) => binding?.name).filter((name) => typeof name === "string").sort(),
         secretBindingNames: bindings.filter((binding) => binding?.type === "secret_text").map((binding) => binding.name).sort(),
         keyPoolLayoutId: text("KEY_POOL_LAYOUT_ID"),
         deploymentStage: text("DEPLOYMENT_STAGE"),
       };
       if (summary.keyPoolLayoutId === undefined || summary.deploymentStage === undefined) process.exit(1);
       process.stdout.write(`${JSON.stringify(summary)}\n`);
     } catch {
       process.exit(1);
     }
   });
   '
   ```

   After a separate cutover approval, deploy that exact candidate at 100% with the same config and no percentage split:

   ```bash
   npx --no-install wrangler versions deploy <candidate>@100% \
     --config dist/wrangler.deploy.jsonc
   ```
6. **For the first Worker creation only**, make one complete approved deployment instead of uploading a partial version:

   ```bash
   npx --no-install wrangler deploy \
     --config dist/wrangler.deploy.jsonc \
     --secrets-file ../.secrets/iwind.cloudflare.env
   ```

   `wrangler secret put` creates and immediately deploys a new version. It is not a safe per-binding or complete-deployment path for this runbook.

Deployment completion requires an operator-owned check of the public HTTPS origin, OAuth authorization, one representative read-only MCP call, and the key-pool status. This project has no write or trading actions.
