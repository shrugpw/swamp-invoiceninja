/**
 * `@shrug/invoiceninja/reconcile` — the "am I caught up?" report.
 *
 * Diffs the source `BankTxn` snapshot (candidate posted debits) against the
 * `expenseSync` resource the Phase-2 write path writes, and reports three
 * failure modes on the money path (§8 of design/invoiceninja-expense-sync.md):
 *   - GAP:        a posted debit with no matching `custom_value1` in IN.
 *   - MISMATCH:   present in IN, but the recorded amount differs (RECON-001).
 *   - DUPLICATE:  the same `custom_value1` on >1 IN expense (WSPEC-06 backstop).
 * Inter-account transfers (§6.1, `isTransfer: true`) are reported SEPARATELY —
 * they are excluded from the candidate set (the sink's isCandidate drops them),
 * so they are neither a gap nor a duplicate. Pure aggregation — no API calls
 * (repo rules 3 & 8).
 *
 * ── LIVE (inputs exist) ──
 * `expenseSync` is written by the Phase-2 write path (`upsertExpenses`), and the
 * `BankTxn` snapshot comes from the source models (`@shrug/mercury` /
 * `@shrug/bank-import`) — all now shipped. This report still detects its inputs
 * STRUCTURALLY, not by resource name (RECON-003): only the BankTxn *schema* §6
 * and the expenseSync *shape* §4.5 are contracts, so a run that is missing an
 * input degrades to a clear "no data yet" result rather than failing. Attaching
 * it as a WORKFLOW-scope report on `mercury-expense-sync` (§9.1 step 6) is the
 * Phase-4 step; Phase 3 ships the finalized report, its tests, and its manifest
 * registration.
 *
 * @module
 */

import {
  type DataRepository,
  type ExpenseRow,
  mdCell,
  money,
  notDeleted,
  parseSnapshot,
} from "./_lib/snapshots.ts";

/** A row of the `expenseSync` resource (ExpenseSyncSchema, §4.5). */
interface ExpenseSyncRow {
  dedupKey: string;
  action: "skip" | "would-create" | "created";
  expenseId: string | null;
  amount: number | null;
  date: string | null;
  unmatchedVendor?: boolean;
}

/** The `expenseSync` envelope (differs from a list snapshot: `rows`, not `items`). */
interface ExpenseSyncSnapshot {
  scope: string;
  rows: ExpenseSyncRow[];
  dryRun: boolean;
  retrievedAt: string;
}

/**
 * A canonical `BankTxn` row (§6, frozen RELAXED schema). counterparty /
 * description / postedDate are NULLABLE — the source models emit null for them;
 * WREV-4 only guarantees a non-null postedDate on `status: "posted"` rows, and a
 * posted debit can still carry a null counterparty/description.
 */
interface BankTxn {
  id: string;
  source: string;
  postedDate: string | null;
  amount: number;
  direction: "debit" | "credit";
  currency: string;
  counterparty: string | null;
  description: string | null;
  rawCategory?: string;
  status: "posted" | "pending";
  // §6.1 transfer-exclusion (additive, back-compat). Absent ⇒ not a transfer.
  kind?: string | null;
  isTransfer?: boolean;
  // owner-draw-exclusion (additive, back-compat). Absent ⇒ not an owner draw.
  isOwnerDraw?: boolean;
}

/** One workflow step execution (structural slice of WorkflowReportContext). */
interface StepExecution {
  modelType: unknown;
  modelId: string;
  modelName: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: Array<{ name: string; version?: number }>;
}

interface WorkflowReportCtx {
  scope: string;
  workflowName: string;
  workflowStatus: "succeeded" | "failed";
  dataRepository: DataRepository;
  stepExecutions: StepExecution[];
}

/** Does an array of rows look like canonical BankTxn records? */
function looksLikeBankTxns(items: unknown[]): items is BankTxn[] {
  if (items.length === 0) return false;
  const s = items[0] as Record<string, unknown>;
  return typeof s?.id === "string" &&
    (s?.direction === "debit" || s?.direction === "credit") &&
    (s?.status === "posted" || s?.status === "pending");
}

