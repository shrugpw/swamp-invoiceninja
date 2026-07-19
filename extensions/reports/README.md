# `@shrug/invoiceninja` reports

Pure-CEL-style aggregation over the model's versioned snapshot resources — no
API calls (repo rules 3 & 8). See §8 of `design/invoiceninja-expense-sync.md`.

| Report file          | Name                                  | Scope              | Consumes                                   | Phase         |
| -------------------- | ------------------------------------- | ------------------ | ------------------------------------------ | ------------- |
| `ar_aging.ts`        | `@shrug/invoiceninja/ar-aging`        | `model`            | `invoices`                                 | 1a ✅ ready   |
| `expense_summary.ts` | `@shrug/invoiceninja/expense-summary` | `model`            | `expenses`, `expenseCategories`, `vendors` | 1a ✅ ready   |
| `reconcile.ts`       | `@shrug/invoiceninja/reconcile`       | `model`/`workflow` | `expenseSync` + source `BankTxn`           | 2 ⛔ deferred |

`reconcile` is **deferred**: it answers "am I caught up?" by diffing the
`expenseSync` resource against the source `BankTxn` snapshot, and `expenseSync`
is only written by the Phase-2 write path (`upsertExpense(s)`), which does not
exist yet. It's specced in `design/specs/invoiceninja-write.spec.md` and should
land with (or right after) Phase 2. It reports three money-path failure modes —
**gap** (posted debit missing from IN), **amount mismatch** (present but the
recorded amount disagrees), and **duplicate** (same `custom_value1` on >1 IN
expense; the WSPEC-06 backstop, strongest when the workflow also runs
`listExpenses`).

## Config

`expense-summary` reads an optional reporting window from model `globalArgs`:
`expenseFrom` / `expenseTo` (`YYYY-MM-DD`). Absent → all-time. These are
optional passthrough keys, not part of the frozen `GlobalArgsSchema`.

## Wiring (do this when the Phase 1a read work merges)

These reports read the read-method snapshots, so wire them only once the read
methods are merged. Add to `invoiceninja/manifest.yaml`:

```yaml
reports:
  - ../extensions/reports/ar_aging.ts
  - ../extensions/reports/expense_summary.ts
```

Then verify and run:

```bash
swamp model get <invoiceninja-model> --json     # confirm reports resolve
swamp model method run <invoiceninja-model> listInvoices   # produces snapshot + runs ar-aging
swamp report get @shrug/invoiceninja/ar-aging --model <invoiceninja-model> --markdown
swamp report get @shrug/invoiceninja/expense-summary --model <invoiceninja-model> --markdown
```

Model-scope reports run after method-scope reports on the same model, so the
latest snapshot of each resource is already persisted when they execute. A
missing snapshot degrades to an empty section (with a `run … first` note), never
a failure.

> Path note: confirm the `manifest.yaml` → report relative path against your
> repo's bundling layout before the first run; the model file itself is listed
> as `invoiceninja.ts` (sibling), whereas these reports live under
> `extensions/reports/`.
