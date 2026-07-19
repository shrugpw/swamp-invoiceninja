/**
 * Unit tests for the `@shrug/invoiceninja/expense-summary` report (Phase 3).
 *
 * Pure aggregation over the `expenses` snapshot enriched by `expenseCategories`
 * and `vendors`, so the seam is `ReportCtx.dataRepository.getContent` keyed by
 * resource name: each case builds a ctx that returns encoded `Snapshot` bytes
 * per resource (and optional `globalArgs` for the reporting period), runs
 * `report.execute`, and asserts on the returned `json`/`markdown`. No network,
 * no filesystem.
 *
 * Run with: `~/.swamp/deno/deno test -A extensions/reports/expense_summary_test.ts`
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { report } from "./expense_summary.ts";
import type {
  ExpenseRow,
  MapRow,
  ReportCtx,
  Snapshot,
} from "./_lib/snapshots.ts";

function encode<T>(
  items: T[],
  retrievedAt = "2026-07-16T00:00:00Z",
): Uint8Array {
  const snap: Snapshot<T> = {
    scope: "model",
    count: items.length,
    items,
    retrievedAt,
  };
  return new TextEncoder().encode(JSON.stringify(snap));
}

/** ctx whose repo serves the given per-resource snapshots (null → absent). */
function ctxWith(
  data: {
    expenses?: ExpenseRow[] | null;
    categories?: MapRow[];
    vendors?: MapRow[];
    globalArgs?: Record<string, unknown>;
  },
): ReportCtx {
  const bytes: Record<string, Uint8Array | null> = {
    expenses: data.expenses === undefined
      ? encode<ExpenseRow>([])
      : data.expenses === null
      ? null
      : encode(data.expenses),
    expenseCategories: encode(data.categories ?? []),
    vendors: encode(data.vendors ?? []),
  };
  return {
    scope: "model",
    modelType: null,
    modelId: "m1",
    executionStatus: "succeeded",
    globalArgs: data.globalArgs,
    dataRepository: {
      getContent: (_type, _modelId, name) =>
        Promise.resolve(name in bytes ? bytes[name] : null),
    },
  };
}

/** Minimal expense (amount 100, dated, uncategorized/no-vendor); override fields. */
function exp(partial: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: "e",
    amount: 100,
    date: "2026-06-15",
    paymentDate: null,
    categoryId: null,
    vendorId: null,
    clientId: null,
    invoiceId: null,
    currencyId: null,
    derivedStatus: null,
    shouldBeInvoiced: null,
    customValue1: null,
    ...partial,
  };
}

// deno-lint-ignore no-explicit-any
function json(out: { json: Record<string, unknown> }): any {
  return out.json;
}

Deno.test("groups by category and vendor, labels enriched, sorted by total desc", async () => {
  const out = json(
    await report.execute(ctxWith({
      expenses: [
        exp({ id: "1", categoryId: "cat-a", vendorId: "v-1", amount: 300 }),
        exp({ id: "2", categoryId: "cat-b", vendorId: "v-1", amount: 50 }),
        exp({ id: "3", categoryId: "cat-a", vendorId: "v-2", amount: 100 }),
      ],
      categories: [{ id: "cat-a", name: "Travel" }, {
        id: "cat-b",
        name: "Meals",
      }],
      vendors: [{ id: "v-1", name: "Acme" }, { id: "v-2", name: "Globex" }],
    })),
  );

  assertEquals(out.expenseCount, 3);
  assertEquals(out.total, 450);
  // cat-a 400 > cat-b 50
  assertEquals(out.byCategory.map((g: { label: string }) => g.label), [
    "Travel",
    "Meals",
  ]);
  assertEquals(out.byCategory[0], {
    key: "cat-a",
    label: "Travel",
    count: 2,
    total: 400,
  });
  // v-1 350 > v-2 100
  assertEquals(
    out.byVendor.map((g: { label: string; total: number }) => [
      g.label,
      g.total,
    ]),
    [["Acme", 350], ["Globex", 100]],
  );
});