/** Does an array of rows look like normalized IN `expenses` (carries customValue1)? */
function looksLikeExpenses(items: unknown[]): items is ExpenseRow[] {
  if (items.length === 0) return false;
  const s = items[0] as Record<string, unknown>;
  return typeof s?.id === "string" && "customValue1" in (s ?? {});
}

/** Does a parsed payload look like an `expenseSync` envelope? (RECON-003: match by shape, not exact name.) */
function asExpenseSync(obj: unknown): ExpenseSyncSnapshot | null {
  const o = obj as Record<string, unknown> | null;
  if (!o || !Array.isArray(o.rows)) return null;
  const r = o.rows[0] as Record<string, unknown> | undefined;
  if (
    o.rows.length > 0 &&
    (typeof r?.dedupKey !== "string" || !("action" in (r ?? {})))
  ) {
    return null;
  }
  return o as unknown as ExpenseSyncSnapshot;
}

const CENT = 0.01;

export const report = {
  name: "@shrug/invoiceninja/reconcile",
  description:
    "Gap / mismatch / duplicate report: source posted debits vs expenses recorded in Invoice Ninja — the 'am I caught up?' answer",
  scope: "workflow" as const,
  labels: ["invoiceninja", "accounting", "reconcile"],
  execute: async (
    ctx: WorkflowReportCtx,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const repo = ctx.dataRepository;

    // Recorded side: dedupKey -> {amount, action}. 'created' and 'skip' both mean
    // the key IS present in IN; 'would-create' is a dry-run projection (NOT written).
    const recorded = new Map<
      string,
      { amount: number | null; action: string }
    >();
    const createdCounts = new Map<string, number>(); // for the dup backstop
    let anyDryRun = false;
    let sawExpenseSync = false;

    const candidates: BankTxn[] = [];
    const transfers: BankTxn[] = []; // §6.1: posted debits excluded as transfers
    const ownerDraws: BankTxn[] = []; // posted debits excluded as owner draws
    let sawBankTxns = false;
    let unreconcilableDebits = 0;

    // customValue1 -> count, from any IN `expenses` snapshot in the run (WSPEC-06).
    const inExpenseKeyCounts = new Map<string, number>();
    let sawExpensesSnapshot = false;

    for (const step of ctx.stepExecutions) {
      if (step.status !== "succeeded") continue;
      for (const h of step.dataHandles) {
        const bytes = await repo.getContent(
          step.modelType,
          step.modelId,
          h.name,
          h.version,
        );
        if (!bytes || bytes.length === 0) continue;

        // Try expenseSync first (structural, not name-bound — RECON-003).
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          continue; // unreadable handle → skip
        }

        const sync = asExpenseSync(parsed);
        if (sync) {
          sawExpenseSync = true;
          if (sync.dryRun) anyDryRun = true;
          for (const raw of (sync.rows ?? []) as unknown[]) {
            // REC-SEC-1: a partially-written envelope can carry a null/scalar
            // row past the shape check (which only inspects rows[0]).
            if (!raw || typeof raw !== "object") continue;
            const row = raw as ExpenseSyncRow;
            const key = row.dedupKey;
            if (!key || typeof key !== "string") continue; // RECON-002: never key on a blank/non-string dedup id
            if (row.action === "created" || row.action === "skip") {
              // REC-1: merge, don't blindly overwrite — a later idempotent
              // 'skip' (whose amount is often null) must NOT clobber a good
              // 'created' amount, or classification becomes order-dependent
              // (false MISMATCH). Prefer a non-null amount and the 'created'
              // action label.
              const prev = recorded.get(key);
              recorded.set(key, {
                amount: row.amount ?? prev?.amount ?? null,
                action: prev?.action === "created" ? "created" : row.action,
              });
            }
            if (row.action === "created") {
              createdCounts.set(key, (createdCounts.get(key) ?? 0) + 1);
            }
          }
          continue;
        }

        // Otherwise treat as a list snapshot and sniff its items.
        const { items } = parseSnapshot<unknown>(bytes);
        if (looksLikeBankTxns(items)) {
          sawBankTxns = true;
          for (const txn of items) {
            if (txn.direction !== "debit" || txn.status !== "posted") continue;
            // §6.1: an inter-account transfer is NOT a candidate expense (the
            // sink's isCandidate already excludes it, so it never enters
            // expenseSync). Count it separately — it is neither a gap nor a
            // duplicate. `=== true` treats an absent field (pre-§6.1 snapshot)
            // as non-transfer, so old snapshots reconcile unchanged.
            if (txn.isTransfer === true) {
              transfers.push(txn);
              continue;
            }
            // owner-draw-exclusion: an ATM withdrawal / owner draw is NOT a
            // candidate expense (the sink's isCandidate already excludes it, so
            // it never enters expenseSync). Count it separately in its own
            // bucket — not a gap, not a duplicate. Checked AFTER the transfer
            // branch, so a row flagged both is bucketed once (as a transfer).
            // `=== true` treats an absent field (older snapshot) as non-owner-draw.
            if (txn.isOwnerDraw === true) {
              ownerDraws.push(txn);
              continue;
            }
            // RECON-002 + REC-4a: a posted debit with a blank/non-string id or a
            // non-finite amount cannot be reconciled. Count it — never silently
            // treat it as matched (NaN amount math would otherwise slip a bad
            // row through as a match, a false all-clear).
            if (
              typeof txn.id !== "string" || !txn.id ||
              !Number.isFinite(txn.amount)
            ) {
              unreconcilableDebits++;
              continue;
            }
            candidates.push(txn);
          }
        } else if (looksLikeExpenses(items)) {
          sawExpensesSnapshot = true;
          for (const e of items) {
            // A soft-deleted IN expense is not an active duplicate — IN returns
            // deleted rows in both with_trashed states, so counting one would
            // raise a phantom DUPLICATE for a key whose only live expense is
            // singular. Absent isDeleted ⇒ kept (pre-fix snapshot, back-compat).
            if (!notDeleted(e)) continue;
            const k = e.customValue1;
            if (!k) continue; // ignore blank custom_value1 (not a dedup key)
            inExpenseKeyCounts.set(k, (inExpenseKeyCounts.get(k) ?? 0) + 1);
          }
        }
      }
    }

    // ── classify each candidate: matched / mismatch / gap ──
    const gap: BankTxn[] = [];
    const mismatch: Array<{ txn: BankTxn; recordedAmount: number | null }> = [];
    let matched = 0;
    let deletedReclassified = 0; // REC-DEL: 'skip' rows absent from the live snapshot
    for (const t of candidates) {
      const rec = recorded.get(t.id);
      if (!rec) {
        gap.push(t);
        continue;
      }
      // REC-DEL: `recorded` is the expenseSync WRITE LOG, not live IN state. An
      // idempotent 'skip' asserts the expense ALREADY exists in IN — but if a live
      // listExpenses snapshot is present and its notDeleted key-set
      // (`inExpenseKeyCounts`, built at :250-258) does NOT contain this key, the
      // expense was soft-deleted in IN after it was synced. Presence-in-IN is
      // exactly what 'recorded' is meant to assert, so treat it as a GAP (needs
      // re-creating), not matched. Runs BEFORE the amount check (a deleted expense
      // is a gap regardless of amount). Restricted to 'skip': a 'created' row is
      // THIS run's own write and is authoritative regardless of whether the
      // snapshot step ran before or after upsertExpenses (the REC-3 ordering
      // hazard) — only a pre-existing ('skip') expense can be deleted out from
      // under us. `recorded` collapses a key to 'created' if ANY row created it
      // (:200), so a key created this run is never subject to this check.
      if (
        sawExpensesSnapshot && rec.action === "skip" &&
        !inExpenseKeyCounts.has(t.id)
      ) {
        deletedReclassified++;
        gap.push(t);
        continue;
      }
      // RECON-001: presence is not enough — the recorded amount must agree.
      if (
        rec.amount === null || Math.abs((rec.amount ?? 0) - t.amount) > CENT
      ) {
        mismatch.push({ txn: t, recordedAmount: rec.amount });
      } else {
        matched++;
      }
    }

    // ── duplicate backstop (WSPEC-06) ──
    // UNION both signals rather than let the IN `expenses` snapshot suppress the
    // created-row check (REC-3): a listExpenses step ordered BEFORE the creates
    // reflects pre-create state and would otherwise hide a real double-create in
    // this run. The authoritative in-expenses count wins its key; the
    // expenseSync-created fallback only adds keys the snapshot didn't already flag.
    const duplicates: Array<{ key: string; count: number; source: string }> =
      [];
    const flagged = new Set<string>();
    for (const [key, count] of inExpenseKeyCounts) {
      if (count > 1) {
        duplicates.push({ key, count, source: "in-expenses" });
        flagged.add(key);
      }
    }
    for (const [key, count] of createdCounts) {
      if (count > 1 && !flagged.has(key)) {
        duplicates.push({ key, count, source: "expenseSync-created" });
      }
    }

    // ── per-currency gap totals (SUM-3: never sum across currencies) ──
    const gapByCurrency = new Map<string, number>();
    for (const t of gap) {
      gapByCurrency.set(
        t.currency,
        money((gapByCurrency.get(t.currency) ?? 0) + (t.amount ?? 0)),
      );
    }

    // ── per-currency transfer totals (§6.1: excluded, not part of the gap) ──
    // Guard non-finite amounts the same way candidates are (`?? 0` does NOT
    // catch NaN) so a corrupted snapshot never renders "NaN USD" (COR-1).
    const transferByCurrency = new Map<string, number>();
    for (const t of transfers) {
      const amt = Number.isFinite(t.amount) ? t.amount : 0;
      transferByCurrency.set(
        t.currency,
        money((transferByCurrency.get(t.currency) ?? 0) + amt),
      );
    }

    // ── per-currency owner-draw totals (excluded, not part of the gap) ──
    // Same non-finite guard as transfers so a corrupted snapshot never renders
    // "NaN USD".
    const ownerDrawByCurrency = new Map<string, number>();
    for (const t of ownerDraws) {
      const amt = Number.isFinite(t.amount) ? t.amount : 0;
      ownerDrawByCurrency.set(
        t.currency,
        money((ownerDrawByCurrency.get(t.currency) ?? 0) + amt),
      );
    }

    // REC-2: unreconcilable debits (blank id / non-finite amount) are real money
    // that can't be matched — they must block an all-clear, or ✅ would hide them.
    const caughtUp = sawBankTxns && sawExpenseSync &&
      gap.length === 0 && mismatch.length === 0 && duplicates.length === 0 &&
      unreconcilableDebits === 0;

    // ── notes ──
    const notes: string[] = [];
    if (!sawExpenseSync) {
      notes.push(
        "No `expenseSync` output in this run — the write path " +
          "(`upsertExpenses`) has not run, so there is nothing to reconcile against yet.",
      );
    }
    if (!sawBankTxns) {
      notes.push(
        "No `BankTxn` snapshot detected — the source step " +
          "(`@shrug/mercury` / `@shrug/bank-import`) has not run in this workflow.",
      );
    }
    if (anyDryRun) {
      notes.push(
        "expenseSync was produced in **dryRun** mode — 'recorded' keys reflect " +
          "pre-existing IN expenses only, not this run's projected creates.",
      );
    }
    if (unreconcilableDebits > 0) {
      notes.push(
        `${unreconcilableDebits} posted debit(s) have a **blank id or non-numeric ` +
          "amount** and cannot be reconciled — fix the source dedup key/amount " +
          "(RECON-002). They are excluded from the counts and block a caught-up result.",
      );
    }
    if (!sawExpensesSnapshot) {
      notes.push(
        "Duplicate backstop ran against `expenseSync` created-rows only — add a " +
          "`listExpenses` step for an authoritative `custom_value1` duplicate check.",
      );
    }
    if (deletedReclassified > 0) {
      notes.push(
        `${deletedReclassified} expense(s) previously synced were **absent from ` +
          "the live Invoice Ninja snapshot** (soft-deleted in IN after sync) — " +
          "reclassified from matched to **gap** and listed above; re-run the write " +
          "path to re-create them (REC-DEL).",
      );
    }
    if (transfers.length > 0) {
      const transferTotalLabel = [...transferByCurrency.entries()]
        .map(([c, v]) => `${v.toFixed(2)} ${c}`).join(", ") || "0";
      notes.push(
        `${transfers.length} inter-account transfer(s) (${transferTotalLabel}) ` +
          "were **excluded** from the candidate set (§6.1) — they are not " +
          "business expenses, not a gap, and not duplicates.",
      );
    }
    if (ownerDraws.length > 0) {
      const ownerDrawTotalLabel = [...ownerDrawByCurrency.entries()]
        .map(([c, v]) => `${v.toFixed(2)} ${c}`).join(", ") || "0";
      notes.push(
        `${ownerDraws.length} owner draw(s) / ATM withdrawal(s) ` +
          `(${ownerDrawTotalLabel}) were **excluded** from the candidate set ` +
          "(owner-draw-exclusion) — equity draws, not business expenses, not a " +
          "gap, and not duplicates.",
      );
    }

    // ── markdown ──
    const gapTotalLabel = [...gapByCurrency.entries()]
      .map(([c, v]) => `${v.toFixed(2)} ${c}`).join(", ") || "0";

    // Every snapshot-derived cell is null-safed and passed through mdCell — a
    // null/`|`/HTML in counterparty (free text) or a dedup key/id must not break
    // the table or inject markup if the Markdown is rendered as raw HTML.
    const gapLines = gap
      .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
      .map((t) =>
        `| ${t.postedDate ?? "—"} | ${mdCell(t.counterparty ?? "—")} | ${
          (t.amount ?? 0).toFixed(2)
        } ${mdCell(t.currency)} | ${mdCell(t.source)} | ${mdCell(t.id)} |`
      );
    const mismatchLines = mismatch.map((m) =>
      `| ${m.txn.postedDate ?? "—"} | ${mdCell(m.txn.counterparty ?? "—")} | ${
        (m.txn.amount ?? 0).toFixed(2)
      } ${mdCell(m.txn.currency)} | ${
        m.recordedAmount === null ? "—" : m.recordedAmount.toFixed(2)
      } | ${mdCell(m.txn.id)} |`
    );
    const dupLines = duplicates.map((d) =>
      `| ${mdCell(d.key)} | ${d.count} | ${d.source} |`
    );
    const transferTotalLabel = [...transferByCurrency.entries()]
      .map(([c, v]) => `${v.toFixed(2)} ${c}`).join(", ") || "0";
    const transferLines = transfers
      .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
      .map((t) =>
        `| ${t.postedDate ?? "—"} | ${mdCell(t.counterparty ?? "—")} | ${
          (t.amount ?? 0).toFixed(2)
        } ${mdCell(t.currency)} | ${mdCell(t.kind ?? "—")} | ${mdCell(t.id)} |`
      );
    const ownerDrawTotalLabel = [...ownerDrawByCurrency.entries()]
      .map(([c, v]) => `${v.toFixed(2)} ${c}`).join(", ") || "0";
    const ownerDrawLines = ownerDraws
      .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
      .map((t) =>
        `| ${t.postedDate ?? "—"} | ${mdCell(t.counterparty ?? "—")} | ${
          (t.amount ?? 0).toFixed(2)
        } ${mdCell(t.currency)} | ${mdCell(t.id)} |`
      );

    const markdown = [
      "# Reconcile — am I caught up?",
      "",
      caughtUp
        ? `✅ **Caught up.** All ${candidates.length} posted debit(s) are recorded in Invoice Ninja with matching amounts, no duplicates.`
        : `Candidate posted debits: **${candidates.length}** · matched: **${matched}** · gap: **${gap.length}** (${gapTotalLabel}) · amount mismatch: **${mismatch.length}** · duplicates: **${duplicates.length}** · unreconcilable: **${unreconcilableDebits}**.`,
      "",
      ...(gap.length > 0
        ? [
          "## Gap — posted debits with no matching `custom_value1` in IN",
          "",
          "| Date | Counterparty | Amount | Source | Dedup key |",
          "| --- | --- | ---: | --- | --- |",
          ...gapLines,
          "",
        ]
        : []),
      ...(mismatch.length > 0
        ? [
          "## Amount mismatch — recorded in IN but the amount disagrees",
          "",
          "| Date | Counterparty | Source amount | IN amount | Dedup key |",
          "| --- | --- | ---: | ---: | --- |",
          ...mismatchLines,
          "",
        ]
        : []),
      ...(duplicates.length > 0
        ? [
          "## ⚠️ Duplicates — same dedup key on more than one IN expense",
          "",
          "| Dedup key | Count | Detected via |",
          "| --- | ---: | --- |",
          ...dupLines,
          "",
        ]
        : []),
      ...(transfers.length > 0
        ? [
          `## Transfers excluded — inter-account moves, not expenses (${transferTotalLabel})`,
          "",
          "| Date | Counterparty | Amount | Kind | Dedup key |",
          "| --- | --- | ---: | --- | --- |",
          ...transferLines,
          "",
        ]
        : []),
      ...(ownerDraws.length > 0
        ? [
          `## Owner draws excluded — ATM withdrawals / equity, not expenses (${ownerDrawTotalLabel})`,
          "",
          "| Date | Counterparty | Amount | Dedup key |",
          "| --- | --- | ---: | --- |",
          ...ownerDrawLines,
          "",
        ]
        : []),
      ...notes.map((n) => `> ${n}`),
      "",
    ].join("\n");

    return {
      markdown,
      json: {
        workflow: ctx.workflowName,
        caughtUp,
        candidateDebits: candidates.length,
        matched,
        deletedReclassified,
        dryRun: anyDryRun,
        sawExpenseSync,
        sawBankTxns,
        sawExpensesSnapshot,
        unreconcilableDebits,
        gap: {
          count: gap.length,
          byCurrency: Object.fromEntries(gapByCurrency),
          txns: gap.map((t) => ({
            id: t.id,
            source: t.source,
            postedDate: t.postedDate,
            amount: t.amount,
            currency: t.currency,
            counterparty: t.counterparty,
          })),
        },
        mismatch: mismatch.map((m) => ({
          id: m.txn.id,
          sourceAmount: m.txn.amount,
          recordedAmount: m.recordedAmount,
          currency: m.txn.currency,
        })),
        duplicates,
        transfers: {
          count: transfers.length,
          byCurrency: Object.fromEntries(transferByCurrency),
          txns: transfers.map((t) => ({
            id: t.id,
            source: t.source,
            postedDate: t.postedDate,
            amount: t.amount,
            currency: t.currency,
            counterparty: t.counterparty,
            kind: t.kind ?? null,
          })),
        },
        ownerDraws: {
          count: ownerDraws.length,
          byCurrency: Object.fromEntries(ownerDrawByCurrency),
          txns: ownerDraws.map((t) => ({
            id: t.id,
            source: t.source,
            postedDate: t.postedDate,
            amount: t.amount,
            currency: t.currency,
            counterparty: t.counterparty,
          })),
        },
      },
    };
  },
};
