/**
 * `@shrug/invoiceninja/finops-review` — the daily "what would today's sync do?"
 * report.
 *
 * The `daily-expense-sync` workflow fans `mercury-expense-sync` over the active
 * Mercury accounts then runs `ynab-expense-sync` once; each child ends in a
 * dry-run `upsertExpenses` that writes its OWN per-scope `expenseSync--<scope>`
 * resource on `invoiceninja-prod` (V1.1). So one daily run leaves one live
 * resource per scope (per Mercury account + one YNAB). This report unions
 * **exactly this run's** resources and answers, per source: which candidates are
 * NEW (need review before a live write) vs already SYNCED.
 *
 * ── Why model scope ──
 * A workflow-scope report on the parent is BLIND to the grandchild model-method
 * data handles (F3): the parent run record lists only `type: workflow` steps. A
 * model-scope report on `invoiceninja-prod` instead enumerates every retained
 * `expenseSync*` resource via `findAllForModel` — the one scope that sees the
 * combined multi-source set.
 *
 * ── Shared aggregation ──
 * All the logic (enumerate `expenseSync--*` names → newest-anchor recency window →
 * blank-key-safe dedup → per-source tally → renderers) lives in `_lib/finops.ts`,
 * shared with the `finopsDigest` model method so the summary/detailed markdown and
 * email HTML can never drift from this report's JSON. See design/finops-digest.md
 * and design/finops-daily-review-multisource-fix.md. This report is a thin caller:
 * it renders the DETAILED markdown and the JSON contract.
 *
 * Pure aggregation — no API calls (repo rules 3 & 8). Excluded buckets (transfers /
 * owner-draws / card-payments) are OUT OF SCOPE for V1: they never enter
 * `expenseSync`, so counting them would reintroduce the cross-model read removed.
 *
 * @module
 */

import {
  aggregateFinops,
  type FinopsRepo,
  renderDetailedMarkdown,
  toJson,
} from "./_lib/finops.ts";

/**
 * Structural slice of `ModelReportContext` (scope: "model"). `dataRepository`
 * satisfies {@link FinopsRepo} (`findAllForModel` + `getContent`).
 */
interface FinopsReportCtx {
  scope: string;
  modelType: unknown;
  modelId: string;
  dataRepository: FinopsRepo;
  executionStatus: "succeeded" | "failed";
  globalArgs?: Record<string, unknown>;
}

export const report = {
  name: "@shrug/invoiceninja/finops-review",
  description:
    "Daily dry-run projection: per source (Mercury/YNAB), which sync candidates are new (need review) vs already synced",
  scope: "model" as const,
  labels: ["invoiceninja", "finops", "expenses"],
  execute: async (
    ctx: FinopsReportCtx,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const agg = await aggregateFinops(
      ctx.dataRepository,
      ctx.modelType,
      ctx.modelId,
      ctx.globalArgs,
    );
    return { markdown: renderDetailedMarkdown(agg), json: toJson(agg) };
  },
};