Deno.test("null category/vendor keys fall back to (uncategorized)/(no vendor); unmatched id kept raw", async () => {
  const out = json(
    await report.execute(ctxWith({
      expenses: [
        exp({ id: "1" }), // null cat + null vendor
        exp({ id: "2", categoryId: "ghost", vendorId: "vghost" }), // no mapping
      ],
      categories: [],
      vendors: [],
    })),
  );
  const catLabels = out.byCategory.map((g: { label: string }) => g.label);
  const venLabels = out.byVendor.map((g: { label: string }) => g.label);
  assertEquals(catLabels.includes("(uncategorized)"), true);
  assertEquals(catLabels.includes("ghost"), true); // unmatched id → raw
  assertEquals(venLabels.includes("(no vendor)"), true);
  assertEquals(venLabels.includes("vghost"), true);
});

Deno.test("period bounds (SUM-2): inclusive, open-ended, null-date excluded when bounded", async () => {
  const expenses = [
    exp({ id: "before", date: "2026-05-31" }),
    exp({ id: "from-edge", date: "2026-06-01" }), // == from → included
    exp({ id: "mid", date: "2026-06-15" }),
    exp({ id: "to-edge", date: "2026-06-30" }), // == to → included
    exp({ id: "after", date: "2026-07-01" }),
    exp({ id: "undated", date: null }), // excluded once a bound is set
  ];
  const scoped = json(
    await report.execute(ctxWith({
      expenses,
      globalArgs: { expenseFrom: "2026-06-01", expenseTo: "2026-06-30" },
    })),
  );
  assertEquals(scoped.expenseCount, 3); // from-edge, mid, to-edge
  assertEquals(scoped.period, { from: "2026-06-01", to: "2026-06-30" });

  // open-ended (only `to`): everything on/before 2026-06-30, still excludes undated
  const openTo = json(
    await report.execute(ctxWith({
      expenses,
      globalArgs: { expenseTo: "2026-06-30" },
    })),
  );
  assertEquals(openTo.expenseCount, 4); // before, from-edge, mid, to-edge

  // no bounds → all-time, undated INCLUDED
  const all = json(await report.execute(ctxWith({ expenses })));
  assertEquals(all.expenseCount, 6);
  assertEquals(all.period, { from: null, to: null });
});

Deno.test("a malformed globalArgs date bound is ignored (treated as absent)", async () => {
  const all = json(
    await report.execute(ctxWith({
      expenses: [
        exp({ id: "1", date: "2026-06-15" }),
        exp({ id: "2", date: null }),
      ],
      globalArgs: { expenseFrom: "06/01/2026", expenseTo: "not-a-date" },
    })),
  );
  assertEquals(all.period, { from: null, to: null }); // invalid → null → all-time
  assertEquals(all.expenseCount, 2); // undated included since unbounded
});

Deno.test("billable-but-uninvoiced = shouldBeInvoiced && invoiceId == null", async () => {
  const out = json(
    await report.execute(ctxWith({
      expenses: [
        exp({
          id: "bill",
          amount: 200,
          shouldBeInvoiced: true,
          invoiceId: null,
        }),
        exp({
          id: "already",
          amount: 999,
          shouldBeInvoiced: true,
          invoiceId: "inv-1",
        }),
        exp({
          id: "notflag",
          amount: 999,
          shouldBeInvoiced: false,
          invoiceId: null,
        }),
        exp({
          id: "nullflag",
          amount: 999,
          shouldBeInvoiced: null,
          invoiceId: null,
        }),
      ],
    })),
  );
  assertEquals(out.billableUninvoiced.count, 1);
  assertEquals(out.billableUninvoiced.total, 200);
  assertEquals(out.billableUninvoiced.expenseIds, ["bill"]);
});

Deno.test("money is cent-rounded across group and grand totals", async () => {
  const out = json(
    await report.execute(ctxWith({
      expenses: [
        exp({ id: "1", categoryId: "c", amount: 0.1 }),
        exp({ id: "2", categoryId: "c", amount: 0.2 }),
      ],
      categories: [{ id: "c", name: "Cents" }],
    })),
  );
  assertEquals(out.byCategory[0].total, 0.3);
  assertEquals(out.total, 0.3);
});

Deno.test("absent expenses snapshot → empty, null retrievedAt, no throw", async () => {
  const out = json(await report.execute(ctxWith({ expenses: null })));
  assertEquals(out.expenseCount, 0);
  assertEquals(out.total, 0);
  assertEquals(out.snapshotRetrievedAt, null);
  assertEquals(out.billableUninvoiced.count, 0);
});

