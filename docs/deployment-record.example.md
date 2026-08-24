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
- Invocation application-log allowlist: `<confirm the gateway invocation application payload contains exactly requestId, domain, toolName, slotId, status, durationMs, responseBytes, noticeCode>`
- Invocation application-log exclusions: `<confirm that payload contains no request arguments, business response, raw error/error body, headers/Authorization, cookies, OAuth code/state/token, identity/email, Secret values/fragments, or vendor envelope; do not apply this claim to the platform tail envelope>`
- Admin status protection: `<result>`
- Local tests, bundle inspection, and Secret scan: `<result>`

## Rollback

- Immediate prior deployment: `<none|known-good|known-bad>`
- No prior known-good deployment: `<yes|no; if yes, do not invent a rollback target>`
- Known-bad prior version ID: `<version-id|not-applicable>`
- Known-bad disposition: `<never deploy; no executable rollback command>`
- Current validated release version ID: `<version-id>`
- Next-cutover rollback target: `<current validated release version ID; populate only after this release passes acceptance>`
- Next-cutover rollback command: `npx wrangler versions deploy <current-validated-version-id>@100% --name <worker-name> --yes`
- Resource disposition: `<resources retained or separately managed>`

## Follow-up

- Reviewer gate: `<pending|passed>`
- Production cutover: `<pending Task 12 or completed>`
