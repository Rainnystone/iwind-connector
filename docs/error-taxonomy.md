# Wind error taxonomy and operations notice contract

## Classification boundary

The gateway classifies a Wind response from the exact JSON field `error.code` in an error envelope no larger than 16 KiB, plus one status-only rule for HTTP `401` and `403`. The current allowlist is defined in `gateway/src/errors/wind-signal-rules.json`. No message text, code-like substring, unlisted field, unknown envelope shape, or exception message can create a quota, balance, or authentication classification. When no structured vendor code is present, HTTP `401` or `403` is daily quota: the cursor advances and the slot stays active, with no trusted reset and no `disabled_auth`. A structured code on that status still wins. Wind's edge has returned `401` with a `text/html` page and no structured `error.code` (production-observed 2026-09-22, ~24 KiB). This status-only mapping is the Branch A rule; a live credit-exhaustion observation was not available when it shipped.

All current canonical Wind codes are supported by `vendor_structured_contract` evidence only. They are sanitized synthetic contract fixtures, **not production-observed raw envelopes**. The daily-quota, balance, and authentication signals must be revalidated when a naturally occurring sanitized raw envelope is available; until then, an envelope that differs from the exact allowed path remains `unknown` and does not rotate a Key.

| Exact `error.code` | Category | Decision | Evidence | Production observation |
| --- | --- | --- | --- | --- |
| `DAILY_LIMIT_ERROR` | `daily_quota` | advance cursor; hold until a trusted reset when present, otherwise allow a later wrap-around probe | `vendor_structured_contract` | Not yet production-observed |
| `BALANCE_ERROR` | `balance` | fail over; mark `disabled_balance` | `vendor_structured_contract` | Not yet production-observed |
| `AUTH_ERROR` | `auth` | fail over; mark `disabled_auth` | `vendor_structured_contract` | Not yet production-observed |
| `RATE_LIMIT_ERROR` | `qps` | retry same slot once | `vendor_structured_contract` | Not yet production-observed |
| `CONCURRENCY_LIMIT_ERROR` | `concurrency` | retry same slot once | `vendor_structured_contract` | Not yet production-observed |
| HTTP `401` / `403`, no structured `error.code` | `daily_quota` | advance cursor; slot stays active (no trusted reset) | Branch A status-only mapping | Status page observed 2026-09-22; quota meaning not yet confirmed by a live credit refresh |

An exact structured code on a `401`/`403` response still wins, so a structured `DAILY_LIMIT_ERROR` delivered with status `401` stays `daily_quota`, and a structured `AUTH_ERROR` on that status still marks `disabled_auth`. The status-only rule is evaluated before the bounded-envelope size rule in the upstream caller: an oversized HTML page on `401`/`403` is classified by status, not as `response_too_large`, and its body is dropped rather than parsed.

HTTP `429` without an exact structured code is only `qps`; it cannot rotate a Key. HTTP 5xx, timeout, and network errors retry the same slot once. Other 4xx statuses (`400`, `404`, ...) remain `unknown`. Unknown and oversized error envelopes stop without changing slot state.

Trade-off of the status-only rule: HTTP `401`/`403` without a structured vendor code cannot distinguish an out-of-credit Key from a revoked Key. The gateway advances the cursor and leaves the slot active, so a later wrap-around can probe it again. A structured `AUTH_ERROR` still marks `disabled_auth` until restore. Other 4xx statuses without an allowlisted code stay `unknown` and do not move the cursor.

`Retry-After` accepts only a machine-readable delta or HTTP date that resolves to 0–5000 ms. QPS otherwise waits 3000 ms; concurrency waits 3000 ms; network, timeout, and 5xx wait 500 ms. Each retry class has `maxRetries: 1`.

`resetAt` accepts only a future numeric epoch from `error.reset_at` or a future HTTP date in `X-RateLimit-Reset`. The gateway never guesses a Wind reset time or settlement timezone.

The pool cursor is event-driven, not request-driven. Success keeps the current slot. Daily quota (a structured code, or HTTP 401/403 with no structured code), balance, authentication, and manual disable move the cursor to the next declared slot. A daily-quota outcome with no trusted reset leaves the slot active. Balance, auth, and manual states remain disabled until restored. QPS, concurrency, network, timeout, oversized response, 5xx, and unknown outcomes do not move it. Within one logical invocation, the KeyPool excludes every slot ID already attempted and stops after at most one lease per eligible slot; a later invocation starts with an empty attempted set.

## Model-visible notice

Normal success has no notice. An operational event is appended as the final text content block in this stable format:

```text
IWIND_OPS_NOTICE_V1 {"schemaVersion":1,"code":"WIND_KEY_ROTATED","initialCategory":"daily_quota","finalStatus":"succeeded","requestId":"opaque-request-id"}
```

The encoder serializes only `schemaVersion`, `code`, `initialCategory`, `finalStatus`, and `requestId`, in that order. It rejects unrecognized enum values. Slot identifiers, Key fragments, Authorization headers, raw error text, request arguments, responses, and business data are never included.