Deno.test("a label with a pipe is escaped in the markdown table", async () => {
  const md = (await report.execute(ctxWith({
    expenses: [exp({ id: "1", categoryId: "c", amount: 10 })],
    categories: [{ id: "c", name: "A|B travel" }],
  }))).markdown;
  assertEquals(md.includes("A\\|B travel"), true);
  assertEquals(md.includes("| A|B travel |"), false);
});

Deno.test("a label with HTML is escaped (defense-in-depth vs raw-HTML rendering)", async () => {
  const md = (await report.execute(ctxWith({
    expenses: [exp({ id: "1", categoryId: "c", amount: 10 })],
    categories: [{ id: "c", name: "<script>alert(1)</script> & Co" }],
  }))).markdown;
  assertEquals(md.includes("<script>"), false);
  assertEquals(
    md.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co"),
    true,
  );
});

Deno.test("a to-edge date carrying a time suffix is still included (ES-1)", async () => {
  const out = json(
    await report.execute(ctxWith({
      expenses: [exp({ id: "edge", date: "2026-06-30T09:00:00" })],
      globalArgs: { expenseFrom: "2026-06-01", expenseTo: "2026-06-30" },
    })),
  );
  assertEquals(out.expenseCount, 1); // not dropped by the inclusive `to` bound
});

Deno.test("billable backlog is all-time — a period does not hide older owed expenses (ES-2)", async () => {
  const out = json(
    await report.execute(ctxWith({
      expenses: [
        exp({
          id: "old",
          date: "2026-01-10",
          amount: 500,
          shouldBeInvoiced: true,
          invoiceId: null,
        }),
        exp({
          id: "in-window",
          date: "2026-06-15",
          amount: 40,
          shouldBeInvoiced: true,
          invoiceId: null,
        }),
      ],
      globalArgs: { expenseFrom: "2026-06-01", expenseTo: "2026-06-30" },
    })),
  );
  // Summary respects the window (only the June expense)...
  assertEquals(out.expenseCount, 1);
  assertEquals(out.total, 40);
  // ...but the backlog is all-time: BOTH still-owed expenses appear.
  assertEquals(out.billableUninvoiced.scope, "all-time");
  assertEquals(out.billableUninvoiced.count, 2);
  assertEquals(out.billableUninvoiced.total, 540);
  assertEquals(out.billableUninvoiced.expenseIds.sort(), ["in-window", "old"]);
});

Deno.test("an impossible date bound is rejected → all-time (ES-4)", async () => {
  const out = json(
    await report.execute(ctxWith({
      expenses: [exp({ id: "1", date: "2026-06-15" })],
      globalArgs: { expenseFrom: "2026-13-40", expenseTo: "2026-02-31" },
    })),
  );
  assertEquals(out.period, { from: null, to: null }); // both impossible → dropped
  assertEquals(out.expenseCount, 1);
});

Deno.test("a row omitting shouldBeInvoiced/invoiceId is not billable (strict equality)", async () => {
  // parseSnapshot casts arbitrary JSON to ExpenseRow; a partially-written row
  // with those fields absent must not slip into the backlog.
  const partial = {
    id: "p",
    amount: 10,
    date: "2026-06-15",
  } as unknown as ExpenseRow;
  const out = json(
    await report.execute(ctxWith({ expenses: [partial] })),
  );
  assertEquals(out.billableUninvoiced.count, 0); // undefined !== true / !== null
});

Deno.test("byCategory / byVendor group totals reconcile with the grand total", async () => {
  const out = json(
    await report.execute(ctxWith({
      expenses: [
        exp({ id: "1", categoryId: "a", vendorId: "x", amount: 10 }),
        exp({ id: "2", categoryId: "b", vendorId: "x", amount: 20 }),
        exp({ id: "3", categoryId: "a", vendorId: null, amount: 5 }),
      ],
    })),
  );
  const catSum = out.byCategory.reduce(
    (s: number, g: { total: number }) => s + g.total,
    0,
  );
  const venSum = out.byVendor.reduce(
    (s: number, g: { total: number }) => s + g.total,
    0,
  );
  assertEquals(catSum, out.total);
  assertEquals(venSum, out.total);
  assertEquals(out.total, 35);
});
