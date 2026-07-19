/**
 * Unit tests for the `@shrug/invoiceninja/ar-aging` report (Phase 3).
 *
 * The report is pure aggregation over the latest `invoices` snapshot, so the
 * test seam is the `ReportCtx.dataRepository.getContent` reader (the report-side
 * analogue of mercury's injected `fetch`): every case builds a `ReportCtx` whose
 * repository hands back an encoded `Snapshot<InvoiceRow>` (or null/garbage), runs
 * `report.execute`, and asserts on the returned `json`. No network, no
 * filesystem, no real model.
 *
 * `execute` reads UTC "today" from the system clock, so bucket-boundary cases
 * derive their `dueDate` as an offset from that same clock (`dueDaysAgo`) — both
 * the test and the report observe the same day except in the sub-millisecond
 * window around UTC midnight, which is the documented UTC caveat.
 *
 * Run with: `~/.swamp/deno/deno test -A extensions/reports/ar_aging_test.ts`
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { report } from "./ar_aging.ts";
import type { InvoiceRow, ReportCtx, Snapshot } from "./_lib/snapshots.ts";

/** A `ReportCtx` whose `invoices` snapshot is `rows` (null → no snapshot). */
function ctxWith(
  rows: InvoiceRow[] | null,
  opts: { retrievedAt?: string; garbage?: boolean } = {},
): ReportCtx {
  const { retrievedAt = "2026-07-16T00:00:00Z", garbage = false } = opts;
  let bytes: Uint8Array | null;
  if (garbage) {
    bytes = new TextEncoder().encode("{ not json");
  } else if (rows === null) {
    bytes = null;
  } else {
    const snap: Snapshot<InvoiceRow> = {
      scope: "model",
      count: rows.length,
      items: rows,
      retrievedAt,
    };
    bytes = new TextEncoder().encode(JSON.stringify(snap));
  }
  return {
    scope: "model",
    modelType: null,
    modelId: "m1",
    executionStatus: "succeeded",
    dataRepository: {
      getContent: (_type, _modelId, dataName) =>
        Promise.resolve(dataName === "invoices" ? bytes : null),
    },
  };
}

/** Minimal open (Sent, balance 100) invoice; override any field. */
function inv(partial: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "i",
    number: null,
    clientId: null,
    statusId: 2, // Sent → AR
    statusLabel: null,
    computedStatus: null,
    amount: null,
    balance: 100,
    paidToDate: null,
    date: null,
    dueDate: null,
    isDeleted: null,
    archivedAt: null,
    ...partial,
  };
}

