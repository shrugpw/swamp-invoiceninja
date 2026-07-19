/**
 * `@shrug/invoiceninja/ar-aging` — accounts-receivable aging report.
 *
 * Buckets outstanding invoice `balance` by how far past `dueDate` it is, per
 * client and in total (§8 of design/invoiceninja-expense-sync.md). Pure
 * aggregation over the latest `invoices` snapshot the read methods persist — no
 * API calls (repo rules 3 & 8).
 *
 * Consumes: `invoices` snapshot (Phase 1a). Independent of the write path.
 *
 * @module
 */

import {
  type InvoiceRow,
  mdCell,
  money,
  readItems,
  type ReportCtx,
} from "./_lib/snapshots.ts";

/** Aging buckets, in ascending days-past-due order. `current` == not yet overdue. */
const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
type Bucket = (typeof BUCKETS)[number];

/**
 * Invoice `status_id` values that represent an actual outstanding receivable
 * (§4.3 status enum): 2 Sent, 3 Partial. Draft (1) is not yet owed; Paid (4)
 * has no balance; Cancelled (5) / Reversed (6) are not collectible. A stray
 * positive balance on a non-AR status must NOT inflate aging (SUM-1) — the
 * model's own overdue rule only ever fires on unpaid statuses.
 */
const AR_STATUS = new Set<number>([2, 3]);

/** Whole days `dueDate` is before `today` (both `YYYY-MM-DD`); ≤0 == not overdue. */
function daysOverdue(dueDate: string | null, today: string): number {
  if (!dueDate) return 0; // undated → treated as current, surfaced in a note
  // Slice to the date component: a snapshot value that carries a time suffix
  // (e.g. "2026-01-01T12:00:00") would otherwise concatenate to an invalid
  // string → NaN → silently bucket a long-overdue balance as `current`.
  const due = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.floor((now - due) / 86_400_000);
}

function bucketFor(days: number): Bucket {
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

function emptyBuckets(): Record<Bucket, number> {
  return { "current": 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export const report = {
  name: "@shrug/invoiceninja/ar-aging",
  description:
    "Outstanding invoice balance bucketed by age past due (current/1-30/31-60/61-90/90+), per client and total",
  scope: "model" as const,
  labels: ["invoiceninja", "accounting", "ar"],
  execute: async (
    ctx: ReportCtx,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const today = todayUtc();
    const { items: invoices, retrievedAt } = await readItems<InvoiceRow>(
      ctx,
      "invoices",
    );

    // Only genuine open receivables: a positive balance, not soft-deleted, AND a
    // collectible status (Sent/Partial). Excluding non-AR statuses is SUM-1 — a
    // Draft/Cancelled/Reversed invoice carrying a balance must not be counted.
    const withBalance = invoices.filter((inv) =>
      (inv.balance ?? 0) > 0 && inv.isDeleted !== true
    );
    const open = withBalance.filter((inv) =>
      inv.statusId !== null && AR_STATUS.has(inv.statusId)
    );
    const excludedNonAr = withBalance.length - open.length;

    const perClient = new Map<string, Record<Bucket, number>>();
    const total = emptyBuckets();
    let undatedCount = 0;

    for (const inv of open) {
      const bal = money(inv.balance ?? 0);
      const days = daysOverdue(inv.dueDate, today);
      if (!inv.dueDate) undatedCount++;
      const bucket = bucketFor(days);
      const clientId = inv.clientId ?? "(no client)";
      const row = perClient.get(clientId) ?? emptyBuckets();
      row[bucket] = money(row[bucket] + bal);
      perClient.set(clientId, row);
      total[bucket] = money(total[bucket] + bal);
    }

    const clientRows = [...perClient.entries()]
      .map(([clientId, buckets]) => ({
        clientId,
        buckets,
        total: money(BUCKETS.reduce((s, b) => s + buckets[b], 0)),
      }))
      .sort((a, b) => b.total - a.total);

    const grandTotal = money(BUCKETS.reduce((s, b) => s + total[b], 0));

    // ---- markdown ----
    const header = `| Client | ${BUCKETS.join(" | ")} | Total |`;
    const sep = `| --- | ${BUCKETS.map(() => "---:").join(" | ")} | ---: |`;
    const body = clientRows.map((r) =>
      `| ${mdCell(r.clientId)} | ${
        BUCKETS.map((b) => r.buckets[b].toFixed(2)).join(" | ")
      } | ${r.total.toFixed(2)} |`
    );
    const totalLine = `| **Total** | ${
      BUCKETS.map((b) => total[b].toFixed(2)).join(" | ")
    } | **${grandTotal.toFixed(2)}** |`;

    const notes: string[] = [];
    if (!retrievedAt) {
      notes.push("No `invoices` snapshot found — run `listInvoices` first.");
    } else if (invoices.length === 0) {
      notes.push(`Snapshot ${retrievedAt} is empty (0 invoices).`);
    } else {
      notes.push(`Snapshot: ${retrievedAt}.`);
    }
    if (excludedNonAr > 0) {
      notes.push(
        `${excludedNonAr} invoice(s) with a balance were excluded as non-AR ` +
          "(Draft/Cancelled/Reversed/unknown status).",
      );
    }
    if (undatedCount > 0) {
      notes.push(
        `${undatedCount} open invoice(s) have no due date and are counted as \`current\`.`,
      );
    }
    notes.push(
      "Aging is computed against **UTC** today; near a day boundary a " +
        "due date may bucket one day off from your local date.",
    );

    const markdown = [
      `# AR Aging — as of ${today}`,
      "",
      `${open.length} open invoice(s); outstanding **${
        grandTotal.toFixed(2)
      }**.`,
      "",
      header,
      sep,
      ...body,
      totalLine,
      "",
      ...notes.map((n) => `> ${n}`),
      "",
    ].join("\n");

    return {
      markdown,
      json: {
        asOf: today,
        snapshotRetrievedAt: retrievedAt,
        openInvoiceCount: open.length,
        excludedNonArCount: excludedNonAr,
        undatedOpenCount: undatedCount,
        buckets: BUCKETS,
        total: { ...total, all: grandTotal },
        perClient: clientRows,
      },
    };
  },
};
