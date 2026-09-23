/**
 * Shared FinOps aggregation + renderers for the daily dry-run.
 *
 * One code path feeds BOTH the model-scope `@shrug/invoiceninja/finops-review`
 * report AND the `finopsDigest` model method — so the summary/detailed markdown
 * and the email HTML can never drift from the report's JSON. See
 * design/finops-digest.md and design/finops-daily-review-multisource-fix.md.
 *
 * `aggregateFinops` enumerates the per-scope `expenseSync[--<scope>]` resources
 * (V1.1: findAllForModel returns latest-per-name), isolates THIS run with a
 * newest-anchored recency window, dedups (blank-key safe), and tallies per source.
 * The renderers are pure functions of the returned {@link FinopsAggregate}.
 *
 * @module
 */

import { mdCell, money } from "./snapshots.ts";

/** Minimal data-repository surface — satisfied by both report ctx and method ctx. */
export interface FinopsRepo {
  findAllForModel(
    type: unknown,
    modelId: string,
  ): Promise<Array<{ name: string; version: number }>>;
  getContent(
    type: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

/** A row of the `expenseSync` resource (§4.5) with the additive finops fields. */
export interface ExpenseSyncRow {
  dedupKey: string;
  action: "skip" | "would-create" | "created";
  amount: number | null;
  date: string | null;
  projectedVendor?: string | null;
  projectedCategory?: string | null;
  counterparty?: string | null;
  source?: string | null;
}

/** The `expenseSync` envelope (`rows`, not `items`). */
export interface ExpenseSyncSnapshot {
  scope: string;
  rows: ExpenseSyncRow[];
  dryRun: boolean;
  retrievedAt: string;
}

/** A presentation row (post-aggregation): `new`/`synced`, amount number|null. */
export interface OutRow {
  action: "new" | "synced";
  source: string;
  counterparty: string | null;
  amount: number | null;
  date: string | null;
  projectedVendor: string | null;
  projectedCategory: string | null;
}

interface Tally {
  new: { n: number; amt: number };
  synced: { n: number; amt: number };
}

/** Everything the renderers need — the single aggregation result. */
export interface FinopsAggregate {
  overall: Tally;
  /** Insertion-ordered per-source tallies; sort keys where display needs it. */
  perSource: Map<string, Tally>;
  bySource: Record<string, { new: number; synced: number; amt: number }>;
  rows: OutRow[];
  windowStart: string | null;
  windowEnd: string | null;
  generatedAt: string | null;
  oldestIncluded: string | null;
  anyDryRun: boolean;
  /** In-scope-by-name resources excluded because their retrievedAt didn't parse. */
  unstamped: number;
  /** Count of resources unioned into this run's window. */
  unioned: number;
  /** Count of `expenseSync*` resources found (pre-window), for the empty check. */
  resourceCount: number;
}

const EXPENSE_SYNC = "expenseSync";
/** Prefix for per-scope expenseSync writes (V1.1): `expenseSync--<scope>`. */
const EXPENSE_SYNC_SCOPED_PREFIX = "expenseSync--";
/** Source label for a row whose `source` is absent/blank (pre-finops snapshot). */
export const UNKNOWN_SOURCE = "unknown";

/**
 * Is this resource name an `expenseSync` candidate set to union? Matches the
 * legacy bare `expenseSync` and every per-scope `expenseSync--<scope>` write,
 * while EXCLUDING `expenseSyncErrors[--<scope>]` (different shape; neither equals
 * `expenseSync` nor starts with `expenseSync--`, so both checks reject it).
 */
export function isExpenseSyncName(name: string): boolean {
  return name === EXPENSE_SYNC || name.startsWith(EXPENSE_SYNC_SCOPED_PREFIX);
}

/** Parse `expenseSync` bytes into a snapshot; never throws (null on failure). */
export function asExpenseSync(
  bytes: Uint8Array | null,
): ExpenseSyncSnapshot | null {
  if (!bytes || bytes.length === 0) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    if (!o || !Array.isArray(o.rows)) return null;
    return {
      scope: typeof o.scope === "string" ? o.scope : "",
      rows: o.rows.filter((r): r is ExpenseSyncRow =>
        typeof r === "object" && r !== null &&
        typeof (r as ExpenseSyncRow).dedupKey === "string"
      ),
      dryRun: o.dryRun === true,
      retrievedAt: typeof o.retrievedAt === "string" ? o.retrievedAt : "",
    };
  } catch {
    return null;
  }
}

/** A `would-create` row is NEW (needs review); `skip`/`created` are SYNCED. */
function isNew(action: string): boolean {
  return action === "would-create";
}

/** Parse an ISO timestamp to epoch ms; null if absent/unparseable. */
function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Minutes of clock gap that separate one daily run's writes from the next.
 * Overridable via the model's `finopsRunGapMinutes` global arg (default 30).
 */
function runGapMinutes(globalArgs?: Record<string, unknown>): number {
  const raw = globalArgs?.finopsRunGapMinutes;
  return typeof raw === "number" && raw > 0 ? raw : 30;
}

function emptyTally(): Tally {
  return { new: { n: 0, amt: 0 }, synced: { n: 0, amt: 0 } };
}

function addToTally(t: Tally, action: string, amount: number): void {
  const bucket = isNew(action) ? t.new : t.synced;
  bucket.n += 1;
  bucket.amt = money(bucket.amt + amount);
}

/**
 * Enumerate the per-scope `expenseSync[--<scope>]` resources, isolate THIS run
 * with a newest-anchored recency window, dedup, and tally per source. Pure
 * aggregation — no API calls beyond the injected repo reads (repo rules 3 & 8).
 */
export async function aggregateFinops(
  repo: FinopsRepo,
  modelType: unknown,
  modelId: string,
  globalArgs?: Record<string, unknown>,
): Promise<FinopsAggregate> {
  const all = await repo.findAllForModel(modelType, modelId);
  const syncMetas = all.filter((d) => isExpenseSyncName(d.name));

  // Fetch each name's latest snapshot; order by retrievedAt desc (per-name version
  // counters aren't comparable across names). Unparseable timestamps sort last.
  const snaps: Array<{ snap: ExpenseSyncSnapshot; ms: number | null }> = [];
  for (const d of syncMetas) {
    const snap = asExpenseSync(
      await repo.getContent(modelType, modelId, d.name, d.version),
    );
    if (!snap) continue;
    snaps.push({ snap, ms: parseMs(snap.retrievedAt) });
  }
  snaps.sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity));

  // Newest-anchored window: anchor = newest parseable write time; include a
  // snapshot iff within finopsRunGapMinutes of the anchor. Unparseable → excluded
  // (counted for a note). No parseable stamp at all → include all (best effort).
  const gapMs = runGapMinutes(globalArgs) * 60_000;
  const anchorMs = snaps.find((s) => s.ms !== null)?.ms ?? null;
  const rows: ExpenseSyncRow[] = [];
  let unioned = 0;
  let generatedAt: string | null = null;
  let oldestIncluded: string | null = null;
  let anyDryRun = false;
  let unstamped = 0;

  for (const { snap, ms } of snaps) {
    if (anchorMs !== null && ms === null) {
      unstamped += 1;
      continue;
    }
    if (anchorMs !== null && ms !== null && anchorMs - ms > gapMs) continue;
    if (generatedAt === null && snap.retrievedAt) {
      generatedAt = snap.retrievedAt;
    }
    if (snap.retrievedAt) oldestIncluded = snap.retrievedAt;
    if (snap.dryRun) anyDryRun = true;
    for (const r of snap.rows) rows.push(r);
    unioned += 1;
  }

  // Dedup by dedupKey (first/newest wins). A BLANK dedupKey ("") is not a real
  // key — never merge blanks, or N no-id skips across N scopes collapse to one.
  const byKey = new Map<string, ExpenseSyncRow>();
  const blankKeyRows: ExpenseSyncRow[] = [];
  for (const r of rows) {
    if (r.dedupKey === "") blankKeyRows.push(r);
    else if (!byKey.has(r.dedupKey)) byKey.set(r.dedupKey, r);
  }
  const deduped = [...byKey.values(), ...blankKeyRows];

  const overall = emptyTally();
  const perSource = new Map<string, Tally>();
  let windowStart: string | null = null;
  let windowEnd: string | null = null;

  const outRows: OutRow[] = deduped.map((r) => {
    const amount = typeof r.amount === "number" ? r.amount : 0;
    const source = (typeof r.source === "string" && r.source) || UNKNOWN_SOURCE;
    addToTally(overall, r.action, amount);
    const t = perSource.get(source) ?? emptyTally();
    addToTally(t, r.action, amount);
    perSource.set(source, t);
    if (r.date) {
      if (windowStart === null || r.date < windowStart) windowStart = r.date;
      if (windowEnd === null || r.date > windowEnd) windowEnd = r.date;
    }
    return {
      action: isNew(r.action) ? "new" : "synced",
      source,
      counterparty: typeof r.counterparty === "string" ? r.counterparty : null,
      amount: typeof r.amount === "number" ? r.amount : null,
      date: r.date ?? null,
      projectedVendor: r.projectedVendor ?? null,
      projectedCategory: r.projectedCategory ?? null,
    };
  });

  const bySource: Record<string, { new: number; synced: number; amt: number }> =
    {};
  for (const [src, t] of perSource) {
    bySource[src] = {
      new: t.new.n,
      synced: t.synced.n,
      amt: money(t.new.amt + t.synced.amt),
    };
  }

  return {
    overall,
    perSource,
    bySource,
    rows: outRows,
    windowStart,
    windowEnd,
    generatedAt,
    oldestIncluded,
    anyDryRun,
    unstamped,
    unioned,
    resourceCount: syncMetas.length,
  };
}