/** A `YYYY-MM-DD` string that is `days` before (negative → after) UTC today. */
function dueDaysAgo(days: number): string {
  const today = Date.parse(
    `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
  );
  return new Date(today - days * 86_400_000).toISOString().slice(0, 10);
}

// deno-lint-ignore no-explicit-any
function json(out: { json: Record<string, unknown> }): any {
  return out.json;
}

Deno.test("bucket routing: current/1-30/31-60/61-90/90+ boundaries + undated", async () => {
  const rows = [
    inv({ id: "future", dueDate: dueDaysAgo(-5) }), // not yet due → current
    inv({ id: "d0", dueDate: dueDaysAgo(0) }), //       due today → current
    inv({ id: "d1", dueDate: dueDaysAgo(1) }), //       1 day     → 1-30
    inv({ id: "d30", dueDate: dueDaysAgo(30) }), //     30 days   → 1-30
    inv({ id: "d31", dueDate: dueDaysAgo(31) }), //     31 days   → 31-60
    inv({ id: "d60", dueDate: dueDaysAgo(60) }), //     60 days   → 31-60
    inv({ id: "d61", dueDate: dueDaysAgo(61) }), //     61 days   → 61-90
    inv({ id: "d90", dueDate: dueDaysAgo(90) }), //     90 days   → 61-90
    inv({ id: "d91", dueDate: dueDaysAgo(91) }), //     91 days   → 90+
    inv({ id: "undated", dueDate: null }), //           no date   → current
  ];
  const out = json(await report.execute(ctxWith(rows)));

  assertEquals(out.openInvoiceCount, 10);
  assertEquals(out.undatedOpenCount, 1);
  assertEquals(out.excludedNonArCount, 0);
  assertEquals(out.total, {
    "current": 300, // future + d0 + undated
    "1-30": 200, // d1 + d30
    "31-60": 200, // d31 + d60
    "61-90": 200, // d61 + d90
    "90+": 100, // d91
    all: 1000,
  });
});

Deno.test("SUM-1: a positive balance on a non-AR status is excluded and counted", async () => {
  const rows = [
    inv({ id: "sent", statusId: 2, dueDate: dueDaysAgo(10) }), // AR → counted
    inv({ id: "partial", statusId: 3, dueDate: dueDaysAgo(10) }), // AR → counted
    inv({ id: "draft", statusId: 1 }), //      Draft     → excluded
    inv({ id: "paid", statusId: 4 }), //       Paid      → excluded
    inv({ id: "cancelled", statusId: 5 }), //  Cancelled → excluded
    inv({ id: "reversed", statusId: 6 }), //   Reversed  → excluded
    inv({ id: "unknown", statusId: 99 }), //   unknown   → excluded
    inv({ id: "nullstatus", statusId: null }), // null   → excluded
  ];
  const out = json(await report.execute(ctxWith(rows)));

  assertEquals(out.openInvoiceCount, 2);
  assertEquals(out.excludedNonArCount, 6);
  assertEquals(out.total.all, 200);
});

Deno.test("soft-deleted and non-positive balances are dropped silently (not counted as non-AR)", async () => {
  const rows = [
    inv({ id: "live", dueDate: dueDaysAgo(5) }), //       counted
    inv({ id: "deleted", isDeleted: true, dueDate: dueDaysAgo(5) }), // dropped
    inv({ id: "zero", balance: 0 }), //                   dropped
    inv({ id: "credit", balance: -50 }), //               dropped
    inv({ id: "nullbal", balance: null }), //             dropped
  ];
  const out = json(await report.execute(ctxWith(rows)));

  assertEquals(out.openInvoiceCount, 1);
  assertEquals(out.excludedNonArCount, 0); // soft-delete/zero excluded before the AR check
  assertEquals(out.total.all, 100);
});

Deno.test("per-client grouping, sorted by total descending", async () => {
  const rows = [
    inv({ id: "a1", clientId: "small", balance: 25, dueDate: dueDaysAgo(5) }),
    inv({ id: "b1", clientId: "big", balance: 400, dueDate: dueDaysAgo(5) }),
    inv({ id: "b2", clientId: "big", balance: 100, dueDate: dueDaysAgo(45) }),
    inv({ id: "c1", dueDate: dueDaysAgo(5) }), // clientId null, balance 100 → "(no client)"
  ];
  const out = json(await report.execute(ctxWith(rows)));

  // Totals: big 500, "(no client)" 100, small 25 → descending.
  const clients = out.perClient.map((r: { clientId: string }) => r.clientId);
  assertEquals(clients, ["big", "(no client)", "small"]);
  const big = out.perClient.find((r: { clientId: string }) =>
    r.clientId === "big"
  );
  assertEquals(big.total, 500);
  assertEquals(big.buckets["1-30"], 400);
  assertEquals(big.buckets["31-60"], 100);
});

Deno.test("money is rounded to cents (no float drift)", async () => {
  const rows = [
    inv({ id: "p1", clientId: "x", balance: 0.1, dueDate: dueDaysAgo(5) }),
    inv({ id: "p2", clientId: "x", balance: 0.2, dueDate: dueDaysAgo(5) }),
  ];
  const out = json(await report.execute(ctxWith(rows)));
  assertEquals(out.total["1-30"], 0.3); // not 0.30000000000000004
  assertEquals(out.total.all, 0.3);
});

Deno.test("empty snapshot → zero open, no throw", async () => {
  const out = json(await report.execute(ctxWith([])));
  assertEquals(out.openInvoiceCount, 0);
  assertEquals(out.total.all, 0);
  assertEquals(out.snapshotRetrievedAt, "2026-07-16T00:00:00Z");
});

Deno.test("absent snapshot → null retrievedAt, no throw", async () => {
  const out = json(await report.execute(ctxWith(null)));
  assertEquals(out.openInvoiceCount, 0);
  assertEquals(out.snapshotRetrievedAt, null);
});

Deno.test("malformed snapshot bytes degrade to empty (never throws)", async () => {
  const out = json(await report.execute(ctxWith([], { garbage: true })));
  assertEquals(out.openInvoiceCount, 0);
  assertEquals(out.snapshotRetrievedAt, null);
});

Deno.test("null/scalar elements inside items[] are dropped, never throw (AR-SEC-1)", async () => {
  // A partially-written or hostile snapshot with a null row must not crash the
  // aggregation — parseSnapshot drops non-object elements.
  const rows = [
    inv({ id: "good", dueDate: dueDaysAgo(5) }),
    null as unknown as InvoiceRow,
    "oops" as unknown as InvoiceRow,
  ];
  const out = json(await report.execute(ctxWith(rows)));
  assertEquals(out.openInvoiceCount, 1);
  assertEquals(out.total.all, 100);
});

Deno.test("a dueDate carrying a time component still buckets by its date (AR-2)", async () => {
  // "…T12:00:00" must not degrade to NaN → `current`; it should age normally.
  const rows = [
    inv({ id: "timed", dueDate: `${dueDaysAgo(95)}T12:00:00` }),
  ];
  const out = json(await report.execute(ctxWith(rows)));
  assertEquals(out.total["90+"], 100);
  assertEquals(out.total.current, 0);
  assertEquals(out.undatedOpenCount, 0);
});

Deno.test("a clientId containing a pipe is escaped in the markdown table (AR-SEC-2)", async () => {
  const rows = [inv({ id: "x", clientId: "a|b", dueDate: dueDaysAgo(5) })];
  const md = (await report.execute(ctxWith(rows))).markdown;
  assertEquals(md.includes("a\\|b"), true); // escaped, column alignment intact
  assertEquals(md.includes("| a|b |"), false);
});

Deno.test("markdown carries the headline, total row, and SUM-1 note", async () => {
  const rows = [
    inv({ id: "sent", dueDate: dueDaysAgo(10) }),
    inv({ id: "draft", statusId: 1 }), // excluded → note
  ];
  const md = (await report.execute(ctxWith(rows))).markdown;
  assertEquals(md.includes("# AR Aging"), true);
  assertEquals(md.includes("**Total**"), true);
  assertEquals(md.includes("excluded as non-AR"), true);
});
