# Security boundary

## Trust boundary

The packaged Skill is public-instruction material: it contains no endpoint, executable code, platform adapter, tool schema copy, credential, or gateway state. The gateway is the enforcement boundary for OAuth, the read-only manifest, serial Key leasing, deterministic failure classification, bounded responses, and log reduction. Wind and the identity provider are external systems; their free-form messages are not trusted control signals.

The supported action surface is read-only data retrieval. Write and trading actions are outside scope. Upstream calls are strictly serial within the private primary ring `key-03 → key-02 → key-01`; additional bindings add failover capacity, never parallelism or per-request round-robin. Only exact allowlisted quota, balance, or authentication signals may change slots; QPS, concurrency, network, timeout, 5xx, and unknown failures stay on the same slot or stop.

## Secret handling

- Keep private local values in `../.secrets/iwind.keys.env` and the complete Cloudflare candidate file in `../.secrets/iwind.cloudflare.env`, outside this delivery directory with mode `600`. Cloudflare receives the complete file only during an approved candidate upload or first creation.
- Pass only the Secret file path to `npm run secret:scan -- --secrets-file …`. The scanner reads values for exact byte comparison and emits only relative locations and stable rule IDs.
- For an existing Worker, use complete-file `wrangler versions upload --config dist/wrangler.deploy.jsonc --secrets-file …`, inspect the exact candidate through `versions view <candidate> --config dist/wrangler.deploy.jsonc --json` and the names-only filter in [installation](installation.md), then explicitly deploy it at `@100%` with the same config; never percentage-split a KeyPool deployment. First creation uses one complete `wrangler deploy --config dist/wrangler.deploy.jsonc --secrets-file …`. `wrangler secret put` creates and immediately deploys a version, so it is not part of this runbook. Secret values do not belong in command arguments, source/config files, tests, fixtures, Markdown, chat, screenshots, deployment JSON, zip archives, or logs.
- The current required-binding set has 13 names. `WIND_API_KEY_03` is only a binding name; it never authorizes documenting or exposing the corresponding value.
- `gateway/.dev.vars.example` contains local sentinels only. Real `.dev.vars`, `.dev.vars.*` other than the example, and `.secrets/` paths fail the scanner.
- Treat generated archives as untrusted until both deterministic packaging tests and the Secret scan pass.

The scanner fails on credential-shaped tokens, long Bearer values, private-key PEM headers, forbidden Secret paths, and exact values loaded from the caller-supplied env file. It scans ordinary delivery files and the uncompressed bytes of every Skill zip entry. Read, traversal, symlink, or malformed-archive errors fail closed.

## Log allowlist

Gateway invocation logs contain exactly these fields:

- `requestId`
- `domain`
- `toolName`
- `slotId`
- `status`
- `durationMs`
- `responseBytes`
- `noticeCode`

Do not add request arguments, response bodies, raw error text, headers, cookies, authorization codes, tokens, emails, Key values/fragments, or vendor envelopes. Model-visible operations notices are independently limited to `schemaVersion`, `code`, `initialCategory`, `finalStatus`, and `requestId`.

## Release gate

Before distributing a Skill archive or deploying an approved gateway revision:

1. Run the full test, typecheck, lint, contract verification, and dry-run build gates.
2. Package twice and confirm identical SHA-256 hashes.
3. Run the exact-value Secret scan against the private env path.
4. Confirm the archive has the fixed root and only `SKILL.md`, `references/*.md`, and `evals/*.json` with no absolute or traversal path.
5. Review the deploy config and diff for credentials, unexpected endpoints, platform metadata, generated-state leakage, or widened actions.