/** The report's JSON contract (unchanged): `{summary, rows}`. */
export function toJson(agg: FinopsAggregate): Record<string, unknown> {
  return {
    summary: {
      window: { start: agg.windowStart, end: agg.windowEnd },
      generatedAt: agg.generatedAt,
      new: agg.overall.new,
      synced: agg.overall.synced,
      bySource: agg.bySource,
      versionsUnioned: agg.unioned,
      dryRun: agg.anyDryRun,
    },
    rows: agg.rows,
  };
}

/** New rows sorted by amount desc — the ones that need Neil's eyes. */
function newRowsSorted(agg: FinopsAggregate): OutRow[] {
  return agg.rows
    .filter((r) => r.action === "new")
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
}

function windowLabel(agg: FinopsAggregate): string {
  return agg.windowStart && agg.windowEnd
    ? `${agg.windowStart} → ${agg.windowEnd}`
    : "(no dated rows)";
}

/** The `> …` provenance/warning notes, shared by summary + detailed markdown. */
function notesFor(agg: FinopsAggregate): string[] {
  const notes: string[] = [];
  if (agg.resourceCount === 0) {
    notes.push(
      "No `expenseSync` resources found — run `daily-expense-sync` first.",
    );
  } else {
    notes.push(
      `Unioned ${agg.unioned} expenseSync resource(s) from this run` +
        (agg.oldestIncluded && agg.generatedAt &&
            agg.oldestIncluded !== agg.generatedAt
          ? ` (${mdCell(agg.oldestIncluded)} → ${mdCell(agg.generatedAt)}).`
          : "."),
    );
    if (agg.unstamped > 0) {
      notes.push(
        `${agg.unstamped} \`expenseSync\` resource(s) had an unparseable \`retrievedAt\` ` +
          "and were EXCLUDED from the run window — a source may be missing below.",
      );
    }
    if (!agg.anyDryRun) {
      notes.push("These rows are from a LIVE run (`dryRun: false`).");
    }
  }
  if (agg.perSource.has(UNKNOWN_SOURCE)) {
    notes.push(
      "Some rows have no `source` (pre-finops snapshot) — bucketed as " +
        "`unknown`; re-run after the additive sink change to split them.",
    );
  }
  return notes;
}

