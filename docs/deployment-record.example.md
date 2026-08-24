# Deployment record

Use this template for a private deployment record outside the delivery repository. Never include account identifiers, identity email addresses, Secret values, OAuth codes/tokens, cookies, or Wind business responses.

## Release

- Environment: `<staging|production>`
- Worker name: `<worker-name>`
- Public origin: `<https-origin>`
- Deployment time: `<ISO-8601 timestamp>`
- Worker version ID: `<version-id>`
- Deployment ID: `<deployment-id>`
- Traffic allocation: `<percentage>`
- Release tag/message: `<non-sensitive label>`

## Resources and bindings

- Access application: `<name and Generic OIDC type>`
- Access callback: `<public-origin>/callback`
- Access scopes: `openid email`
- Access policy: `<single-owner Allow; identity value omitted>`
- KV namespace: `<name and namespace ID>`
- Durable Object: `<binding and migration tag>`
- Cron: `<schedule>`
- Secret bindings: `<count and names only; never values>`

## Verification

- Unauthenticated MCP and OAuth metadata: `<result>`
- Access login and consent: `<result>`
- OAuth token exchange: `<result>`
- MCP initialize and tools/list: `<result>`
- Representative read-only smoke: `<tool name and pass/fail only>`
- Wind serialization/slot/notice: `<sanitized result>`
- Admin status protection: `<result>`
- Local tests, bundle inspection, and Secret scan: `<result>`

## Rollback

- Previous known-good version ID: `<version-id>`
- Rollback command: `npx wrangler versions deploy <version-id>@100% --name <worker-name> --yes`
- Resource disposition: `<resources retained or separately managed>`

## Follow-up

- Reviewer gate: `<pending|passed>`
- Production cutover: `<pending Task 12 or completed>`
