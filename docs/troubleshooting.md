# Troubleshooting by stable code

Start with the stable code in the MCP result, `IWIND_OPS_NOTICE_V1`, or allowlisted gateway log. Do not diagnose from vendor message text and do not paste raw responses, authorization data, cookies, or Key fragments into tickets.

| Stable code | Meaning | Operator action |
| --- | --- | --- |
| `GATEWAY_BUSY` | Another serial lease is active, or a known cooldown is active. | Honor the returned retry delay when present; otherwise retry later. Inspect key-pool status if it persists. Do not rotate a Key. |
| `KEY_POOL_EXHAUSTED` | No slot is currently eligible. | Inspect both slot states and known reset times. Replace or restore only after resolving the recorded reason; never guess a reset time. |
| `WIND_DAILY_QUOTA` | Exact structured daily-quota evidence was classified. | The gateway exhausts that slot until a known reset and may fail over once. Confirm the `WIND_KEY_ROTATED` or `WIND_KEY_ROTATION_FAILED` notice and inspect status. |
| `WIND_BALANCE` / `WIND_AUTH` | Exact structured balance or authentication evidence was classified. | The affected slot is disabled. Correct funding or credentials, replace the binding if needed, then follow the restore runbook. |
| `WIND_QPS` / `WIND_CONCURRENCY` | Rate or concurrency pressure, including an unstructured HTTP 429 for QPS. | The gateway retries the same slot once. Wait and reduce call frequency. These codes must not consume the next Key. |
| `WIND_NETWORK` / `WIND_TIMEOUT` / `WIND_UPSTREAM_5XX` | Transport, timeout, or upstream service failure. | The gateway retries the same slot once. Check reachability and provider status; do not rotate Keys. |
| `WIND_RESPONSE_TOO_LARGE` | Response crossed the deterministic size limit. | Narrow the query or requested period. Do not retry unchanged and do not rotate Keys. |
| `WIND_UNKNOWN` / `WIND_REQUEST_FAILED` | The input did not match a trusted classification, or the request stopped safely. | Correlate by request ID and allowlisted status. Preserve the pool state; investigate without message-text heuristics. |

The exact Wind classification and retry contract lives in [error taxonomy](error-taxonomy.md). A successful ordinary request has no operations sentence; a notice is evidence of an operational event, not business data.

## OAuth and Access

| Stable code or symptom | Meaning | Check |
| --- | --- | --- |
| `ACCESS_CONFIGURATION_INVALID` | An OIDC value is empty or a token/JWKS/issuer URL is not HTTPS. | Compare deployed Secret bindings with `gateway/wrangler.jsonc` → `secrets.required`; correct through interactive Secret input. |
| `ACCESS_IDENTITY_REJECTED` | Token exchange, signature/claims, nonce, subject, or the single allowed email failed validation. | Check Access client configuration, issuer, audience, JWKS reachability, clock, and the approved email. Never log the ID token. |
| `OAUTH_SESSION_INVALID` / `OAUTH_SESSION_EXPIRED` | The sealed authorization or consent session is absent, malformed, replayed, or older than its allowed window. | Restart authorization in a clean browser session; confirm HTTPS origin, cookie support, and clock. Do not reuse callback URLs. |
| OAuth client resolution or redirect error | Dynamic client registration or the requested redirect/scope was rejected. | Register the exact `{PUBLIC_ORIGIN}/mcp` endpoint again and complete a fresh authorization. Do not invent platform fields; use that platform's current MCP documentation. |

If public errors remain sanitized, use the request ID to locate one allowlisted log event. The log schema is defined in [security](security.md). Any need for raw credentials or raw upstream bodies indicates the diagnostic path is unsafe and should stop.