/** The per-source markdown table (header, sep, body rows, total). */
function perSourceTableMd(agg: FinopsAggregate): string[] {
  const srcNames = [...agg.perSource.keys()].sort();
  const body = srcNames.map((s) => {
    const t = agg.perSource.get(s)!;
    return `| ${mdCell(s)} | ${t.new.n} | ${
      t.new.amt.toFixed(2)
    } | ${t.synced.n} | ${t.synced.amt.toFixed(2)} |`;
  });
  return [
    "| Source | New | New amt | Synced | Synced amt |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...body,
    `| **Total** | ${agg.overall.new.n} | ${
      agg.overall.new.amt.toFixed(2)
    } | ${agg.overall.synced.n} | ${agg.overall.synced.amt.toFixed(2)} |`,
  ];
}

/**
 * DETAILED markdown — BYTE-IDENTICAL to the finops-review report's historical
 * output (the report's tests are the regression guard).
 */
export function renderDetailedMarkdown(agg: FinopsAggregate): string {
  const newRows = newRowsSorted(agg);
  const newBody = newRows.map((r) =>
    `| ${mdCell(r.source)} | ${mdCell(r.counterparty ?? "—")} | ${
      (r.amount ?? 0).toFixed(2)
    } | ${mdCell(r.date ?? "—")} | ${mdCell(r.projectedVendor ?? "—")} | ${
      mdCell(r.projectedCategory ?? "—")
    } |`
  );
  return [
    `# FinOps daily review${agg.generatedAt ? ` — ${agg.generatedAt}` : ""}`,
    "",
    `Window ${
      windowLabel(agg)
    }. **${agg.overall.new.n} new** / ${agg.overall.synced.n} synced ` +
    `across ${agg.rows.length} candidate(s).`,
    "",
    "## Per source",
    "",
    ...perSourceTableMd(agg),
    "",
    "## New — need review",
    "",
    ...(newRows.length > 0
      ? [
        "| Source | Counterparty | Amount | Date | Proj. vendor | Proj. category |",
        "| --- | --- | ---: | --- | --- | --- |",
        ...newBody,
      ]
      : ["_None._"]),
    "",
    ...notesFor(agg).map((n) => `> ${n}`),
    "",
  ].join("\n");
}

