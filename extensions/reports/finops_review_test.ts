/**
 * Unit tests for the `@shrug/invoiceninja/finops-review` report.
 *
 * The report is pure aggregation over the retained `expenseSync*` resources, so
 * the test seam is the model-scope `dataRepository`: `findAllForModel` (returns
 * the LATEST version per data NAME — no version history) + `getContent(…, name)`
 * (per-name bytes). Each fan-out child writes its OWN `expenseSync--<scope>`
 * resource (V1.1), so a run appears as several NAMES, not several versions of one
 * name. Every case builds a ctx whose repository hands back a set of NAMED
 * `expenseSync` snapshots and asserts on the returned `json`. No network, no
 * filesystem, no real model.
 *
 * Run with: `~/.swamp/deno/deno test -A extensions/reports/finops_review_test.ts`
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { report } from "./finops_review.ts";

interface Row {
  dedupKey: string;
  action: "skip" | "would-create" | "created";
  amount: number | null;
  date: string | null;
  projectedVendor?: string | null;
  projectedCategory?: string | null;
  counterparty?: string | null;
  source?: string | null;
}
interface Snap {
  /** Resource name; defaults to a unique `expenseSync--s<i>` per entry. */
  name?: string;
  scope: string;
  rows: Row[];
  dryRun?: boolean;
  retrievedAt?: string;
}
/** A resource whose bytes are unparseable (simulates corruption). */
interface Garbage {
  name?: string;
  garbage: true;
}
type Entry = Snap | Garbage;

/**
 * Build a model-scope ctx over `entries`. Each entry becomes a distinct data
 * NAME (findAllForModel returns latest-per-name), and `getContent` keys by name.
 * Entry order is irrelevant — the report orders by `retrievedAt`.
 */
// deno-lint-ignore no-explicit-any
function ctxWith(entries: Entry[]): any {
  const bytesByName = new Map<string, Uint8Array | null>();
  const metas: Array<{ name: string; version: number }> = [];
  entries.forEach((e, i) => {
    const name = e.name ?? `expenseSync--s${i}`;
    metas.push({ name, version: 1 });
    if ((e as Garbage).garbage) {
      bytesByName.set(name, new TextEncoder().encode("{ not json"));
    } else {
      const s = e as Snap;
      const env = {
        scope: s.scope,
        rows: s.rows,
        dryRun: s.dryRun ?? true,
        retrievedAt: s.retrievedAt ?? "2026-08-02T00:00:00Z",
      };
      bytesByName.set(name, new TextEncoder().encode(JSON.stringify(env)));
    }
  });
  return {
    scope: "model",
    modelType: null,
    modelId: "invoiceninja-prod",
    executionStatus: "succeeded",
    dataRepository: {
      findAllForModel: (_type: unknown, _modelId: string) =>
        Promise.resolve(metas),
      getContent: (
        _type: unknown,
        _modelId: string,
        dataName: string,
        _version?: number,
      ) => Promise.resolve(bytesByName.get(dataName) ?? null),
    },
  };
}

function row(partial: Partial<Row> = {}): Row {
  return {
    dedupKey: "k",
    action: "would-create",
    amount: 100,
    date: "2026-07-20",
    counterparty: "Acme",
    source: "mercury",
    ...partial,
  };
}

Deno.test("unions every per-source resource and splits new vs synced per source", async () => {
  // Real V1.1 shape: each fan-out child writes its OWN resource NAME, all within
  // seconds of each other. Every name must be unioned into one candidate set.
  const ctx = ctxWith([
    {
      name: "expenseSync--mercury-1",
      scope: "mercury-1",
      retrievedAt: "2026-08-02T10:00:00Z",
      rows: [
        row({ dedupKey: "m1", action: "would-create", amount: 50, source: "mercury" }),
        row({ dedupKey: "m2", action: "skip", amount: 20, source: "mercury" }),
      ],
    },
    {
      name: "expenseSync--mercury-2",
      scope: "mercury-2",
      retrievedAt: "2026-08-02T10:00:02Z",
      rows: [
        row({ dedupKey: "m3", action: "would-create", amount: 30, source: "mercury" }),
      ],
    },
    {
      name: "expenseSync--ynab",
      scope: "ynab",
      retrievedAt: "2026-08-02T10:00:04Z",
      rows: [
        row({ dedupKey: "y1", action: "would-create", amount: 10, source: "ynab" }),
        row({ dedupKey: "y2", action: "skip", amount: 5, source: "ynab" }),
      ],
    },
  ]);

  const { json } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  assertEquals(s.new, { n: 3, amt: 90 }); // m1 + m3 + y1
  assertEquals(s.synced, { n: 2, amt: 25 }); // m2 + y2
  assertEquals((s.bySource as Record<string, Any>).mercury, {
    new: 2,
    synced: 1,
    amt: 100,
  });
  assertEquals((s.bySource as Record<string, Any>).ynab, {
    new: 1,
    synced: 1,
    amt: 15,
  });
  assertEquals((json.rows as unknown[]).length, 5);
  assertEquals(s.versionsUnioned, 3);
});

