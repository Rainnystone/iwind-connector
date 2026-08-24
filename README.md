# iWind AIFin Connector

This directory delivers three pieces that stay deliberately separate:

- `skill/` is the runtime-neutral, read-only model instruction tree.
- `gateway/` is the Cloudflare OAuth MCP gateway and its deterministic tool manifest.
- `adapters/` contains thin platform notes. Every adapter uses the same generated Skill archive and the same OAuth MCP endpoint concept.

The generated Skill artifact is `dist/iwind-aifin-connector-skill.zip`. It contains only `SKILL.md`, `references/*.md`, and `evals/*.json` under the fixed `iwind-aifin-connector/` root. Platform metadata such as `agents/openai.yaml` is not part of the core package.

## Route by task

- Start with [installation](docs/installation.md) to verify, package, install locally, or prepare an approved Cloudflare deployment.
- Use [operations](docs/operations.md) to replace, add, disable, or restore a Key, or to refresh the upstream schema snapshot.
- Use [troubleshooting](docs/troubleshooting.md) when a stable gateway, Wind, or OAuth code appears.
- Read [security](docs/security.md) before handling credentials, logs, archives, Access configuration, or deployment.
- Choose the thin adapter for [ChatGPT Work](adapters/chatgpt-work/README.md), [Grok Web](adapters/grok-web/README.md), or a [local MCP client](adapters/local/README.md).

## Local verification

With the repository's declared Node version and installed lockfile dependencies:

```bash
npm test
npm run typecheck
npm run lint
npm run contract:verify
npm run build
npm run skill:package
npm run secret:scan -- --secrets-file '../.secrets/iwind.keys.env'
```

`build` is a Wrangler dry run. Packaging and scanning do not deploy or call Wind. The final scan reads the caller-supplied private env file only to construct exact byte matches; findings never include matched content.
