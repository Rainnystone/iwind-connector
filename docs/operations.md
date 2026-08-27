# Operations

## Sources of truth

- Cloudflare Secret binding names: `gateway/wrangler.jsonc` → `secrets.required`.
- Slot-to-binding mapping: `gateway/src/invocation/resolve-secret.ts` (`key-01` → `WIND_API_KEY_01`, `key-02` → `WIND_API_KEY_02`).
- Slot states and transitions: `gateway/src/key-pool/key-pool.ts`.
- Upstream schema snapshot: `gateway/src/contracts/tool-manifest.json` plus its `.sha256`, verified by `npm run contract:verify`.

The pool has exactly two serial slots. “Add a Key” means populate an unused one of those slots. A third slot changes the data model and architecture contract and requires human approval plus an implementation change; it is not an operations shortcut.

## Admin request contract

Use an approved admin HTTP client that injects `ADMIN_TOKEN` from protected input into the `Authorization: Bearer …` header without placing the value in command arguments, shell history, logs, or screenshots.

| Operation | Method and path | Exact JSON body | Success |
| --- | --- | --- | --- |
| Inspect pool | `GET {PUBLIC_ORIGIN}/admin/key-pool` | none | `200` JSON status |
| Disable slot | `POST {PUBLIC_ORIGIN}/admin/key-pool/slots/key-01/disable` or `key-02` | `{}` | `204` |
| Restore slot | `POST {PUBLIC_ORIGIN}/admin/key-pool/slots/key-01/restore` or `key-02` | `{}` | `204` |

For POST, the Content-Type must be exactly `application/json`. Record only the returned state, timestamps, call count, and request identifier; never record headers or Secret values.

## Replace a Key

1. Inspect the pool and identify the binding/slot pair from the mapping above.
2. Disable that slot through the admin request contract. Confirm its state is `disabled_manual` before changing the binding.
3. Update the matching entry in the private `../.secrets/iwind.keys.env` with a Secret-aware editor. Do not copy its value into Markdown, chat, a command argument, or a log.
4. Update the Cloudflare binding through the interactive prompt:

   ```bash
   npx --no-install wrangler secret put WIND_API_KEY_01 --config dist/wrangler.deploy.jsonc
   ```

   Use `WIND_API_KEY_02` when replacing `key-02`.
5. Run `npm run secret:scan -- --secrets-file '../.secrets/iwind.keys.env'`. A pass proves the current exact values do not occur in delivery source or the packaged Skill.
6. Restore the slot, then inspect status again. Restore changes state only; it does not validate the replacement. Complete the change with one approved representative read-only call and confirm the slot returns to normal operation without a failure notice.

## Add a Key to the unused slot

1. Inspect status and confirm the target is the unused `key-02` slot. Do not replace an active Key under the name “add.”
2. Add `WIND_API_KEY_02` to the private env file and set the Cloudflare Secret through `npx --no-install wrangler secret put WIND_API_KEY_02 --config dist/wrangler.deploy.jsonc`.
3. Run the exact-value Secret scan.
4. Restore `key-02`, inspect status, and complete one approved representative read-only call. Upstream requests remain strictly serial; adding a Key adds failover capacity, not round-robin or parallel throughput.

## Disable or restore a Key

Disable through the exact admin path and confirm `disabled_manual`. A manual disable persists across reported outcomes and has no automatic reset.

Restore only after the underlying reason has been resolved: a replacement was set, balance/authentication was corrected, or a known quota reset was independently confirmed. Restore clears stored reset/cooldown/error state immediately; it does not probe Wind and must not be used to bypass uncertain quota evidence.

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
