/**
 * Unit tests for the shared FinOps aggregator + renderers (`_lib/finops.ts`).
 *
 * The `finops-review` report and the `finopsDigest` method both call this, so
 * these cover the aggregation once and the three render formats. The report's own
 * `finops_review_test.ts` is the byte-identical-output regression guard for
 * `renderDetailedMarkdown` + `toJson`.
 *
 * Run: `~/.swamp/deno/deno test -A extensions/reports/_lib/finops_test.ts`
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  aggregateFinops,
  type ExpenseSyncRow,
  type FinopsRepo,
  renderDetailedMarkdown,
  renderEmailHtml,
  renderSummaryMarkdown,
  toJson,
} from "./finops.ts";

interface Entry {
  name?: string;
  scope: string;
  rows: ExpenseSyncRow[];
  dryRun?: boolean;
  retrievedAt?: string;
}

/** A FinopsRepo over `entries`: one data NAME each (latest-per-name). */
function repoWith(entries: Entry[]): FinopsRepo {
  const bytesByName = new Map<string, Uint8Array>();
  const metas: Array<{ name: string; version: number }> = [];
  entries.forEach((e, i) => {
    const name = e.name ?? `expenseSync--s${i}`;
    metas.push({ name, version: 1 });
    bytesByName.set(
      name,
      new TextEncoder().encode(JSON.stringify({
        scope: e.scope,
        rows: e.rows,
        dryRun: e.dryRun ?? true,
        retrievedAt: e.retrievedAt ?? "2026-08-02T10:00:00Z",
      })),
    );
  });
  return {
    findAllForModel: () => Promise.resolve(metas),
    getContent: (_t, _m, name) =>
      Promise.resolve(bytesByName.get(name) ?? null),
  };
}

function row(p: Partial<ExpenseSyncRow> = {}): ExpenseSyncRow {
  return {
    dedupKey: "k",
    action: "would-create",
    amount: 100,
    date: "2026-07-20",
    counterparty: "Acme",
    source: "mercury",
    ...p,
  };
}

function multiSource(): FinopsRepo {
  return repoWith([
    {
      name: "expenseSync--mercury-1",
      scope: "mercury-1",
      retrievedAt: "2026-08-02T10:00:00Z",
      rows: [
        row({ dedupKey: "m1", action: "would-create", amount: 50, source: "mercury", counterparty: "Hetzner" }),
        row({ dedupKey: "m2", action: "skip", amount: 20, source: "mercury" }),
      ],
    },
    {
      name: "expenseSync--ynab",
      scope: "ynab",
      retrievedAt: "2026-08-02T10:00:03Z",
      rows: [
        row({ dedupKey: "y1", action: "would-create", amount: 10, source: "ynab", counterparty: "Patreon" }),
        row({ dedupKey: "y2", action: "skip", amount: 5, source: "ynab" }),
      ],
    },
  ]);
}

Deno.test("aggregateFinops unions all sources and tallies per source", async () => {
  const agg = await aggregateFinops(multiSource(), null, "invoiceninja-prod", {});
  assertEquals(agg.overall.new, { n: 2, amt: 60 });
  assertEquals(agg.overall.synced, { n: 2, amt: 25 });
  assertEquals(agg.bySource.mercury, { new: 1, synced: 1, amt: 70 });
  assertEquals(agg.bySource.ynab, { new: 1, synced: 1, amt: 15 });
  assertEquals(agg.rows.length, 4);
  assertEquals(agg.unioned, 2);
});

Deno.test("toJson emits the {summary, rows} contract", async () => {
  const agg = await aggregateFinops(multiSource(), null, "m", {});
  const json = toJson(agg) as {
    summary: Record<string, unknown>;
    rows: unknown[];
  };
  assertEquals(json.summary.new, { n: 2, amt: 60 });
  assertEquals(json.summary.versionsUnioned, 2);
  assertEquals(json.rows.length, 4);
});

Deno.test("renderSummaryMarkdown: headline + per-source table, NO row detail", async () => {
  const agg = await aggregateFinops(multiSource(), null, "m", {});
  const md = renderSummaryMarkdown(agg);
  assertStringIncludes(md, "**2 new** ($60.00 to post) / 2 synced");
  assertStringIncludes(md, "| Source | New | New amt | Synced | Synced amt |");
  // Summary must NOT include the detailed per-row review table.
  assertEquals(md.includes("## New — need review"), false);
  assertEquals(md.includes("Hetzner"), false);
});