Deno.test("excludes a stale resource for a scope absent from this run (recency cluster)", async () => {
  // A since-closed Mercury account's resource lingers with an OLD retrievedAt (it
  // wasn't overwritten this run). The recency cluster (newest ± finopsRunGapMinutes)
  // must drop it while keeping this run's names.
  const ctx = ctxWith([
    {
      name: "expenseSync--mercury-closed",
      scope: "mercury-closed",
      retrievedAt: "2026-08-01T10:00:00Z", // yesterday — stale
      rows: [row({ dedupKey: "OLD-m", amount: 999 })],
    },
    {
      name: "expenseSync--mercury-1",
      scope: "mercury-1",
      retrievedAt: "2026-08-02T10:00:00Z",
      rows: [row({ dedupKey: "NEW-m1", amount: 7 })],
    },
    {
      name: "expenseSync--ynab",
      scope: "ynab",
      retrievedAt: "2026-08-02T10:00:05Z",
      rows: [row({ dedupKey: "NEW-y1", amount: 3 })],
    },
  ]);

  const { json } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  // Only this run's 2 rows; yesterday's 999 must be excluded.
  assertEquals(s.new, { n: 2, amt: 10 });
  assertEquals(s.versionsUnioned, 2);
  assertEquals((json.rows as Array<{ counterparty: string | null }>).length, 2);
});

Deno.test("FR-1: a resource with an unparseable retrievedAt is EXCLUDED (not unioned forever) and noted", async () => {
  const ctx = ctxWith([
    {
      name: "expenseSync--ynab",
      scope: "ynab",
      retrievedAt: "2026-08-02T10:00:00Z", // valid → anchors the window
      rows: [row({ dedupKey: "good", action: "would-create", amount: 9, source: "ynab" })],
    },
    {
      name: "expenseSync--mercury-x",
      scope: "mercury-x",
      retrievedAt: "not-a-timestamp", // unparseable → can't be placed in the run
      rows: [row({ dedupKey: "stale", action: "would-create", amount: 999, source: "mercury" })],
    },
  ]);
  const { json, markdown } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  assertEquals(s.new, { n: 1, amt: 9 }); // the 999 must NOT be unioned
  assertEquals(s.versionsUnioned, 1);
  assertEquals((s.bySource as Record<string, Any>).mercury, undefined);
  assertEquals(markdown.includes("unparseable `retrievedAt`"), true);
});

Deno.test("FR-1: if NO resource has a parseable timestamp, all are included (best effort)", async () => {
  const ctx = ctxWith([
    { name: "expenseSync--a", scope: "a", retrievedAt: "nope", rows: [row({ dedupKey: "a1", amount: 3 })] },
    { name: "expenseSync--b", scope: "b", retrievedAt: "zzz", rows: [row({ dedupKey: "b1", amount: 4 })] },
  ]);
  const { json } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  assertEquals(s.new, { n: 2, amt: 7 });
  assertEquals(s.versionsUnioned, 2);
});

Deno.test("FR-6: blank-dedupKey rows are NOT merged across scopes (synced tally not under-counted)", async () => {
  const ctx = ctxWith([
    {
      name: "expenseSync--mercury-1",
      scope: "mercury-1",
      retrievedAt: "2026-08-02T10:00:00Z",
      rows: [{ dedupKey: "", action: "skip", amount: 5, date: "2026-07-20", source: "mercury" } as Row],
    },
    {
      name: "expenseSync--mercury-2",
      scope: "mercury-2",
      retrievedAt: "2026-08-02T10:00:02Z",
      rows: [{ dedupKey: "", action: "skip", amount: 7, date: "2026-07-21", source: "mercury" } as Row],
    },
  ]);
  const { json } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  // Two distinct no-id skips — must count as 2 synced, not collapse to 1.
  assertEquals(s.synced, { n: 2, amt: 12 });
  assertEquals((json.rows as unknown[]).length, 2);
});

Deno.test("expenseSyncErrors resources are NEVER unioned (name-filtered out)", async () => {
  // The error-audit resource shares the `expenseSync` stem but must not enter the
  // candidate set — neither `=== "expenseSync"` nor `startsWith("expenseSync--")`.
  const ctx = ctxWith([
    {
      name: "expenseSync--mercury-1",
      scope: "mercury-1",
      retrievedAt: "2026-08-02T10:00:00Z",
      rows: [row({ dedupKey: "real", action: "would-create", amount: 12, source: "mercury" })],
    },
    {
      // Same shape (rows[]) so it WOULD change totals if wrongly unioned.
      name: "expenseSyncErrors--ynab",
      scope: "ynab",
      retrievedAt: "2026-08-02T10:00:03Z",
      rows: [row({ dedupKey: "err", action: "would-create", amount: 500, source: "ynab" })],
    },
  ]);

  const { json } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  assertEquals(s.new, { n: 1, amt: 12 }); // only the real expenseSync resource
  assertEquals(s.versionsUnioned, 1);
  assertEquals((json.rows as unknown[]).length, 1);
  assertEquals((s.bySource as Record<string, Any>).ynab, undefined);
});

