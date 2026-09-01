# Operations

## Sources of truth

- Cloudflare Secret binding names: `gateway/wrangler.jsonc` → `secrets.required`.
- Slot order and slot-to-binding mapping: `gateway/src/key-pool/slots.ts`.
- Slot states and transitions: `gateway/src/key-pool/key-pool.ts`.
- Upstream schema snapshot: `gateway/src/contracts/tool-manifest.json` plus its `.sha256`, verified by `npm run contract:verify`.

The active primary generation has the stable catalog `key-01`, `key-02`, `key-03` and the active layout `key-03 → key-02 → key-01`. Slot identity and binding are stable; priority is derived from a layout. The old `key-01 → key-02` legacy object remains schema v2 for OAuth replay and rollback compatibility. It has no `pool_manifest`; the primary object uses schema v3 with a manifest that records its generation and layout. The persisted manifest is the runtime authority for an activated versioned object: admin, test-control, lease, cursor, and acquisition resolve its persisted layout rather than treating the environment's active-layout ID as a replacement for stored state. Generation IDs and Durable Object names are each unique.

This code is not deployed to Cloudflare production yet. Production remains on the old two-slot generation until the feature PR is merged and a separately approved Task 5 cutover is performed. Do not treat a local primary-layout test as a completed deployment.

## Admin request contract

Use an approved admin HTTP client that injects `ADMIN_TOKEN` from protected input into the `Authorization: Bearer …` header without placing the value in command arguments, shell history, logs, or screenshots.

| Operation | Method and path | Exact JSON body | Success |
| --- | --- | --- | --- |
| Inspect pool | `GET {PUBLIC_ORIGIN}/admin/key-pool` | none | `200` JSON status including anonymous `currentSlotId` |
| Disable slot | `POST {PUBLIC_ORIGIN}/admin/key-pool/slots/key-03/disable`, `key-02`, or `key-01` | `{}` | `204` |
| Restore slot | `POST {PUBLIC_ORIGIN}/admin/key-pool/slots/key-03/restore`, `key-02`, or `key-01` | `{}` | `204` |

For POST, the Content-Type must be exactly `application/json`. Record only the returned state, timestamps, call count, and request identifier; never record headers or Secret values.

## Replace a Key

1. Inspect the pool and identify the binding/slot pair from the mapping above.
2. Disable that slot through the admin request contract. Confirm its state is `disabled_manual` before changing the binding.
3. Update the matching entry in both owner-only private files, `../.secrets/iwind.keys.env` and the complete `../.secrets/iwind.cloudflare.env`, with a Secret-aware editor. Do not copy its value into Markdown, chat, a command argument, or a log.
4. For an existing Worker, render the approved deploy config, create one complete Secret-file candidate, perform names-only inspection, then explicitly deploy the exact candidate at 100%:

   ```bash
   npx --no-install wrangler versions upload \
     --config dist/wrangler.deploy.jsonc \
     --secrets-file ../.secrets/iwind.cloudflare.env
   npx --no-install wrangler versions deploy <candidate>@100%
   ```

   Never percentage-split or use `wrangler secret put`: it creates and immediately deploys a version. Use the matching declared binding when replacing another existing slot: `WIND_API_KEY_02` for `key-02`, or `WIND_API_KEY_03` for `key-03`.
5. Run `npm run secret:scan -- --secrets-file '../.secrets/iwind.keys.env'`. A pass proves the current exact values do not occur in delivery source or the packaged Skill.
6. Restore the slot, then inspect status again. Restore changes state only; it does not validate the replacement. Complete the change with one approved representative read-only call and confirm the slot returns to normal operation without a failure notice.

## Choose the correct maintenance action

| Need | Safe change | Required result |
| --- | --- | --- |
| Replace an existing Key | Update the same private/Cloudflare binding and restore the same slot. | No catalog, layout, generation, client, Skill, MCP URL, or OAuth change. |
| Add ordinary capacity | Append a new catalog/binding identity at the tail and create a new strict-prefix layout in the **same** generation. | Use the two-stage expand/activate rollout below; the new slot is the layout tail, not primary. |
| Change priority, delete, rename, or insert in the middle | Create a new generation and a new Durable Object name. | Use a dedicated blue-green plan; do not disguise it as ordinary expansion. |