/** SUMMARY markdown — headline + per-source table only (no row detail). */
export function renderSummaryMarkdown(agg: FinopsAggregate): string {
  const toPost = money(agg.overall.new.amt);
  return [
    `# FinOps daily review${agg.generatedAt ? ` — ${agg.generatedAt}` : ""}`,
    "",
    `Window ${windowLabel(agg)}. **${agg.overall.new.n} new** ($${
      toPost.toFixed(2)
    } to post) / ` +
    `${agg.overall.synced.n} synced across ${agg.rows.length} candidate(s).`,
    "",
    ...perSourceTableMd(agg),
    "",
    ...notesFor(agg).map((n) => `> ${n}`),
    "",
  ].join("\n");
}

/** HTML-escape a dynamic string for safe inline insertion into the email HTML. */
function esc(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * EMAIL-READY HTML — a self-contained, email-client-safe document. Inline styles
 * only (Gmail/Outlook strip <style> and flex/grid), table-based layout, ~640px
 * centered, no external fonts/images/JS. Renders standalone in a browser too.
 */
export function renderEmailHtml(agg: FinopsAggregate): string {
  const font =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const ink = "#17201c";
  const muted = "#5c6862";
  const border = "#e2e7e4";
  const newc = "#b4690e";
  const accent = "#0c8c79";
  const toPost = money(agg.overall.new.amt).toFixed(2);
  const gen = agg.generatedAt ?? "";
  const win = windowLabel(agg);
  const dryBadge = agg.anyDryRun
    ? `<span style="background:#e4f4ef;color:${accent};font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px">dry run · preview</span>`
    : `<span style="background:#f7e2df;color:#b23a2e;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px">LIVE run</span>`;

  const cell = (
    content: string,
    align = "left",
    extra = "",
  ) =>
    `<td style="padding:7px 10px;border-bottom:1px solid ${border};font-size:13px;text-align:${align};${extra}">${content}</td>`;
  const th = (content: string, align = "left") =>
    `<th style="padding:8px 10px;border-bottom:2px solid ${border};font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:${muted};text-align:${align};font-weight:600">${content}</th>`;

  // Per-source table
  const srcNames = [...agg.perSource.keys()].sort();
  const srcRows = srcNames.map((s) => {
    const t = agg.perSource.get(s)!;
    return `<tr>${cell(esc(s), "left", "font-weight:600")}${
      cell(String(t.new.n), "right", `color:${newc}`)
    }${cell("$" + t.new.amt.toFixed(2), "right")}${
      cell(String(t.synced.n), "right", `color:${muted}`)
    }${cell("$" + t.synced.amt.toFixed(2), "right", `color:${muted}`)}</tr>`;
  }).join("");
  const srcTotal = `<tr>${cell("<strong>Total</strong>")}${
    cell(`<strong>${agg.overall.new.n}</strong>`, "right", `color:${newc}`)
  }${
    cell("<strong>$" + agg.overall.new.amt.toFixed(2) + "</strong>", "right")
  }${cell(String(agg.overall.synced.n), "right", `color:${muted}`)}${
    cell("$" + agg.overall.synced.amt.toFixed(2), "right", `color:${muted}`)
  }</tr>`;

  // Needs-review table
  const newRows = newRowsSorted(agg);
  const reviewBody = newRows.length > 0
    ? newRows.map((r) =>
      `<tr>${cell(esc(r.source))}${cell(esc(r.counterparty ?? "—"))}${
        cell("$" + (r.amount ?? 0).toFixed(2), "right", "font-weight:600")
      }${cell(esc(r.date ?? "—"), "left", `color:${muted}`)}${
        cell(esc(r.projectedVendor ?? "—"), "left", `color:${muted}`)
      }${cell(esc(r.projectedCategory ?? "—"), "left", `color:${muted}`)}</tr>`
    ).join("")
    : `<tr><td colspan="6" style="padding:18px;text-align:center;color:${muted};font-size:13px">Nothing to review.</td></tr>`;

  const noteLines = notesFor(agg)
    .map((n) => esc(n.replace(/`/g, "")))
    .map((n) =>
      `<div style="font-size:12px;color:${muted};margin-top:4px">${n}</div>`
    ).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FinOps daily review${gen ? " — " + esc(gen) : ""}</title></head>
<body style="margin:0;padding:0;background:#f3f6f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f4;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid ${border};border-radius:12px;font-family:${font};color:${ink}">
  <tr><td style="padding:22px 24px 8px">
    <div style="font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:${muted};font-weight:600">Invoice Ninja · daily finops sync review · ${dryBadge}</div>
    <h1 style="font-size:22px;margin:10px 0 6px;font-weight:700">FinOps daily review</h1>
    <div style="font-size:13px;color:${muted}">Window ${esc(win)}${
    gen ? " · generated " + esc(gen) : ""
  }</div>
    <div style="font-size:15px;margin-top:12px"><strong style="color:${newc};font-size:20px">${agg.overall.new.n} new</strong> to review · <strong>$${toPost}</strong> to post · ${agg.overall.synced.n} already synced</div>
  </td></tr>
  <tr><td style="padding:12px 24px 4px">
    <div style="font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:${muted};font-weight:600;margin-bottom:6px">Per source</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <thead><tr>${th("Source")}${th("New", "right")}${th("New amt", "right")}${
    th("Synced", "right")
  }${th("Synced amt", "right")}</tr></thead>
      <tbody>${srcRows}${srcTotal}</tbody>
    </table>
  </td></tr>
  <tr><td style="padding:16px 24px 4px">
    <div style="font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:${muted};font-weight:600;margin-bottom:6px">New — need review</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <thead><tr>${th("Source")}${th("Counterparty")}${th("Amount", "right")}${
    th("Date")
  }${th("Proj. vendor")}${th("Proj. category")}</tr></thead>
      <tbody>${reviewBody}</tbody>
    </table>
  </td></tr>
  <tr><td style="padding:14px 24px 22px">
    ${noteLines}
    <div style="font-size:11px;color:${muted};margin-top:10px;border-top:1px solid ${border};padding-top:10px">Preview only — no expenses were written. Generated by <code>daily-expense-sync</code> → <code>@shrug/invoiceninja/finops-review</code> on <code>invoiceninja-prod</code>. USD.</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>
`;
}
