# Troubleshooting by stable code

Start with the stable code in the MCP result, `IWIND_OPS_NOTICE_V1`, or allowlisted gateway log. Do not diagnose from vendor message text and do not paste raw responses, authorization data, cookies, or Key fragments into tickets.

| Stable code | Meaning | Operator action |
| --- | --- | --- |
| `GATEWAY_BUSY` | Another serial lease is active, or a known cooldown is active. | Honor the returned retry delay when present; otherwise retry later. Inspect key-pool status if it persists. Do not rotate a Key. |
| `KEY_POOL_EXHAUSTED` | This invocation has tried every eligible slot once, or no slot is currently eligible. | Inspect `currentSlotId`, slot states, and trusted reset times. A later independent request may re-probe daily-quota slots that had no trusted reset; balance/auth/manual states require correction and restore. Never guess a reset time. |
| `WIND_DAILY_QUOTA` | Exact structured daily-quota evidence was classified. | The primary cursor advances through `key-05 → key-04 → key-03 → key-02 → key-01 → key-05`. A trusted future reset keeps the affected slot unavailable until then; without one, it may be probed on a later wrap. Confirm the notice and inspect status. |
| `WIND_BALANCE` / `WIND_AUTH` | Exact structured balance or authentication evidence was classified. | The affected slot is disabled. Correct funding or credentials, replace the binding if needed, then follow the restore runbook. |
| `WIND_QPS` / `WIND_CONCURRENCY` | Rate or concurrency pressure, including an unstructured HTTP 429 for QPS. | The gateway retries the same slot once. Wait and reduce call frequency. These codes must not consume the next Key. |
| `WIND_NETWORK` / `WIND_TIMEOUT` / `WIND_UPSTREAM_5XX` | Transport, timeout, or upstream service failure. | The gateway retries the same slot once. Check reachability and provider status; do not rotate Keys. |
| `WIND_RESPONSE_TOO_LARGE` | Response crossed the deterministic size limit. | Narrow the query or requested period. Do not retry unchanged and do not rotate Keys. |
| `WIND_UNKNOWN` / `WIND_REQUEST_FAILED` | The input did not match a trusted classification, or the request stopped safely. | Correlate by request ID and allowlisted status. Preserve the pool state; investigate without message-text heuristics. |

The exact Wind classification and retry contract lives in [error taxonomy](error-taxonomy.md). A successful ordinary request has no operations sentence; a notice is evidence of an operational event, not business data.

## OAuth and Access

| Stable code or symptom | Meaning | Check |
| --- | --- | --- |
| `ACCESS_CONFIGURATION_INVALID` | An OIDC value is empty or a token/JWKS/issuer URL is not HTTPS. | Compare deployed binding names with `gateway/wrangler.jsonc` → `secrets.required`; correct the complete owner-only Secret file, upload a candidate, run `versions view <candidate> --config dist/wrangler.deploy.jsonc --json` through the installation names-only filter, then explicitly deploy that candidate at 100% with the same config. |
| `ACCESS_IDENTITY_REJECTED` | Token exchange, signature/claims, nonce, subject, or the single allowed email failed validation. | Check Access client configuration, issuer, audience, JWKS reachability, clock, and the approved email. Never log the ID token. |
| `OAUTH_SESSION_INVALID` / `OAUTH_SESSION_EXPIRED` | The sealed authorization or consent session is absent, malformed, replayed, or older than its allowed window. | Restart authorization in a clean browser session; confirm HTTPS origin, cookie support, and clock. Do not reuse callback URLs. |
| OAuth client resolution or redirect error | Dynamic client registration or the requested redirect/scope was rejected. | Register the exact `{PUBLIC_ORIGIN}/mcp` endpoint again and complete a fresh authorization. Do not invent platform fields; use that platform's current MCP documentation. |

If public errors remain sanitized, use the request ID to locate one allowlisted log event. The log schema is defined in [security](security.md). Any need for raw credentials or raw upstream bodies indicates the diagnostic path is unsafe and should stop.

## Layout or generation rejection

`INVALID_KEY_POOL_LAYOUT`, `KEY_POOL_GENERATION_MISMATCH`, and unknown/corrupt stored-layout failures are fail-closed safeguards, not retryable Wind failures. Stop the rollout and compare active layout, object generation, and persisted manifest. Do not reorder a catalog or edit a Durable Object database. A normal successor inserts its new block immediately before the actual persisted cursor; for reorder, deletion, or rename, prepare a new generation and blue-green cutover.

- `KEY_POOL_LAYOUT_TRANSITION_REQUIRED`: the candidate tried to skip one or more direct-successor transitions. Activate each approved successor in order; do not force a manifest jump.
- `KEY_POOL_LAYOUT_DIVERGENCE`: the candidate and persisted layout are on different successor branches. Stop that candidate and reconcile the intended lineage; use a new generation for an intentional topology replacement.
- `KEY_POOL_LAYOUT_MIGRATION_BUSY`: a live lease blocked migration with zero writes. Let the active request finish or the lease expire, then retry the same approved candidate; do not delete the lease by hand or rotate a Key.