The catalog is append-only. A same-generation prefix append preserves every existing slot's state, call count, cursor, and live lease. A corrupted manifest, generation mismatch, reorder, deletion, rename, middle insertion, duplicate, or catalog-external slot fails closed. Never repair SQLite by hand or retry around that rejection.

## Future ordinary expansion: expand, then activate

This is an engineering and approved deployment action, not a live admin action.

1. Obtain human approval for the new tail slot, its Secret binding, and the rollout. Append the catalog identity/binding, define a candidate layout whose existing ordered slots are an exact prefix, and update the required binding names, tests, and documentation. `key-04` and then `key-05` are ordinary examples; neither becomes primary automatically.
2. Build and verify the **expand candidate**. It must recognize the expanded catalog, candidate layout, and Secret binding, while `KEY_POOL_LAYOUT_ID` still selects the old active layout. Upload it through the complete-file candidate path only; do not activate the candidate layout yet.
3. Verify the expand candidate against its unchanged active layout, including Secret-free scans and the relevant schema/layout tests. Keep this candidate available: once activation succeeds, it is the minimum safe rollback target because it already recognizes the new layout and can read the persisted successor layout.
4. Build and verify the **activate candidate** with `KEY_POOL_LAYOUT_ID` changed to the approved strict-prefix layout. Activate it only after a separate cutover approval and validate its persisted manifest, slot states, cursor, lease behavior, unchanged MCP URL, 31 tools, OAuth, notices, and strict serialization.
5. After activation, do not roll back to a version that knows only the old layout. Roll back only to the expand candidate or a newer compatible revision; the expand candidate can read the persisted successor layout while its environment active ID remains old. Unknown or non-prefix persisted layouts fail closed. Record identifiers in the private deployment record, never in this public runbook.

## Disable or restore a Key

Disable through the exact admin path and confirm `disabled_manual`. If the disabled slot is current, the cursor advances atomically to its successor. A manual disable persists across reported outcomes and has no automatic reset.

Restore only after the underlying reason has been resolved: a replacement was set, or balance/authentication was corrected. Restore clears stored reset/cooldown/error state immediately and makes the slot eligible, but it does not probe Wind or steal the cursor from the current slot.

An exact daily-quota event always advances the cursor. A trusted future `reset_at` keeps that slot unavailable until lazy activation or its alarm; do not restore it early. If no trusted reset is available, the slot remains eligible for a later wrap-around probe, so no guessed refresh time or manual restore is required. Each logical call tries every eligible slot at most once; after a bounded exhaustion, a later independent call begins a new pass from `currentSlotId`.

QPS cooldown makes the current cursor temporarily busy and must not be bypassed by moving to another Key. Concurrency, network, timeout, oversized response, 5xx, and unknown failures release the lease without moving the cursor.

## Refresh the schema snapshot

This operation calls the real Wind upstreams and overwrites generated contract artifacts. Obtain human approval and proceed only after `key-01` itself has been independently verified as known-good. The refresh probe intentionally accepts only `--slot key-01`; if `key-01` is disabled, quota-exhausted, being replaced, or otherwise uncertain, stop and restore, replace, or validate it before continuing—do not substitute `key-02`. From this directory, Node can load the env file without placing values in command arguments:

```bash
node --env-file=../.secrets/iwind.keys.env node_modules/tsx/dist/cli.mjs gateway/scripts/probe-wind.ts --slot key-01
npm run contract:verify
npm test
npm run typecheck
npm run lint
npm run build
```

The probe is deliberately serial and performs discovery plus six representative read-only calls. Review the resulting changes to `gateway/src/contracts/tool-manifest.json`, `gateway/src/contracts/tool-manifest.sha256`, and `docs/contract-snapshot.md` together. Accept the refresh only when schema validation, the hash, the fixed upstream order, 31 unique read-only tools, and the Skill routing contract remain aligned. Never hand-edit the generated manifest or hash.