Deno.test("renderDetailedMarkdown: includes the New — need review table with rows", async () => {
  const agg = await aggregateFinops(multiSource(), null, "m", {});
  const md = renderDetailedMarkdown(agg);
  assertStringIncludes(md, "## New — need review");
  assertStringIncludes(md, "Hetzner");
  assertStringIncludes(md, "Patreon");
});

// DG-1: a byte-exact golden so a future whitespace/section-order change in the
// detailed renderer can't silently regress the report body the report emits.
const GOLDEN_DETAILED =
  `# FinOps daily review — 2026-08-02T10:00:00Z

Window 2026-07-19 → 2026-07-20. **1 new** / 1 synced across 2 candidate(s).

## Per source

| Source | New | New amt | Synced | Synced amt |
| --- | ---: | ---: | ---: | ---: |
| ynab | 1 | 10.00 | 1 | 5.00 |
| **Total** | 1 | 10.00 | 1 | 5.00 |

## New — need review

| Source | Counterparty | Amount | Date | Proj. vendor | Proj. category |
| --- | --- | ---: | --- | --- | --- |
| ynab | Patreon | 10.00 | 2026-07-20 | — | — |

> Unioned 1 expenseSync resource(s) from this run.
`;

Deno.test("renderDetailedMarkdown: byte-exact output (report-body regression guard)", async () => {
  const repo = repoWith([{
    name: "expenseSync--ynab",
    scope: "ynab",
    retrievedAt: "2026-08-02T10:00:00Z",
    rows: [
      row({ dedupKey: "y1", action: "would-create", amount: 10, date: "2026-07-20", counterparty: "Patreon", source: "ynab" }),
      row({ dedupKey: "y2", action: "skip", amount: 5, date: "2026-07-19", counterparty: "NameCheap", source: "ynab" }),
    ],
  }]);
  const agg = await aggregateFinops(repo, null, "m", {});
  assertEquals(renderDetailedMarkdown(agg), GOLDEN_DETAILED);
});

Deno.test("renderEmailHtml: self-contained, email-safe, table-based, with content", async () => {
  const agg = await aggregateFinops(multiSource(), null, "m", {});
  const html = renderEmailHtml(agg);
  assertStringIncludes(html, "<!doctype html>");
  assertStringIncludes(html, "</html>");
  // Email-safe: no external assets, no flex/grid layout.
  assertEquals(/<link|<script|\ssrc=/.test(html), false);
  assertEquals(/display:\s*(flex|grid)/.test(html), false);
  assertStringIncludes(html, "role=\"presentation\""); // table-based layout
  // Content present.
  assertStringIncludes(html, "Hetzner");
  assertStringIncludes(html, "dry run · preview");
});

Deno.test("renderEmailHtml: HTML-escapes a counterparty with angle brackets/ampersand", async () => {
  const repo = repoWith([{
    name: "expenseSync--mercury-1",
    scope: "mercury-1",
    rows: [row({ dedupKey: "x", counterparty: "A & B <script>", amount: 9 })],
  }]);
  const agg = await aggregateFinops(repo, null, "m", {});
  const html = renderEmailHtml(agg);
  assertStringIncludes(html, "A &amp; B &lt;script&gt;");
  assertEquals(html.includes("<script>"), false); // never raw
});

Deno.test("renderEmailHtml: empty new-list renders the empty state", async () => {
  const repo = repoWith([{
    name: "expenseSync--ynab",
    scope: "ynab",
    rows: [row({ dedupKey: "s1", action: "skip", amount: 5, source: "ynab" })],
  }]);
  const agg = await aggregateFinops(repo, null, "m", {});
  const html = renderEmailHtml(agg);
  assertStringIncludes(html, "Nothing to review.");
});

Deno.test("renderEmailHtml: a LIVE run shows the LIVE badge, not the dry-run badge", async () => {
  const repo = repoWith([{
    name: "expenseSync--ynab",
    scope: "ynab",
    dryRun: false,
    rows: [row({ dedupKey: "y1", amount: 5, source: "ynab" })],
  }]);
  const agg = await aggregateFinops(repo, null, "m", {});
  const html = renderEmailHtml(agg);
  assertStringIncludes(html, "LIVE run");
  assertEquals(html.includes("dry run · preview"), false);
});
