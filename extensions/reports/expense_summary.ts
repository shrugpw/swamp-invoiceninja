/**
 * `@shrug/invoiceninja/expense-summary` — expense totals by category and vendor,
 * plus the billable-but-uninvoiced backlog.
 *
 * Pure aggregation over the latest `expenses` snapshot, enriched with the
 * `expenseCategories` and `vendors` mapping snapshots for human-readable labels
 * (§8 of design/invoiceninja-expense-sync.md). No API calls (repo rules 3 & 8).
 *
 * Consumes: `expenses`, `expenseCategories`, `vendors` snapshots (Phase 1a).
 * Independent of the write path.
 *
 * @module
 */

import {
  type ExpenseRow,
  type MapRow,
  mdCell,
  money,
  nameIndex,
  notDeleted,
  readItems,
  type ReportCtx,
} from "./_lib/snapshots.ts";

interface Group {
  key: string;
  label: string;
  count: number;
  total: number;
}

/** Sum expenses into groups keyed by `keyOf`, labelled via `labels`. */
function groupBy(
  expenses: ExpenseRow[],
  keyOf: (e: ExpenseRow) => string | null,
  labels: Map<string, string>,
  unmatchedLabel: string,
): Group[] {
  // Key on the raw string|null: a missing (null) id is a genuinely distinct Map
  // key, so it can never collide with — or be mislabelled as — a literal "" id.
  const acc = new Map<string | null, { count: number; total: number }>();
  for (const e of expenses) {
    // `?? null` folds a missing (undefined) field from a partially-written row
    // into the same null bucket, so the label is never undefined downstream.
    const key = keyOf(e) ?? null;
    const cur = acc.get(key) ?? { count: 0, total: 0 };
    cur.count++;
    cur.total = money(cur.total + (e.amount ?? 0));
    acc.set(key, cur);
  }
  return [...acc.entries()]
    .map(([key, v]) => ({
      key: key === null ? "(none)" : key,
      label: key === null ? unmatchedLabel : (labels.get(key) ?? key),
      count: v.count,
      total: v.total,
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Coerce a globalArgs value to a real `YYYY-MM-DD` bound, or null if
 * absent/invalid. Rejects shape-valid but impossible dates (2026-13-40) via a
 * UTC round-trip so a garbage bound degrades to all-time rather than a
 * meaningless lexicographic window.
 */
function asIsoDate(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

/** `YYYY-MM-DD` string falls within [from, to] inclusive; open-ended if a bound is null. */
function inPeriod(
  date: string | null,
  from: string | null,
  to: string | null,
): boolean {
  if (!date) return false;
  // Slice to the date component so a value carrying a time suffix
  // ("2026-06-30T09:00") can't sort past an inclusive `to` bound and vanish.
  const d = date.slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function mdTable(rows: Group[], label: string): string[] {
  const head = `| ${label} | Count | Total |`;
  const sep = "| --- | ---: | ---: |";
  const body = rows.map((r) =>
    `| ${mdCell(r.label)} | ${r.count} | ${r.total.toFixed(2)} |`
  );
  return [head, sep, ...body];
}

export const report = {
  name: "@shrug/invoiceninja/expense-summary",
  description:
    "Expenses grouped by category and vendor over a period, plus billable-but-uninvoiced backlog",
  scope: "model" as const,
  labels: ["invoiceninja", "accounting", "expenses"],
  execute: async (
    ctx: ReportCtx,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const { items: rawExpenses, retrievedAt } = await readItems<ExpenseRow>(
      ctx,
      "expenses",
    );
    // IN's `listExpenses` returns soft-deleted/archived expenses in both
    // with_trashed states — filter them out up front so no deleted row's amount
    // is counted in any section (totals, by-category/vendor, billable backlog).
    const expenses = rawExpenses.filter(notDeleted);
    const deletedExcluded = rawExpenses.length - expenses.length;
    const { items: categories } = await readItems<MapRow>(
      ctx,
      "expenseCategories",
    );
    const { items: vendors } = await readItems<MapRow>(ctx, "vendors");
    const catNames = nameIndex(categories);
    const vendorNames = nameIndex(vendors);

    // Period bounds are optional model globalArgs (`expenseFrom` / `expenseTo`,
    // `YYYY-MM-DD`); absent → all-time. Reports take no method args, so the
    // window is driven from config when present (SUM-2 — no longer hardcoded).
    const from = asIsoDate(ctx.globalArgs?.expenseFrom);
    const to = asIsoDate(ctx.globalArgs?.expenseTo);
    const scoped = (from === null && to === null)
      ? expenses
      : expenses.filter((e) => inPeriod(e.date, from, to));

    const byCategory = groupBy(
      scoped,
      (e) => e.categoryId,
      catNames,
      "(uncategorized)",
    );
    const byVendor = groupBy(
      scoped,
      (e) => e.vendorId,
      vendorNames,
      "(no vendor)",
    );

    const grandTotal = money(
      scoped.reduce((s, e) => s + (e.amount ?? 0), 0),
    );

    // Billable-but-uninvoiced backlog: shouldBeInvoiced and not yet on an
    // invoice. Computed over ALL expenses, NOT the reporting period — the
    // backlog answers "what do I still owe an invoice for?", so scoping it to an
    // arbitrary window would silently hide older still-owed expenses (ES-2).
    const billable = expenses.filter((e) =>
      e.shouldBeInvoiced === true && e.invoiceId === null
    );
    const billableTotal = money(
      billable.reduce((s, e) => s + (e.amount ?? 0), 0),
    );

    const periodLabel = (from || to)
      ? `${from ?? "…"} → ${to ?? "…"}`
      : "all time";

    const notes: string[] = [];
    if (!retrievedAt) {
      notes.push("No `expenses` snapshot found — run `listExpenses` first.");
    } else if (rawExpenses.length === 0) {
      notes.push(`Snapshot ${retrievedAt} is empty (0 expenses).`);
    } else {
      notes.push(`Snapshot: ${retrievedAt}. Period: ${periodLabel}.`);
    }
    if (deletedExcluded > 0) {
      notes.push(
        `${deletedExcluded} soft-deleted expense(s) were excluded from all ` +
          "totals (Invoice Ninja returns deleted rows in both with_trashed states).",
      );
    }
    if (from || to) {
      notes.push(
        "The billable-but-uninvoiced backlog is all-time — it ignores the " +
          "reporting period so still-owed older expenses are never hidden.",
      );
    }

    const markdown = [
      "# Expense Summary",
      "",
      `${scoped.length} expense(s); total **${grandTotal.toFixed(2)}**.`,
      "",
      "## By category",
      "",
      ...mdTable(byCategory, "Category"),
      "",
      "## By vendor",
      "",
      ...mdTable(byVendor, "Vendor"),
      "",
      "## Billable but uninvoiced (all time)",
      "",
      `${billable.length} expense(s) flagged \`shouldBeInvoiced\` with no invoice — **${
        billableTotal.toFixed(2)
      }** to bill.`,
      "",
      ...notes.map((n) => `> ${n}`),
      "",
    ].join("\n");

    return {
      markdown,
      json: {
        snapshotRetrievedAt: retrievedAt,
        period: { from, to },
        expenseCount: scoped.length,
        total: grandTotal,
        byCategory,
        byVendor,
        billableUninvoiced: {
          scope: "all-time",
          count: billable.length,
          total: billableTotal,
          expenseIds: billable.map((e) => e.id),
        },
      },
    };
  },
};
