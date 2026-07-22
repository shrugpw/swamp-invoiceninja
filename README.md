# @shrug/invoiceninja

Invoice Ninja v5 (`/api/v1`) swamp model — read-side snapshots (invoices,
payments, expenses, vendors, expense categories) plus an idempotent, gated
write path that syncs bank transactions into Invoice Ninja as expense records.
Part of the bank→Invoice Ninja expense-sync automation (design:
`design/invoiceninja-expense-sync.md`).

**Status: live in production.** All phases (contracts through go-live) are
done; this extension is promoted to the `stable` channel and currently
performs real writes against a live Invoice Ninja instance via the
`mercury-expense-sync` / `ar-nightly` workflows.

## Config

| arg | default | notes |
|-----|---------|-------|
| `baseUrl` | — | `https://<host>/api/v1` (no trailing slash) |
| `apiToken` | — | sensitive; `vault.get("invoiceninja","API_TOKEN")`. Full-account — mint under a restricted IN user. |
| `perPage` | `100` | API default is 20 — overridden. |
| `withTrashed` | `false` | include archived/soft-deleted. |
| `dryRun` | `true` | write methods never POST unless explicitly `false`. |
| `vendorOverlay` | `{}` | curated RAW counterparty → TARGET IN vendor name translation. |
| `categoryOverlay` | `{}` | curated RAW rawCategory → TARGET IN expense-category name translation. |
| `vendorCategoryOverlay` | `{}` | curated RAW counterparty → TARGET IN expense-category, hard-overrides `rawCategory` for that vendor (§7.5). |

## Methods

**Read** — `listInvoices`, `getInvoice`, `listPayments`, `listExpenses`,
`expenseCategories`, `vendors`. All paginate to completion and snapshot the
result; `listExpenses` doubles as the `custom_value1` dedup mirror.

**Write** (all gated behind `dryRun`, default `true`) — `upsertExpenses`
(check-then-create per BankTxn, dedup on `custom_value1`), `upsertVendors`
(auto-create vendors for candidate counterparties, dedup on normalized name),
`upsertExpenseCategories` (auto-create categories for candidate
`rawCategory`s, always ensures the fallback), `buildMapping` (pure derive —
reads the vendor/category snapshots refreshed by the two upserts and emits
the frozen `Mapping`, §7.3).

## Dedup contract

Bank txn id → Invoice Ninja `custom_value1` (the only field both writable and
`?filter=`-searchable). Check-then-create; treat as existing only on an exact
`custom_value1` match. No upsert; single-writer fan-out.

## Usage

```bash
swamp model create @shrug/invoiceninja my-invoiceninja
swamp model edit my-invoiceninja   # set baseUrl, vault apiToken
swamp model method run my-invoiceninja listExpenses --json
swamp model method run my-invoiceninja upsertExpenses --input '{"transactions": []}' --json
```

```yaml
# Example vendorCategoryOverlay: force a vendor's expenses into a specific
# category regardless of its raw bank-reported category (§7.5).
vendorCategoryOverlay:
  "ACME INSURANCE CO": "Insurance"
```

## Testing

```bash
cd invoiceninja
~/.swamp/deno/deno test -A extensions/models/invoiceninja_test.ts
```

## License

MIT