Deno.test("back-compat: the legacy bare `expenseSync` name is still unioned", async () => {
  const ctx = ctxWith([
    {
      name: "expenseSync", // pre-V1.1 constant name
      scope: "expenseSync",
      retrievedAt: "2026-08-02T10:00:00Z",
      rows: [row({ dedupKey: "legacy", action: "would-create", amount: 42, source: "mercury" })],
    },
  ]);
  const { json } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  assertEquals(s.new, { n: 1, amt: 42 });
  assertEquals(s.versionsUnioned, 1);
});

Deno.test("back-compat: a pre-finops snapshot (no source/counterparty) parses and buckets as unknown", async () => {
  const ctx = ctxWith([
    {
      scope: "mercury:acct1",
      rows: [
        // No `source`/`counterparty` fields at all — the pre-finops shape.
        { dedupKey: "old1", action: "would-create", amount: 40, date: "2026-07-01" },
        { dedupKey: "old2", action: "skip", amount: 60, date: "2026-07-02" },
      ] as Row[],
    },
  ]);

  const { json } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  assertEquals(s.new, { n: 1, amt: 40 });
  assertEquals(s.synced, { n: 1, amt: 60 });
  assertEquals((s.bySource as Record<string, Any>).unknown, {
    new: 1,
    synced: 1,
    amt: 100,
  });
  const first = (json.rows as Array<{ counterparty: string | null }>)[0];
  assertEquals(first.counterparty, null);
});

Deno.test("dedups by dedupKey across resources, newest (by retrievedAt) wins", async () => {
  const ctx = ctxWith([
    {
      name: "expenseSync--a",
      scope: "a",
      retrievedAt: "2026-08-02T10:00:00Z",
      rows: [row({ dedupKey: "dup", action: "skip", amount: 1 })],
    },
    {
      name: "expenseSync--b",
      scope: "b",
      retrievedAt: "2026-08-02T10:00:02Z", // newer
      rows: [row({ dedupKey: "dup", action: "would-create", amount: 2 })],
    },
  ]);
  const { json } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  // Both names are within the recency window (no boundary), but the shared
  // dedupKey collapses to one row — the newest (would-create / amount 2).
  assertEquals((json.rows as unknown[]).length, 1);
  assertEquals(s.new, { n: 1, amt: 2 });
  assertEquals(s.synced, { n: 0, amt: 0 });
});

Deno.test("no expenseSync resources → empty summary with a note, never throws", async () => {
  const ctx = ctxWith([]);
  const { json, markdown } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  assertEquals(s.new, { n: 0, amt: 0 });
  assertEquals(s.synced, { n: 0, amt: 0 });
  assertEquals((json.rows as unknown[]).length, 0);
  assertEquals(markdown.includes("No `expenseSync` resources found"), true);
});

Deno.test("a garbage resource is skipped without aborting the union", async () => {
  const ctx = ctxWith([
    {
      name: "expenseSync--good",
      scope: "s1",
      retrievedAt: "2026-08-02T10:00:00Z",
      rows: [row({ dedupKey: "a", amount: 11 })],
    },
    { name: "expenseSync--bad", garbage: true },
  ]);
  const { json } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  // Garbage is skipped; the real resource still aggregates.
  assertEquals(s.new, { n: 1, amt: 11 });
  assertEquals((json.rows as unknown[]).length, 1);
});

Deno.test("a corrupted non-numeric amount renders without throwing (never-throw contract)", async () => {
  const ctx = ctxWith([
    {
      scope: "expenseSync",
      rows: [
        // A legacy/corrupted row whose amount is a string — must not reach
        // .toFixed() and abort the report.
        { dedupKey: "bad", action: "would-create", amount: "oops", date: "2026-07-20", source: "mercury" } as unknown as Row,
      ],
    },
  ]);
  const { json, markdown } = await report.execute(ctx);
  const s = json.summary as Record<string, Any>;
  // The bad amount contributes 0 to the tally and renders as null in rows.
  assertEquals(s.new, { n: 1, amt: 0 });
  assertEquals((json.rows as Array<{ amount: number | null }>)[0].amount, null);
  assertEquals(markdown.includes("0.00"), true);
});

// Local alias so the casts above read cleanly.
// deno-lint-ignore no-explicit-any
type Any = any;
