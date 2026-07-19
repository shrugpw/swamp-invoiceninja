# @shrug/invoiceninja

Invoice Ninja v5 (`/api/v1`) swamp model — read-side snapshots plus an
idempotent, gated expense-create path. Part of the bank→Invoice Ninja
expense-sync automation (design: `design/invoiceninja-expense-sync.md`).

**Status: Phase-0 skeleton.** The config schema (§4.1) and the single network
seam `inFetch` (§4.2, mandatory `X-Requested-With: XMLHttpRequest`) are frozen
and implemented. Read methods (§4.3) and the gated write `upsertExpenses`
(§4.4/§7) are declared but their bodies are Phase-1a / Phase-2 TODO stubs.

## Config

| arg | default | notes |
|-----|---------|-------|
| `baseUrl` | — | `https://<host>/api/v1` (no trailing slash) |
| `apiToken` | — | sensitive; `vault.get("invoiceninja","API_TOKEN")`. Full-account — mint under a restricted IN user. |
| `perPage` | `100` | API default is 20 — overridden. |
| `withTrashed` | `false` | include archived/soft-deleted. |
| `dryRun` | `true` | write methods never POST unless explicitly `false`. |

## Dedup contract

Bank txn id → Invoice Ninja `custom_value1` (the only field both writable and
`?filter=`-searchable). Check-then-create; treat as existing only on an exact
`custom_value1` match. No upsert; single-writer fan-out.
