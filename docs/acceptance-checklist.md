# Runtime-neutral release acceptance

Use this checklist for a same-URL release. Keep business responses, request arguments, raw upstream errors, credentials, OAuth artifacts, cookies, identity values, account identifiers, and private resource identifiers out of this file. Store real version, deployment, and rollback identifiers only in the private deployment record.

## Clean-room package

- [x] Generate `dist/iwind-aifin-connector-skill.zip` twice and compare SHA-256 hashes.
- [x] Verify the fixed package root and all 11 allowlisted files, then extract into a new empty directory and compare every extracted byte with its archive entry.
- [x] Reject absolute or traversal paths, platform metadata, endpoint URLs, private paths, workspace dependencies, malformed JSON, and unexpected files.
- Task 12 archive SHA-256: `ad542b08873def5395b49e5dbefe64d69be42e90ac79cc06f0358b294fbf01e8`.

## Protocol client

- [x] Configure only the deployed `{PUBLIC_ORIGIN}/mcp` resource URL.
- [x] Confirm protected-resource and authorization-server discovery, PKCE S256, `initialize`, and exactly 31 unique read-only tools.
- [x] Run both approved stock prompts strictly serially. Record only tool name, elapsed time, row/data-quality checks, and notice code; do not retain the business result.

## Fresh local Agent

- [x] Read `SKILL.md` and the stock reference from the clean-room extraction of the accepted zip.
- [x] Use only the same MCP resource URL and run both approved prompts one at a time.
- [x] Confirm snapshot versus K-line routing, date/time/unit preservation, row/data-quality checks, null handling, and notice rendering without retaining business content.

## Adapter neutrality

- [x] ChatGPT Work, Grok Web, and local adapters reference the same generated zip and the same `{PUBLIC_ORIGIN}/mcp` endpoint concept.
- [x] Core Skill and gateway contain no platform-conditioned routing branch or platform metadata.
- [x] Cloud adapters make no UI-field or successful-account-test claim.

## Staging rotation and restore

- [x] Confirm the validated staging version is still the sole active version at 100% before any mutation.
- [x] Arm exactly one protected synthetic canonical daily-quota outcome on the priority slot, then run the first prompt through the local acceptance path.
- [x] Confirm data success plus `WIND_KEY_ROTATED`, and render the canonical human sentence without exposing a Key, slot, or request identifier.
- [x] Immediately restore the priority slot whether the call succeeds or fails, then confirm both slots are active and the priority slot is selected normally.
- Natural Wind quota exhaustion was not observed; the rotation proof used the staging-only protected one-shot control.

## Timeout and retry contract

- [x] Run the local/fake 600-second total-budget contract with a fake clock and abort signal, without a live 600-second wait or Wind quota use.
- [x] Confirm in Workers integration tests that timeout, upstream 5xx, and network failures retry at most once on the same slot, never select the second slot, and keep maximum Wind in-flight at one.

## Production cutover

- [x] Re-render the deploy-only config with the same Worker, origin, KV, Durable Object, cron, and 12 required Secret bindings, changing only `DEPLOYMENT_STAGE` to `production`.
- [x] Run a dry-run build and inspect the complete candidate before upload.
- [x] Upload with the complete private secrets file without deploying, inspect the new version, then explicitly deploy that one version at 100%.
- [x] Confirm the same public MCP URL remains in service and the staging test-control route returns 404.

## Production security

- [x] Confirm unauthenticated MCP returns 401, OAuth metadata remains valid, and admin requests without independent authorization are rejected.
- [x] Confirm `initialize`, 31 tools, one representative read-only call, ordinary success with no operations notice, application-log allowlist, and both KeyPool slots active.
- [x] Confirm no diagnostic tail, callback listener, or other acceptance process remains running.

## Final full gate

- [x] Run clean install, generated types, contract verification, typecheck, lint, full tests, coverage, dry-run build, deterministic packaging, clean-room verification, and exact-value Secret scan.
- [x] Confirm the final archive hash equals the accepted hash above and tracked changes remain inside the Task 12 write boundary.
- [x] Save deployment and rollback identifiers only in the private record and write the sanitized SDD report.
- [x] Commit the authorized tracked changes and confirm a clean tracked worktree.
- [x] Complete the Task 12 combined independent review before declaring the workstream final complete.

## Unverified external boundaries

- ChatGPT Work account behavior was not tested in this engineering run.
- Grok Web account behavior was not tested in this engineering run.
- A future account-level smoke may verify upload UI, connector registration, OAuth completion, automatic Skill invocation, notice rendering, and client timeout behavior without changing the shared core unless standard contract evidence requires it.
