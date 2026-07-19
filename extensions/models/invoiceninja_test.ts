/**
 * Unit tests for the `@shrug/invoiceninja` model (Phase 1a, reads).
 *
 * Two layers:
 *  - Pure value-shaping helpers: null/number/bool coercion, the invoice/payment
 *    status-label maps, the `computedStatus` overdue derivation, `paymentables`
 *    flattening, expense-status derivation, and the row normalizers.
 *  - The read method paths driven through a mocked `fetch` seam
 *    ({@link FetchLike}); the tests inject a fake fetch so no network is hit —
 *    asserting the mandatory IN headers are on the wire, HTTP errors raise,
 *    `inFetchAll` accumulates across pages, and each method snapshots its
 *    resource with normalized fields.
 *
 * Run with: `deno test -A extensions/models/invoiceninja_test.ts`
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  applyOverlay,
  boolOrNull,
  buildNameIndex,
  computedInvoiceStatus,
  derivedExpenseStatus,
  distinctByNorm,
  type FetchLike,
  flattenPaymentables,
  inFetch,
  inFetchAll,
  INVOICE_STATUS,
  isCandidate,
  type Mapping,
  mapTxnToExpense,
  model,
  normalizeExpense,
  normalizeInvoice,
  normalizeMapItem,
  normalizePayment,
  normName,
  notDeleted,
  numOrNull,
  overlayAliases,
  overlayTargetFor,
  PAYMENT_STATUS,
  rawNameIndex,
  resolveByNorm,
  strOrNull,
  upsertExpense,
  vendorFor,
} from "./invoiceninja.ts";

/** Connection config type, derived from the seam so no `any` is needed. */
type Cfg = Parameters<typeof inFetch>[0];

/** Resolved config (token present; header expected on every request). */
const CFG = {
  baseUrl: "https://clients.example.com/api/v1",
  apiToken: "SEKRIT",
  perPage: 100,
  withTrashed: false,
  dryRun: true,
} as unknown as Cfg;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("strOrNull() coerces, empties to null", () => {
  assertEquals(strOrNull("x"), "x");
  assertEquals(strOrNull(7), "7");
  assertEquals(strOrNull(""), null);
  assertEquals(strOrNull(undefined), null);
  assertEquals(strOrNull(null), null);
});

Deno.test("numOrNull() coerces stringy numbers, nulls the rest", () => {
  assertEquals(numOrNull(12.5), 12.5);
  assertEquals(numOrNull("100.00"), 100);
  assertEquals(numOrNull(""), null);
  assertEquals(numOrNull("abc"), null);
  assertEquals(numOrNull(null), null);
});

Deno.test("boolOrNull() maps IN 0/1 truthiness", () => {
  assertEquals(boolOrNull(true), true);
  assertEquals(boolOrNull(1), true);
  assertEquals(boolOrNull("1"), true);
  assertEquals(boolOrNull(0), false);
  assertEquals(boolOrNull("0"), false);
  assertEquals(boolOrNull(null), null);
});

Deno.test("status maps match the verified §4.3 enums", () => {
  assertEquals(INVOICE_STATUS[2], "Sent");
  assertEquals(INVOICE_STATUS[4], "Paid");
  assertEquals(PAYMENT_STATUS[4], "Completed");
  assertEquals(PAYMENT_STATUS[6], "Refunded");
});

Deno.test("computedInvoiceStatus() derives overdue from balance + due date", () => {
  // Sent, positive balance, elapsed due date → Overdue (not stored in status_id).
  assertEquals(
    computedInvoiceStatus(2, 50, "2020-01-01", "2026-07-15"),
    "Overdue",
  );
  // Same but fully paid (zero balance) → keeps the stored label.
  assertEquals(
    computedInvoiceStatus(4, 0, "2020-01-01", "2026-07-15"),
    "Paid",
  );
  // Positive balance but due date not yet elapsed → stored label.
  assertEquals(
    computedInvoiceStatus(2, 50, "2099-01-01", "2026-07-15"),
    "Sent",
  );
  // Draft is never overdue even with an elapsed date.
  assertEquals(
    computedInvoiceStatus(1, 50, "2020-01-01", "2026-07-15"),
    "Draft",
  );
  // Partial (3) with an open balance past due → Overdue.
  assertEquals(
    computedInvoiceStatus(3, 10, "2020-01-01", "2026-07-15"),
    "Overdue",
  );
  // Unknown/absent status is never asserted as Overdue (label stays null).
  assertEquals(
    computedInvoiceStatus(null, 50, "2020-01-01", "2026-07-15"),
    null,
  );
});

Deno.test("flattenPaymentables() keeps invoice applications, drops credits", () => {
  const applied = flattenPaymentables({
    paymentables: [
      { invoice_id: "inv-9", amount: 50 },
      { credit_id: "cred-1", amount: 5 }, // no invoice_id → dropped
      { invoice_id: "", amount: 7 }, // blank invoice_id → dropped (no phantom row)
      { invoice_id: "inv-10", amount: "25.00" },
    ],
  });
  assertEquals(applied, [
    { invoiceId: "inv-9", amount: 50 },
    { invoiceId: "inv-10", amount: 25 },
  ]);
  assertEquals(flattenPaymentables({}), []);
});

Deno.test("derivedExpenseStatus() follows invoiced→paid→pending→logged", () => {
  assertEquals(derivedExpenseStatus({ invoice_id: "inv-1" }), "invoiced");
  assertEquals(derivedExpenseStatus({ payment_date: "2026-01-01" }), "paid");
  assertEquals(derivedExpenseStatus({ should_be_invoiced: true }), "pending");
  assertEquals(derivedExpenseStatus({}), "logged");
});

Deno.test("normalizeInvoice() lifts + derives, keeps id as a hashed string", () => {
  const inv = normalizeInvoice({
    id: "Wpmbk5ezJn",
    number: "0001",
    client_id: "cli-1",
    status_id: "2",
    amount: "100.00",
    balance: "40.00",
    paid_to_date: "60.00",
    date: "2026-01-01",
    due_date: "2020-06-01",
    is_deleted: 0,
    archived_at: 0,
  }, "2026-07-15");
  assertEquals(inv.id, "Wpmbk5ezJn");
  assertEquals(inv.statusId, 2);
  assertEquals(inv.statusLabel, "Sent");
  assertEquals(inv.computedStatus, "Overdue");
  assertEquals(inv.balance, 40);
  assertEquals(inv.isDeleted, false);
  assertEquals(inv.archivedAt, null); // 0 → null
});

Deno.test("normalizePayment() flattens paymentables + labels status", () => {
  const pay = normalizePayment({
    id: "pay-1",
    client_id: "cli-1",
    amount: "75.00",
    status_id: 4,
    type_id: 5,
    transaction_reference: "TXREF",
    paymentables: [{ invoice_id: "inv-9", amount: 75 }],
  });
  assertEquals(pay.statusLabel, "Completed");
  assertEquals(pay.typeId, 5);
  assertEquals(pay.typeLabel, null); // type enum deferred
  assertEquals(pay.appliedInvoices, [{ invoiceId: "inv-9", amount: 75 }]);
});

Deno.test("normalizeExpense() mirrors custom_value1 + derives status", () => {
  const exp = normalizeExpense({
    id: "exp-1",
    amount: "12.34",
    currency_id: "1",
    should_be_invoiced: true,
    custom_value1: "mercury-txn-abc",
  });
  assertEquals(exp.customValue1, "mercury-txn-abc");
  assertEquals(exp.currencyId, "1");
  assertEquals(exp.derivedStatus, "pending");
});

Deno.test("normalizeMapItem() reduces to {id, name, isDeleted, archivedAt}", () => {
  // (1) an ordinary live row: deletion fields default to null.
  assertEquals(normalizeMapItem({ id: "cat-1", name: "Software" }), {
    id: "cat-1",
    name: "Software",
    isDeleted: null,
    archivedAt: null,
  });
  // (1) is_deleted/archived_at are parsed; archived_at 0 → null.
  assertEquals(
    normalizeMapItem({
      id: "v-1",
      name: "Nimbus",
      is_deleted: true,
      archived_at: 1720000000,
    }),
    { id: "v-1", name: "Nimbus", isDeleted: true, archivedAt: 1720000000 },
  );
  assertEquals(
    normalizeMapItem({
      id: "v-2",
      name: "Live",
      is_deleted: false,
      archived_at: 0,
    })
      .archivedAt,
    null, // archived_at 0 → null
  );
});

Deno.test("notDeleted(): drops isDeleted===true, keeps false/absent (back-compat)", () => {
  assertEquals(notDeleted({ id: "a", name: "X", isDeleted: true }), false);
  assertEquals(notDeleted({ id: "a", name: "X", isDeleted: false }), true);
  assertEquals(notDeleted({ id: "a", name: "X" }), true); // absent ⇒ kept
});

Deno.test("applyOverlay(): translates a raw name to its target, passes others through, __proto__-safe", () => {
  const overlay = { "Nimbus AI": "Nimbus", "WIDGETCO TEAM": "Widget.Club" };
  assertEquals(applyOverlay("Nimbus AI", overlay), "Nimbus");
  assertEquals(applyOverlay("WIDGETCO TEAM", overlay), "Widget.Club");
  assertEquals(applyOverlay("ZoneHost", overlay), "ZoneHost"); // no entry → unchanged
  assertEquals(applyOverlay(null, overlay), null); // null passthrough
  // A counterparty literally named __proto__ must NOT read Object.prototype.
  assertEquals(applyOverlay("__proto__", overlay), "__proto__");
});

Deno.test("applyOverlay(): key match is case/whitespace-insensitive (SEC-1/COR-1 fix)", () => {
  // A hand-authored config key must catch real bank-string spelling drift, or
  // upsertVendors would create a DUPLICATE vendor (the sprawl this feature kills).
  const overlay = { "Nimbus AI": "Nimbus" };
  assertEquals(applyOverlay("nimbus ai", overlay), "Nimbus"); // lowercase
  assertEquals(applyOverlay("NIMBUS AI", overlay), "Nimbus"); // uppercase
  assertEquals(applyOverlay("  Nimbus AI  ", overlay), "Nimbus"); // whitespace
  assertEquals(applyOverlay("Anthropocene", overlay), "Anthropocene"); // NOT a partial match
});

Deno.test("overlayAliases(): resolves targets over live items, drops+warns an unresolved target", () => {
  const overlay = { "Nimbus AI": "Nimbus", Ghost: "Nonexistent" };
  const liveItems = [
    { id: "v-active", name: "Nimbus", isDeleted: false },
  ];
  const warnings: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warning: (m: string) => warnings.push(m),
    error: () => {},
    // deno-lint-ignore no-explicit-any
  } as any;
  const aliases = overlayAliases(
    Object.keys(overlay),
    overlay,
    liveItems,
    logger,
  );
  assertEquals(aliases, { "Nimbus AI": "v-active" }); // Ghost dropped (target absent)
  // (10) the "warns" half of the contract: the dropped target logs a warning.
  assertEquals(warnings.length, 1);
});

// ---------------------------------------------------------------------------
// Mocked fetch seam
// ---------------------------------------------------------------------------

/** A recorded fetch call. */
interface FetchRec {
  url: string;
  headers?: Record<string, string>;
}

/** Build a fake {@link FetchLike} returning a fixed `body`, recording url + headers. */
function fetcher(
  body: unknown,
  opts: { ok?: boolean; status?: number; statusText?: string } = {},
): { f: FetchLike; calls: FetchRec[] } {
  const calls: FetchRec[] = [];
  const f: FetchLike = (url, init) => {
    calls.push({ url, headers: init?.headers });
    return Promise.resolve({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      statusText: opts.statusText ?? "OK",
      json: () => Promise.resolve(body),
    });
  };
  return { f, calls };
}

/**
 * Build a fake {@link FetchLike} that pages: `pages[i]` is the `data[]` returned
 * for `?page=i+1`, with a `meta.pagination` reflecting the total page count.
 */
function pagedFetcher(
  pages: Array<Array<Record<string, unknown>>>,
): { f: FetchLike; calls: FetchRec[] } {
  const calls: FetchRec[] = [];
  const f: FetchLike = (url, init) => {
    calls.push({ url, headers: init?.headers });
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const data = pages[page - 1] ?? [];
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve({
          data,
          meta: {
            pagination: { current_page: page, total_pages: pages.length },
          },
        }),
    });
  };
  return { f, calls };
}

Deno.test("inFetch: sends the mandatory IN headers", async () => {
  const { f, calls } = fetcher({ data: [] });
  await inFetch(CFG, "GET", "invoices", {}, f);
  assertEquals(calls[0].headers?.["X-API-TOKEN"], "SEKRIT");
  assertEquals(calls[0].headers?.["X-Requested-With"], "XMLHttpRequest");
  assertEquals(calls[0].headers?.["Accept"], "application/json");
});

Deno.test("inFetch: raises on HTTP error status", async () => {
  const { f } = fetcher({}, {
    ok: false,
    status: 422,
    statusText: "Unprocessable Entity",
  });
  await assertRejects(
    () => inFetch(CFG, "GET", "invoices", {}, f),
    Error,
    "HTTP 422",
  );
});

Deno.test("inFetchAll: accumulates rows across pages", async () => {
  const { f, calls } = pagedFetcher([
    [{ id: "a" }, { id: "b" }],
    [{ id: "c" }],
  ]);
  const rows = await inFetchAll(CFG, "invoices", [], f);
  assertEquals(rows.map((r) => r.id), ["a", "b", "c"]);
  assertEquals(calls.length, 2); // stopped once current_page == total_pages
});

Deno.test("inFetchAll: stops after one page when meta.pagination is absent", async () => {
  const { f, calls } = fetcher({ data: [{ id: "a" }] }); // no meta at all
  const rows = await inFetchAll(CFG, "invoices", [], f);
  assertEquals(rows.map((r) => r.id), ["a"]);
  assertEquals(calls.length, 1);
});

Deno.test("inFetchAll: stops on an empty page even if pages remain", async () => {
  // total_pages claims 3, but page 2 comes back empty → stop, don't spin.
  const { f, calls } = pagedFetcher([[{ id: "a" }], [], [{ id: "c" }]]);
  const rows = await inFetchAll(CFG, "invoices", [], f);
  assertEquals(rows.map((r) => r.id), ["a"]);
  assertEquals(calls.length, 2);
});

Deno.test("inFetchAll: the maxPages valve caps a never-converging pager", async () => {
  // A misbehaving API that always echoes "current_page: 1" (never advancing)
  // and claims far more total_pages than the cap. Because the loop is driven by
  // the LOCAL page counter, it climbs and the cap terminates it — a regression
  // that trusted the echoed current_page would spin forever here.
  let served = 0;
  const f: FetchLike = (url) => {
    served++;
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve({
          data: [{ id: `row-${page}` }],
          meta: { pagination: { current_page: 1, total_pages: 999999 } },
        }),
    });
  };
  const warnings: string[] = [];
  const noop = (_m: string, _p?: Record<string, unknown>) => {};
  const logger = {
    debug: noop,
    info: noop,
    warning: (m: string, _p?: Record<string, unknown>) => warnings.push(m),
    error: noop,
  };
  const rows = await inFetchAll(CFG, "invoices", [], f, logger);
  // Bounded by maxPages (10000), and it terminates.
  assertEquals(rows.length, served);
  assertEquals(rows.length, 10000);
  // The last page requested is the cap, proving the counter advanced locally.
  assertEquals(rows[rows.length - 1].id, "row-10000");
  // Truncation is surfaced, not silent.
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("TRUNCATED"), true);
});

Deno.test("inFetchAll: appends with_trashed only when configured", async () => {
  const off = fetcher({ data: [] });
  await inFetchAll(CFG, "invoices", [], off.f);
  assertEquals(off.calls[0].url.includes("with_trashed"), false);

  const trashedCfg = {
    ...(CFG as object),
    withTrashed: true,
  } as unknown as Cfg;
  const on = fetcher({ data: [] });
  await inFetchAll(trashedCfg, "invoices", [], on.f);
  assertEquals(on.calls[0].url.includes("with_trashed=true"), true);
  // per_page comes from cfg on every request.
  assertEquals(on.calls[0].url.includes("per_page=100"), true);
});

// ---------------------------------------------------------------------------
// Method paths (injected fetch)
// ---------------------------------------------------------------------------

/** A recorded `writeResource` call. */
interface WriteCall {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

/** Stub ExecuteContext: no-op logger, recording writeResource, token config. */
function stubContext(cfg: Cfg = CFG) {
  const writes: WriteCall[] = [];
  const noop = (_m: string, _p?: Record<string, unknown>) => {};
  const context = {
    globalArgs: cfg,
    logger: { debug: noop, info: noop, warning: noop, error: noop },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { context, writes };
}

Deno.test("listInvoices: snapshots normalized invoices with computed overdue", async () => {
  const { f } = pagedFetcher([[
    {
      id: "inv-1",
      number: "0001",
      status_id: 2,
      balance: "40.00",
      amount: "100.00",
      due_date: "2020-01-01",
    },
  ]]);
  const { context, writes } = stubContext();
  await model.methods.listInvoices.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "invoices");
  assertEquals(writes[0].name, "invoices");
  const items = writes[0].data.items as Array<Record<string, unknown>>;
  assertEquals(items[0].id, "inv-1");
  assertEquals(items[0].statusLabel, "Sent");
  assertEquals(items[0].computedStatus, "Overdue");
});

Deno.test("listInvoices: filter qualifiers land in the scope name + query", async () => {
  const { f, calls } = pagedFetcher([[]]);
  const { context, writes } = stubContext();
  await model.methods.listInvoices.execute(
    // deno-lint-ignore no-explicit-any
    { clientId: "cli-7", clientStatus: "1,2,3,4", _fetch: f } as any,
    context,
  );
  // Qualifier values are URL-encoded in the scope name (commas → %2C).
  assertEquals(writes[0].name, "invoices:client=cli-7:status=1%2C2%2C3%2C4");
  assertEquals(calls[0].url.includes("client_id=cli-7"), true);
  // The comma-list value is URL-encoded on the wire, not just the key present.
  assertEquals(calls[0].url.includes("client_status=1%2C2%2C3%2C4"), true);
});

Deno.test("listExpenses: a colon in filter can't collide with the scope delimiter", async () => {
  const { f } = pagedFetcher([[]]);
  const { context, writes } = stubContext();
  await model.methods.listExpenses.execute(
    // A crafted filter that, unescaped, would forge a second qualifier.
    // deno-lint-ignore no-explicit-any
    { filter: "x:vendor=y", _fetch: f } as any,
    context,
  );
  // The ':' and '=' are percent-encoded, so the name has exactly one qualifier.
  assertEquals(writes[0].name, "expenses:filter=x%3Avendor%3Dy");
});

Deno.test("listPayments: flattens paymentables into appliedInvoices", async () => {
  const { f } = pagedFetcher([[
    {
      id: "pay-1",
      status_id: 4,
      paymentables: [
        { invoice_id: "inv-9", amount: 50 },
        { credit_id: "cred-1", amount: 5 },
      ],
    },
  ]]);
  const { context, writes } = stubContext();
  await model.methods.listPayments.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].spec, "payments");
  const items = writes[0].data.items as Array<Record<string, unknown>>;
  assertEquals(items[0].statusLabel, "Completed");
  assertEquals(items[0].appliedInvoices, [{ invoiceId: "inv-9", amount: 50 }]);
});

Deno.test("listPayments: accumulates a multi-page result through the method", async () => {
  const { f, calls } = pagedFetcher([
    [{ id: "pay-1", status_id: 4 }],
    [{ id: "pay-2", status_id: 1 }],
  ]);
  const { context, writes } = stubContext();
  await model.methods.listPayments.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  const items = writes[0].data.items as Array<Record<string, unknown>>;
  assertEquals(items.map((i) => i.id), ["pay-1", "pay-2"]);
  assertEquals(writes[0].data.count, 2);
  assertEquals(calls.length, 2); // the method paginated to completion
});

Deno.test("listExpenses: mirrors custom_value1 and passes ?filter=", async () => {
  const { f, calls } = pagedFetcher([[
    { id: "exp-1", custom_value1: "mercury-txn-abc", should_be_invoiced: true },
  ]]);
  const { context, writes } = stubContext();
  await model.methods.listExpenses.execute(
    // deno-lint-ignore no-explicit-any
    { filter: "mercury-txn-abc", _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].spec, "expenses");
  assertEquals(writes[0].name, "expenses:filter=mercury-txn-abc");
  const items = writes[0].data.items as Array<Record<string, unknown>>;
  assertEquals(items[0].customValue1, "mercury-txn-abc");
  assertEquals(items[0].derivedStatus, "pending");
  assertEquals(calls[0].url.includes("filter=mercury-txn-abc"), true);
});

Deno.test("expenseCategories: maps rows to {id, name}", async () => {
  const { f } = pagedFetcher([[
    { id: "cat-1", name: "Software" },
    { id: "cat-2", name: "Travel" },
  ]]);
  const { context, writes } = stubContext();
  await model.methods.expenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].spec, "expenseCategories");
  assertEquals(writes[0].name, "expenseCategories");
  const items = writes[0].data.items as Array<Record<string, unknown>>;
  assertEquals(items.length, 2);
  assertEquals(items[0], {
    id: "cat-1",
    name: "Software",
    isDeleted: null,
    archivedAt: null,
  });
});

Deno.test("vendors: maps rows to {id, name}", async () => {
  const { f } = pagedFetcher([[{ id: "ven-1", name: "AWS" }]]);
  const { context, writes } = stubContext();
  await model.methods.vendors.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].spec, "vendors");
  assertEquals((writes[0].data.items as Array<Record<string, unknown>>)[0], {
    id: "ven-1",
    name: "AWS",
    isDeleted: null,
    archivedAt: null,
  });
});

Deno.test("getInvoice: single record, non-paginated, keeps raw", async () => {
  const { f, calls } = fetcher({ data: { id: "inv-5", number: "0005" } });
  const { context, writes } = stubContext();
  await model.methods.getInvoice.execute(
    // deno-lint-ignore no-explicit-any
    { id: "inv-5", _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].spec, "invoice");
  assertEquals(writes[0].name, "invoice:inv-5");
  assertEquals((writes[0].data.raw as Record<string, unknown>).number, "0005");
  // include=client,payments,activities is requested.
  assertEquals(
    calls[0].url.includes("include=client%2Cpayments%2Cactivities"),
    true,
  );
});

Deno.test("getInvoice: rejects a path-traversal id at the schema boundary", () => {
  const schema = model.methods.getInvoice.arguments;
  // A valid IN hashid is accepted.
  assertEquals(schema.safeParse({ id: "Wpmbk5ezJn" }).success, true);
  // Anything with a path separator / dot-segment is rejected before it can
  // reach inFetch and escape the /api/v1/invoices/ prefix with the token.
  assertEquals(schema.safeParse({ id: "../../users/5" }).success, false);
  assertEquals(schema.safeParse({ id: "1/2" }).success, false);
  assertEquals(schema.safeParse({ id: "" }).success, false);
});

// ===========================================================================
// Gated write path (§4.4/§7) — Phase 2. Injected FetchLike, bugzilla pattern.
// ===========================================================================

/** Mapping tables (§7.3): USD currency id, one known vendor + category. */
const MAPPING: Mapping = {
  currencyId: "1",
  vendors: { "AWS": "vend-aws" },
  categories: { "software": "cat-sw" },
  fallbackCategoryId: "cat-fallback",
};

/** A candidate BankTxn (settled USD debit); override any field. */
function txn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn-1",
    source: "mercury",
    postedDate: "2026-07-14",
    amount: 50,
    direction: "debit",
    currency: "USD",
    counterparty: "AWS",
    description: "aws bill",
    rawCategory: "software",
    status: "posted",
    ...over,
  };
}

/** A recorded write-path fetch call. */
interface WFetchRec {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * A fake {@link FetchLike} that serves BOTH the paginated dedup GET and the
 * create POST. `existingByPage[i]` is the `data[]` returned for `?page=i+1` of
 * the dedup lookup; a POST returns `{data:{id}}` unless `throwPostWhenKey`
 * matches the body's `custom_value1` (then HTTP 500 → inFetch throws).
 */
function writeFetcher(
  opts: {
    existingByPage?: Array<Array<Record<string, unknown>>>;
    createdId?: string;
    throwPostWhenKey?: string;
  } = {},
): { f: FetchLike; calls: WFetchRec[] } {
  const calls: WFetchRec[] = [];
  const f: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    if ((init?.method ?? "GET") === "POST") {
      const body = init?.body
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};
      if (
        opts.throwPostWhenKey && body.custom_value1 === opts.throwPostWhenKey
      ) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Server Error",
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          Promise.resolve({ data: { id: opts.createdId ?? "exp-new" } }),
      });
    }
    const pages = opts.existingByPage ?? [[]];
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const data = pages[page - 1] ?? [];
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve({
          data,
          meta: {
            pagination: { current_page: page, total_pages: pages.length },
          },
        }),
    });
  };
  return { f, calls };
}

/** Count POST calls to /expenses in a recorded call list. */
function postCount(calls: WFetchRec[]): number {
  return calls.filter((c) => (c.method ?? "GET") === "POST").length;
}

// (1) mapTxnToExpense body shape ---------------------------------------------
Deno.test("mapTxnToExpense: dedup key + display mirror, number omitted, mapped ids", () => {
  const body = mapTxnToExpense(txn(), MAPPING);
  assertEquals(body.custom_value1, "txn-1"); // DEDUP KEY
  assertEquals(body.transaction_reference, "txn-1"); // display mirror
  assertEquals(body.amount, 50);
  assertEquals(body.date, "2026-07-14");
  assertEquals(body.currency_id, "1");
  assertEquals(body.vendor_id, "vend-aws");
  assertEquals(body.category_id, "cat-sw");
  assertEquals(body.public_notes, "aws bill");
  assertEquals("number" in body, false); // IN auto-assigns
});

Deno.test("mapTxnToExpense: unmatched vendor → null vendor_id, category falls back", () => {
  const body = mapTxnToExpense(
    txn({ counterparty: "Nobody", rawCategory: "unknown" }),
    MAPPING,
  );
  assertEquals(body.vendor_id, null);
  assertEquals(body.category_id, "cat-fallback");
  assertEquals(vendorFor("Nobody", MAPPING), null);
  assertEquals(vendorFor(null, MAPPING), null);
});

// (9) candidate gate ---------------------------------------------------------
Deno.test("isCandidate: only settled USD debits qualify", () => {
  assertEquals(isCandidate(txn()), true);
  assertEquals(isCandidate(txn({ direction: "credit" })), false);
  assertEquals(isCandidate(txn({ status: "pending" })), false);
  assertEquals(isCandidate(txn({ currency: "EUR" })), false);
});

// (6) a self-transfer is excluded even though it is a posted USD debit --------
Deno.test("isCandidate: an inter-account transfer is excluded (§6.1)", () => {
  assertEquals(isCandidate(txn({ isTransfer: true })), false);
});

// (7) back-compat: an ABSENT isTransfer is treated as non-transfer ------------
Deno.test("isCandidate: an absent isTransfer is a candidate (back-compat, §6.1)", () => {
  // A pre-§6.1 snapshot has no isTransfer field — `!== true` must NOT exclude it.
  const legacy = txn();
  delete legacy.isTransfer;
  assertEquals(isCandidate(legacy), true);
  assertEquals(isCandidate(txn({ isTransfer: false })), true);
});

// owner-draw-exclusion: an owner draw / ATM withdrawal is excluded -----------
Deno.test("isCandidate: an owner draw is excluded (owner-draw-exclusion)", () => {
  assertEquals(isCandidate(txn({ isOwnerDraw: true })), false);
});

// back-compat: an ABSENT isOwnerDraw is treated as non-owner-draw -------------
Deno.test("isCandidate: an absent isOwnerDraw is a candidate (back-compat)", () => {
  const legacy = txn();
  delete legacy.isOwnerDraw;
  assertEquals(isCandidate(legacy), true);
  assertEquals(isCandidate(txn({ isOwnerDraw: false })), true);
});

Deno.test("upsertExpense: a non-candidate skips and never POSTs [WSPEC-01/05]", async () => {
  const { f, calls } = writeFetcher();
  const r = await upsertExpense(
    CFG,
    txn({ direction: "credit" }),
    MAPPING,
    false,
    f,
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "non-candidate");
  assertEquals(calls.length, 0); // no dedup GET, no POST
});

// (9) a transfer skips with a DISTINCT reason and never POSTs -----------------
Deno.test("upsertExpense: a transfer skips with reason 'transfer', never POSTs (§6.1)", async () => {
  const { f, calls } = writeFetcher();
  const r = await upsertExpense(
    CFG,
    txn({ isTransfer: true }),
    MAPPING,
    false,
    f,
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "transfer"); // distinct from "non-candidate"
  assertEquals(calls.length, 0); // no dedup GET, no POST for a transfer
});

// an owner draw skips with a DISTINCT reason and never POSTs ------------------
Deno.test("upsertExpense: an owner draw skips with reason 'owner-draw', never POSTs", async () => {
  const { f, calls } = writeFetcher();
  const r = await upsertExpense(
    CFG,
    txn({ isOwnerDraw: true }),
    MAPPING,
    false,
    f,
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "owner-draw"); // distinct from "transfer"/"non-candidate"
  assertEquals(calls.length, 0); // no dedup GET, no POST for an owner draw
});

// (10) blank dedup key -------------------------------------------------------
Deno.test("upsertExpense: blank id → skip + reason, NEVER calls filter with '' [RECON-002]", async () => {
  const { f, calls } = writeFetcher();
  const r = await upsertExpense(CFG, txn({ id: "" }), MAPPING, false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "blank-dedup-key");
  assertEquals(calls.length, 0); // the guard precedes any ?filter= call
});

// (4) substring false-positive guard -----------------------------------------
Deno.test("upsertExpense: a substring-only custom_value1 is NOT treated as existing", async () => {
  // The filter substring-matched a row whose custom_value1 is "txn-1-extra".
  const { f } = writeFetcher({
    existingByPage: [[{
      id: "exp-x",
      custom_value1: "txn-1-extra",
      amount: 50,
    }]],
  });
  const r = await upsertExpense(CFG, txn(), MAPPING, true, f);
  assertEquals(r.action, "would-create"); // exact match required, none found
});

// (5) paginated dedup [WSPEC-02] ---------------------------------------------
Deno.test("upsertExpense: an exact match on page 2 is found — no duplicate create [WSPEC-02]", async () => {
  const { f, calls } = writeFetcher({
    existingByPage: [
      // page 1: substring hits only (filter is multi-column/substring)
      [{ id: "o1", custom_value1: "txn-10", amount: 1 }, {
        id: "o2",
        custom_value1: "txn-100",
        amount: 2,
      }],
      // page 2: the exact match
      [{ id: "exp-1", custom_value1: "txn-1", amount: 50 }],
    ],
  });
  const r = await upsertExpense(CFG, txn(), MAPPING, false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "already-exists");
  assertEquals(r.expenseId, "exp-1");
  assertEquals(postCount(calls), 0); // never POSTed
  assertEquals(calls.length, 2); // scanned both pages
});

Deno.test("upsertExpense: an exact match with a different amount flags exists-amount-mismatch [RECON-001]", async () => {
  const { f } = writeFetcher({
    existingByPage: [[{ id: "exp-1", custom_value1: "txn-1", amount: 5 }]], // was 50
  });
  const r = await upsertExpense(CFG, txn(), MAPPING, false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "exists-amount-mismatch");
});

// (11) real create -----------------------------------------------------------
Deno.test("upsertExpense: real create POSTs with mandatory headers, returns id [WSPEC-11]", async () => {
  const { f, calls } = writeFetcher({ createdId: "exp-777" });
  const r = await upsertExpense(CFG, txn(), MAPPING, false, f);
  assertEquals(r.action, "created");
  assertEquals(r.expenseId, "exp-777");
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.headers?.["X-API-TOKEN"], "SEKRIT");
  assertEquals(post.headers?.["X-Requested-With"], "XMLHttpRequest");
  assertEquals(post.headers?.["Content-Type"], "application/json");
  assertEquals(
    (JSON.parse(post.body!) as Record<string, unknown>).custom_value1,
    "txn-1",
  );
});

// (11b) hard-override end-to-end through the POST body -------------------------
Deno.test("upsertExpense: hard-override routes the POSTed category_id to the vendor category even when the txn carries a REAL rawCategory (§7.5 e2e)", async () => {
  const { f, calls } = writeFetcher({ createdId: "exp-778" });
  const m: Mapping = {
    currencyId: "1",
    vendors: { "AWS": "vend-aws" },
    categories: { "software": "cat-sw" }, // the real rawCategory binding
    vendorCategories: { "AWS": "cat-vendor" }, // hard-override tier
    fallbackCategoryId: "cat-fallback",
  };
  // txn() carries counterparty "AWS" AND rawCategory "software" (a real category);
  // under hard-override the vendor category MUST win in the actual POST body.
  const r = await upsertExpense(CFG, txn(), m, false, f);
  assertEquals(r.action, "created");
  const post = calls.find((c) => c.method === "POST")!;
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assertEquals(body.category_id, "cat-vendor");
});

// --- Fan-out method (upsertExpenses) ---

/** Run the fan-out method and return the persisted expenseSync/errors writes. */
async function runUpsertExpenses(
  txns: Array<Record<string, unknown>>,
  f: FetchLike,
  dryRun: boolean,
) {
  const { context, writes } = stubContext();
  await model.methods.upsertExpenses.execute(
    // deno-lint-ignore no-explicit-any
    { txns, mapping: MAPPING, dryRun, _fetch: f } as any,
    context,
  );
  const sync = writes.find((w) => w.spec === "expenseSync")!;
  const errs = writes.find((w) => w.spec === "expenseSyncErrors")!;
  return { sync, errs };
}

// (3) dry-run ----------------------------------------------------------------
Deno.test("upsertExpenses: dry-run yields would-create and NO POST hits the wire [WSPEC-03 dry]", async () => {
  const { f, calls } = writeFetcher();
  const { sync } = await runUpsertExpenses([txn()], f, true);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(sync.data.dryRun, true);
  assertEquals(postCount(calls), 0);
});

// (12) snapshot shape --------------------------------------------------------
Deno.test("upsertExpenses: persists expenseSync (rows + dryRun) AND flushes expenseSyncErrors [WSPEC-12]", async () => {
  const { f } = writeFetcher();
  const { sync, errs } = await runUpsertExpenses([txn()], f, true);
  assertEquals(Array.isArray(sync.data.rows), true);
  assertEquals(typeof sync.data.dryRun, "boolean");
  // expenseSyncErrors is flushed ALWAYS (even with zero errors).
  assertEquals(Array.isArray(errs.data.rows), true);
  assertEquals((errs.data.rows as unknown[]).length, 0);
});

// (2) idempotency acceptance -------------------------------------------------
Deno.test("upsertExpenses: re-run over the same BankTxn[] yields ALL skip [§11 idempotency]", async () => {
  // Every txn already exists in IN (dedup GET returns an exact match).
  const { f, calls } = writeFetcher({
    existingByPage: [[
      { id: "e1", custom_value1: "txn-1", amount: 50 },
      { id: "e2", custom_value1: "txn-2", amount: 60 },
    ]],
  });
  const { sync } = await runUpsertExpenses(
    [txn(), txn({ id: "txn-2", amount: 60 })],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.map((r) => r.action), ["skip", "skip"]);
  assertEquals(postCount(calls), 0); // idempotent — nothing created
});

// (6) in-batch duplicate id [WSPEC-03] ---------------------------------------
Deno.test("upsertExpenses: a duplicate id in one batch is MARKED, not dropped [WSPEC-03]", async () => {
  const { f, calls } = writeFetcher();
  const { sync } = await runUpsertExpenses([txn(), txn()], f, true); // same id twice
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.length, 2); // both kept in the audit
  assertEquals(rows[0].action, "would-create");
  assertEquals(rows[1].action, "skip"); // the dup, marked (in-batch-duplicate)
  assertEquals(postCount(calls), 0); // dry-run
});

// (8) unmatched vendor flagged in the row ------------------------------------
Deno.test("upsertExpenses: an unmatched vendor is flagged in the audit row [WSPEC-08]", async () => {
  const { f } = writeFetcher();
  const { sync } = await runUpsertExpenses(
    [txn({ counterparty: "Nobody" })],
    f,
    true,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].unmatchedVendor, true);
});

// (7) mid-batch failure [WSPEC-04] -------------------------------------------
Deno.test("upsertExpenses: a mid-batch POST failure keeps created rows AND an error row [WSPEC-04]", async () => {
  // 3 txns, real writes; the POST for txn-2 throws (HTTP 500).
  const { f, calls } = writeFetcher({ throwPostWhenKey: "txn-2" });
  const { sync, errs } = await runUpsertExpenses(
    [
      txn(),
      txn({ id: "txn-2", amount: 60, counterparty: "AWS" }),
      txn({ id: "txn-3", amount: 70 }),
    ],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // txn-1 and txn-3 created; txn-2 threw BEFORE a sync row was pushed.
  assertEquals(rows.map((r) => r.dedupKey), ["txn-1", "txn-3"]);
  assertEquals(rows.every((r) => r.action === "created"), true);
  // txn-2's failure is durably recorded, batch did not abort.
  const errRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(errRows.length, 1);
  assertEquals(errRows[0].dedupKey, "txn-2");
  assertEquals(typeof errRows[0].attemptedAt, "string");
  // txn-3 was still attempted after txn-2 failed → 3 POSTs on the wire.
  assertEquals(postCount(calls), 3);
});

// --- Review-round-2 fixes (WSEC / WREV) ---

// WSEC — soft-delete idempotency hole: dedup must be trash-inclusive.
Deno.test("upsertExpense: dedup is trash-inclusive — a soft-deleted match still skips [WSEC]", async () => {
  // The exact-match row is a soft-deleted/archived expense (only visible with
  // with_trashed). It must still count as existing → no duplicate create.
  const { f, calls } = writeFetcher({
    existingByPage: [[{ id: "exp-del", custom_value1: "txn-1", amount: 50 }]],
  });
  const r = await upsertExpense(CFG, txn(), MAPPING, false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "already-exists");
  assertEquals(postCount(calls), 0); // no duplicate POST
  // The dedup GET forces with_trashed regardless of cfg.withTrashed (false here).
  assertEquals(calls[0].url.includes("with_trashed=true"), true);
});

// WSEC — prototype-chain lookup on attacker-influenceable strings.
Deno.test("vendorFor / mapTxnToExpense: prototype keys never resolve to inherited members [WSEC]", () => {
  // A counterparty equal to a prototype member must be UNMATCHED, not matched.
  assertEquals(vendorFor("__proto__", MAPPING), null);
  assertEquals(vendorFor("constructor", MAPPING), null);
  assertEquals(vendorFor("toString", MAPPING), null);
  const body = mapTxnToExpense(
    txn({ counterparty: "__proto__", rawCategory: "constructor" }),
    MAPPING,
  );
  assertEquals(body.vendor_id, null); // genuinely unmatched
  assertEquals(body.category_id, "cat-fallback"); // no prototype leak
  assertEquals(typeof body.category_id, "string");
});

// WREV-02 — in-batch duplicate in REAL mode: exactly ONE create.
Deno.test("upsertExpenses: a duplicate id in REAL mode yields exactly one POST [WREV-02]", async () => {
  const { f, calls } = writeFetcher({ createdId: "exp-1" });
  const { sync } = await runUpsertExpenses([txn(), txn()], f, false); // dryRun=false
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.map((r) => r.action), ["created", "skip"]);
  assertEquals(postCount(calls), 1); // the dup did NOT create a second expense
});

// WREV-03 — fan-out row shaping for non-candidate + blank key.
Deno.test("upsertExpenses: non-candidate persists a skip row; blank id persists skip + error row [WREV-03]", async () => {
  const { f, calls } = writeFetcher();
  const { sync, errs } = await runUpsertExpenses(
    [txn({ direction: "credit" }), txn({ id: "" })],
    f,
    true,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // Both persist as the frozen action 'skip' (never a non-enum value).
  assertEquals(rows.map((r) => r.action), ["skip", "skip"]);
  assertEquals(rows.map((r) => r.dedupKey), ["txn-1", ""]);
  // The blank key ALSO surfaces a durable error row.
  const errRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(errRows.length, 1);
  assertEquals(errRows[0].dedupKey, "");
  assertEquals(errRows[0].error, "blank-dedup-key");
  assertEquals(postCount(calls), 0); // neither reached a POST
});

// ===========================================================================
// Mapping-write path (§7.4) — Phase 6. Auto-create vendors + categories +
// buildMapping. Injected FetchLike + seeded readResource, bugzilla pattern.
// ===========================================================================

// --- Pure helpers ---
Deno.test("normName: trim + NFC + case-fold", () => {
  assertEquals(normName("  Nimbus AI "), "nimbus ai");
  assertEquals(normName("NIMBUS AI"), "nimbus ai");
  // NFC: composed é equals decomposed e +  ́.
  assertEquals(normName("Café"), normName("Café"));
});

Deno.test("distinctByNorm: dedups by normName, keeps first raw spelling, drops blanks", () => {
  const out = distinctByNorm(["Nimbus AI", "nimbus ai", null, "  ", "AWS"]);
  assertEquals(out.map((d) => d.raw), ["Nimbus AI", "AWS"]); // first spelling wins
  assertEquals(out.map((d) => d.norm), ["nimbus ai", "aws"]);
});

Deno.test("buildNameIndex: normName→id, lowest id wins on a dup name", () => {
  const idx = buildNameIndex([
    { id: "v-9", name: "Nimbus AI" },
    { id: "v-2", name: "nimbus ai" }, // dup by normName; lower id must win
    { id: "v-5", name: "AWS" },
    { id: "", name: "skip-me" }, // blank id dropped
  ]);
  assertEquals(idx.get("nimbus ai"), "v-2");
  assertEquals(idx.get("aws"), "v-5");
  assertEquals(idx.has("skip-me"), false);
});

Deno.test("rawNameIndex: raw display name→id, own-key safe, lowest id on dup", () => {
  const out = rawNameIndex([
    { id: "c-3", name: "Software" },
    { id: "c-1", name: "Software" }, // dup raw → lowest id
    { id: "p-9", name: "__proto__" }, // must be a real own entry
  ]);
  assertEquals(out.Software, "c-1");
  assertEquals(Object.hasOwn(out, "__proto__"), true);
  assertEquals(out["__proto__"], "p-9");
});

Deno.test("resolveByNorm: case-insensitive id resolution, null when absent", () => {
  const items = [{ id: "c-unc", name: "uncategorized" }, {
    id: "c-sw",
    name: "Software",
  }];
  assertEquals(resolveByNorm(items, "Uncategorized"), "c-unc"); // case-insensitive
  assertEquals(resolveByNorm(items, "Nope"), null);
});

// --- Fan-out method fakes ---

/**
 * A fake {@link FetchLike} for reference-data upserts: serves the list GET (a
 * single page of `initial` + everything created so far, so a post-create refetch
 * sees new rows) and the create POST (`{data:{id}}`, id auto-numbered). A POST
 * whose `name` equals `throwPostWhenName` returns HTTP 500 → inFetch throws.
 */
function refFetcher(
  opts: {
    initial?: Array<Record<string, unknown>>;
    throwPostWhenName?: string;
    idPrefix?: string;
  } = {},
): { f: FetchLike; calls: WFetchRec[] } {
  const created: Array<Record<string, unknown>> = [];
  const calls: WFetchRec[] = [];
  let n = 0;
  const f: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    if ((init?.method ?? "GET") === "POST") {
      const body = init?.body
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};
      const name = body.name as string;
      if (opts.throwPostWhenName && name === opts.throwPostWhenName) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Server Error",
          json: () => Promise.resolve({}),
        });
      }
      const id = `${opts.idPrefix ?? "ref"}-${++n}`;
      created.push({ id, name });
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ data: { id } }),
      });
    }
    const data = [...(opts.initial ?? []), ...created];
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve({
          data,
          meta: { pagination: { current_page: 1, total_pages: 1 } },
        }),
    });
  };
  return { f, calls };
}

/** stubContext + a seeded readResource for buildMapping's snapshot reads. */
function stubContextWithData(
  seed: Record<string, Record<string, unknown>>,
  cfg: Cfg = CFG,
) {
  const { context, writes } = stubContext(cfg);
  context.readResource = (name: string) => Promise.resolve(seed[name] ?? null);
  return { context, writes };
}

/** Run upsertVendors and return the recorded writes. */
async function runUpsertVendors(
  txns: Array<Record<string, unknown>>,
  f: FetchLike,
  dryRun: boolean,
  cfg: Cfg = CFG,
) {
  const { context, writes } = stubContext(cfg);
  await model.methods.upsertVendors.execute(
    // deno-lint-ignore no-explicit-any
    { txns, dryRun, _fetch: f } as any,
    context,
  );
  return {
    sync: writes.find((w) => w.spec === "vendorSync")!,
    errs: writes.find((w) => w.spec === "vendorSyncErrors")!,
    vendorsSnap: writes.find((w) => w.spec === "vendors"),
    writes,
  };
}

// (1) distinct extraction over candidate gate + normName dedup ---------------
Deno.test("upsertVendors: distinct counterparties, ignoring non-candidates, deduped by normName [§7.4]", async () => {
  const { sync, writes } = await runUpsertVendors(
    [
      txn({ id: "t1", counterparty: "AWS" }),
      txn({ id: "t2", counterparty: "aws" }), // dup by normName
      txn({ id: "t3", counterparty: "Stripe", direction: "credit" }), // non-candidate
      txn({ id: "t4", counterparty: "Heroku", status: "pending" }), // non-candidate
      txn({ id: "t5", counterparty: "Datadog", currency: "EUR" }), // non-candidate
      txn({ id: "t6", counterparty: "Nimbus AI" }),
    ],
    refFetcher().f,
    true,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // Only AWS + Nimbus AI survive the candidate gate + normName dedup.
  assertEquals(rows.map((r) => r.name), ["AWS", "Nimbus AI"]);
  assertEquals(rows.every((r) => r.action === "would-create"), true);
  // dryRun → no snapshot refresh.
  assertEquals(writes.some((w) => w.spec === "vendors"), false);
});

// (8, §6.1) a transfer counterparty is NOT auto-created as a vendor/category --
Deno.test("upsertVendors: a transfer counterparty is excluded from auto-create (§6.1)", async () => {
  const { sync } = await runUpsertVendors(
    [
      txn({ id: "t1", counterparty: "Nimbus AI" }),
      txn({ id: "t2", counterparty: "Summit Bank", isTransfer: true }), // self-transfer
    ],
    refFetcher().f,
    true,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // Only the real vendor survives — isCandidate drops the transfer.
  assertEquals(rows.map((r) => r.name), ["Nimbus AI"]);
});

Deno.test("upsertExpenseCategories: a transfer's rawCategory is excluded from auto-create (§6.1)", async () => {
  const { context, writes } = stubContext();
  await model.methods.upsertExpenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    {
      txns: [
        txn({ id: "t1", rawCategory: "Software" }),
        txn({ id: "t2", rawCategory: "Transfers", isTransfer: true }), // self-transfer
      ],
      dryRun: true,
      _fetch: refFetcher().f,
    } as any,
    context,
  );
  const rows =
    (writes.find((w) => w.spec === "categorySync")!.data.rows) as Array<
      Record<string, unknown>
    >;
  const names = rows.map((r) => r.name);
  // The transfer's "Transfers" category is NOT created; the real one + fallback are.
  assertEquals(names.includes("Transfers"), false);
  assertEquals(names.includes("Software"), true);
});

// owner-draw-exclusion: an owner-draw counterparty/category is NOT auto-created
Deno.test("upsertVendors: an owner-draw counterparty is excluded from auto-create", async () => {
  const { sync } = await runUpsertVendors(
    [
      txn({ id: "t1", counterparty: "Nimbus AI" }),
      txn({ id: "t2", counterparty: "Riverside Market", isOwnerDraw: true }),
    ],
    refFetcher().f,
    true,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // Only the real vendor survives — isCandidate drops the owner draw.
  assertEquals(rows.map((r) => r.name), ["Nimbus AI"]);
});

Deno.test("upsertExpenseCategories: an owner-draw's rawCategory is excluded from auto-create", async () => {
  const { context, writes } = stubContext();
  await model.methods.upsertExpenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    {
      txns: [
        txn({ id: "t1", rawCategory: "Software" }),
        txn({ id: "t2", rawCategory: "Fees", isOwnerDraw: true }), // ATM draw
      ],
      dryRun: true,
      _fetch: refFetcher().f,
    } as any,
    context,
  );
  const rows =
    (writes.find((w) => w.spec === "categorySync")!.data.rows) as Array<
      Record<string, unknown>
    >;
  const names = rows.map((r) => r.name);
  // The owner draw's "Fees" category is NOT created off this row; Software + fallback are.
  assertEquals(names.includes("Fees"), false);
  assertEquals(names.includes("Software"), true);
});

// (2) idempotency — re-run over existing vendors is all-skip, no POST --------
Deno.test("upsertVendors: re-run when vendors already exist → all skip already-exists, NO POST [§7.4]", async () => {
  const { f, calls } = refFetcher({
    initial: [{ id: "v-aws", name: "AWS" }, {
      id: "v-nimbus ai",
      name: "Nimbus AI",
    }],
  });
  const { sync } = await runUpsertVendors(
    [
      txn({ id: "t1", counterparty: "AWS" }),
      txn({ id: "t2", counterparty: "Nimbus AI" }),
    ],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.map((r) => r.action), ["skip", "skip"]);
  assertEquals(rows.map((r) => r.reason), ["already-exists", "already-exists"]);
  assertEquals(rows.map((r) => r.vendorId), ["v-aws", "v-nimbus ai"]);
  assertEquals(postCount(calls), 0); // idempotent
});

// (3) case-insensitive dedup against existing --------------------------------
Deno.test("upsertVendors: an existing 'Nimbus AI' makes incoming 'nimbus ai' a skip (no dup create) [§7.4]", async () => {
  const { f, calls } = refFetcher({
    initial: [{ id: "v-nimbus ai", name: "Nimbus AI" }],
  });
  const { sync } = await runUpsertVendors(
    [txn({ id: "t1", counterparty: "nimbus ai" })], // lowercase
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "already-exists");
  assertEquals(rows[0].vendorId, "v-nimbus ai");
  assertEquals(postCount(calls), 0);
});

// (4) dryRun → would-create, NO POST, NO snapshot refresh --------------------
Deno.test("upsertVendors: dryRun yields would-create, no POST, no snapshot refresh [§7.4]", async () => {
  const { f, calls } = refFetcher();
  const { sync, vendorsSnap } = await runUpsertVendors(
    [txn({ counterparty: "NewVendor" })],
    f,
    true,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(rows[0].vendorId, null);
  assertEquals(sync.data.dryRun, true);
  assertEquals(postCount(calls), 0);
  assertEquals(vendorsSnap, undefined); // no refresh in dryRun
});

// (5) real create POSTs with mandatory headers, THEN refreshes the snapshot ---
Deno.test("upsertVendors: real create POSTs /vendors, then re-fetches + re-writes the vendors snapshot [§7.4]", async () => {
  const { f, calls } = refFetcher({ idPrefix: "v" });
  const { sync, vendorsSnap } = await runUpsertVendors(
    [txn({ counterparty: "Nimbus AI" })],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "created");
  assertEquals(rows[0].vendorId, "v-1");
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(new URL(post.url).pathname.endsWith("/vendors"), true);
  assertEquals(post.headers?.["X-API-TOKEN"], "SEKRIT");
  assertEquals(post.headers?.["X-Requested-With"], "XMLHttpRequest");
  assertEquals(post.headers?.["Content-Type"], "application/json");
  assertEquals(
    (JSON.parse(post.body!) as Record<string, unknown>).name,
    "Nimbus AI",
  );
  // The snapshot was refreshed AND now carries the created row.
  assertEquals(vendorsSnap !== undefined, true);
  const items = vendorsSnap!.data.items as Array<Record<string, unknown>>;
  assertEquals(
    items.some((i) => i.id === "v-1" && i.name === "Nimbus AI"),
    true,
  );
});

// (6) mid-batch failure — created rows survive via finally; error row kept ---
Deno.test("upsertVendors: a mid-batch create failure keeps earlier created rows AND an error row [§7.4]", async () => {
  const { f } = refFetcher({ idPrefix: "v", throwPostWhenName: "BadVendor" });
  const { sync, errs } = await runUpsertVendors(
    [
      txn({ id: "t1", counterparty: "GoodOne" }),
      txn({ id: "t2", counterparty: "BadVendor" }),
      txn({ id: "t3", counterparty: "GoodTwo" }),
    ],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // GoodOne + GoodTwo created (batch did NOT abort on BadVendor's failure).
  const created = rows.filter((r) => r.action === "created").map((r) => r.name);
  assertEquals(created, ["GoodOne", "GoodTwo"]);
  const errRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(errRows.length, 1);
  assertEquals(errRows[0].name, "BadVendor");
  assertEquals(typeof errRows[0].attemptedAt, "string");
});

Deno.test("upsertVendors: vendorSyncErrors is flushed even when empty [§7.4]", async () => {
  const { errs } = await runUpsertVendors(
    [txn({ counterparty: "AWS" })],
    refFetcher().f,
    true,
  );
  assertEquals(Array.isArray(errs.data.rows), true);
  assertEquals((errs.data.rows as unknown[]).length, 0); // "0 errors" != "never ran"
});

// (7) upsertExpenseCategories ALWAYS ensures the fallback ----------------------
Deno.test("upsertExpenseCategories: ensures the fallback even with no candidate rawCategory [§7.4]", async () => {
  const { context, writes } = stubContext();
  await model.methods.upsertExpenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    { txns: [], dryRun: true, _fetch: refFetcher().f } as any,
    context,
  );
  const sync = writes.find((w) => w.spec === "categorySync")!;
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // Even with zero candidate txns, the Uncategorized fallback is ensured.
  assertEquals(rows.map((r) => r.name), ["Uncategorized"]);
  assertEquals(rows[0].action, "would-create");
});

Deno.test("upsertExpenseCategories: distinct rawCategories + fallback, over candidates only [§7.4]", async () => {
  const { context, writes } = stubContext();
  await model.methods.upsertExpenseCategories.execute(
    {
      txns: [
        txn({ id: "t1", rawCategory: "Software" }),
        txn({ id: "t2", rawCategory: "software" }), // dup by normName
        txn({ id: "t3", rawCategory: "Meals", direction: "credit" }), // non-candidate
      ],
      dryRun: true,
      _fetch: refFetcher().f,
      // deno-lint-ignore no-explicit-any
    } as any,
    context,
  );
  const rows =
    (writes.find((w) => w.spec === "categorySync")!.data.rows) as Array<
      Record<string, unknown>
    >;
  // Software (once) + the always-on Uncategorized fallback; Meals excluded.
  assertEquals(rows.map((r) => r.name), ["Software", "Uncategorized"]);
});

// (8) buildMapping maps raw-name keys + resolves fallback case-insensitively --
Deno.test("buildMapping: raw-name→id tables + case-insensitive fallback resolution [§7.4]", async () => {
  const { context, writes } = stubContextWithData({
    vendors: {
      items: [{ id: "v-nimbus ai", name: "Nimbus AI" }, {
        id: "v-aws",
        name: "AWS",
      }],
    },
    // fallback stored lowercase → must still resolve for default "Uncategorized".
    expenseCategories: {
      items: [{ id: "c-sw", name: "Software" }, {
        id: "c-unc",
        name: "uncategorized",
      }],
    },
  });
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1" } as any,
    context,
  );
  const m = writes.find((w) => w.spec === "mapping")!.data;
  assertEquals(m.currencyId, "1");
  assertEquals(m.vendors, { "Nimbus AI": "v-nimbus ai", AWS: "v-aws" });
  assertEquals(m.categories, { Software: "c-sw", uncategorized: "c-unc" });
  assertEquals(m.fallbackCategoryId, "c-unc"); // resolved case-insensitively
});

// (9) buildMapping THROWS when the fallback is absent -------------------------
Deno.test("buildMapping: throws when the fallback category is absent (no partial mapping) [§7.4]", async () => {
  const { context } = stubContextWithData({
    vendors: { items: [{ id: "v-aws", name: "AWS" }] },
    expenseCategories: { items: [{ id: "c-sw", name: "Software" }] }, // no Uncategorized
  });
  await assertRejects(
    () =>
      model.methods.buildMapping.execute(
        // deno-lint-ignore no-explicit-any
        { currencyId: "1" } as any,
        context,
      ),
    Error,
    "fallback category",
  );
});

// (10) end-to-end — buildMapping output feeds mapTxnToExpense unchanged -------
Deno.test("buildMapping: output validates as a frozen Mapping and feeds mapTxnToExpense [§7.4]", async () => {
  const { context, writes } = stubContextWithData({
    vendors: { items: [{ id: "v-aws", name: "AWS" }] },
    expenseCategories: {
      items: [{ id: "c-sw", name: "Software" }, {
        id: "c-unc",
        name: "Uncategorized",
      }],
    },
  });
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1" } as any,
    context,
  );
  const data = writes.find((w) => w.spec === "mapping")!.data;
  // Reconstruct the frozen Mapping interface from the emitted resource.
  const m: Mapping = {
    currencyId: data.currencyId as string,
    vendors: data.vendors as Record<string, string>,
    categories: data.categories as Record<string, string>,
    fallbackCategoryId: data.fallbackCategoryId as string,
  };
  // A matched txn maps to the real ids…
  const body = mapTxnToExpense(
    txn({ counterparty: "AWS", rawCategory: "Software" }),
    m,
  );
  assertEquals(body.vendor_id, "v-aws");
  assertEquals(body.category_id, "c-sw");
  assertEquals(body.currency_id, "1");
  // …and an unmatched txn falls the category back to the resolved fallback id.
  const fb = mapTxnToExpense(
    txn({ counterparty: "Nobody", rawCategory: "nope" }),
    m,
  );
  assertEquals(fb.vendor_id, null);
  assertEquals(fb.category_id, "c-unc");
});

// --- Review-round fixes (SEC-2 / COR-1) ---

// A real run that creates nothing must STILL refresh the snapshot so a
// downstream buildMapping never reads a stale/absent snapshot — reusing the
// already-fetched list (no second GET).
Deno.test("upsertVendors: a real run creating nothing STILL refreshes the vendors snapshot, no 2nd GET [SEC-2/COR-1]", async () => {
  const { f, calls } = refFetcher({ initial: [{ id: "v-aws", name: "AWS" }] });
  const { sync, vendorsSnap } = await runUpsertVendors(
    [txn({ counterparty: "AWS" })], // already exists → all skip, 0 creates
    f,
    false,
  );
  assertEquals(
    (sync.data.rows as Array<Record<string, unknown>>)[0].action,
    "skip",
  );
  // Exactly one wire call — the dedup list GET; the refresh REUSED it (no POST,
  // no second GET).
  assertEquals(calls.length, 1);
  assertEquals(postCount(calls), 0);
  // …yet the snapshot was refreshed from that fetched list.
  assertEquals(vendorsSnap !== undefined, true);
  const items = vendorsSnap!.data.items as Array<Record<string, unknown>>;
  assertEquals(items.some((i) => i.id === "v-aws" && i.name === "AWS"), true);
});

// A missing (never-written) vendors snapshot yields an empty vendor table, not a
// throw — vendor attribution is allowed to be empty (unmatched is legal), while
// the fallback category still gates the category side.
Deno.test("buildMapping: a missing vendors snapshot yields empty vendors, not a throw [SEC-2]", async () => {
  const { context, writes } = stubContextWithData({
    // No `vendors` key → readResource("vendors") returns null.
    expenseCategories: { items: [{ id: "c-unc", name: "Uncategorized" }] },
  });
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1" } as any,
    context,
  );
  const m = writes.find((w) => w.spec === "mapping")!.data;
  assertEquals(m.vendors, {});
  assertEquals(m.fallbackCategoryId, "c-unc");
});

// ---------------------------------------------------------------------------
// mapping-overlay — deleted-row read fix (gotcha #2) + curated overlay
// ---------------------------------------------------------------------------

// (3) a soft-deleted existing vendor must NOT suppress a needed create.
Deno.test("upsertVendors: a soft-deleted existing vendor does NOT suppress a create (gotcha #2)", async () => {
  // GET returns a DELETED "Nimbus"; the dedup index must exclude it, so a
  // candidate "Nimbus" is CREATED (not skipped as already-existing → which
  // would bind the dead id).
  const { f } = refFetcher({
    initial: [{ id: "v-dead", name: "Nimbus", is_deleted: true }],
  });
  const { sync } = await runUpsertVendors(
    [txn({ id: "t1", counterparty: "Nimbus" })],
    f,
    false, // real run
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].name, "Nimbus");
  assertEquals(rows[0].action, "created"); // NOT "skip"/already-exists
});

// (6) upsertVendors ensures the OVERLAY TARGET name, never the raw.
Deno.test("upsertVendors: vendorOverlay ensures the TARGET name, not the raw (mapping-overlay)", async () => {
  const cfg = {
    ...CFG,
    vendorOverlay: { "Nimbus AI": "Nimbus", "WIDGETCO TEAM": "Widget.Club" },
  } as unknown as Cfg;
  const { sync } = await runUpsertVendors(
    [
      txn({ id: "t1", counterparty: "Nimbus AI" }),
      txn({ id: "t2", counterparty: "WIDGETCO TEAM" }),
    ],
    refFetcher().f,
    true, // dryRun
    cfg,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(
    rows.map((r) => r.name as string).sort(),
    ["Nimbus", "Widget.Club"], // targets, never "Nimbus AI"/"WIDGETCO TEAM"
  );
});

// (7)+(8) buildMapping: overlay aliases resolve raw→target id; exact matches keep resolving.
Deno.test("buildMapping: overlay aliases resolve raw→target id; exact matches keep resolving (mapping-overlay)", async () => {
  const cfg = {
    ...CFG,
    vendorOverlay: { "Nimbus AI": "Nimbus" },
    categoryOverlay: { Software: "Software & Subscriptions" },
  } as unknown as Cfg;
  const { context, writes } = stubContextWithData({
    vendors: {
      items: [
        { id: "v-nimbus", name: "Nimbus", isDeleted: false },
        { id: "v-acme", name: "Acme Insurance Co", isDeleted: false },
      ],
    },
    expenseCategories: {
      items: [
        { id: "c-swsub", name: "Software & Subscriptions", isDeleted: false },
        { id: "c-none", name: "None", isDeleted: false },
      ],
    },
  }, cfg);
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", fallbackCategoryName: "None" } as any,
    context,
  );
  const m = writes.find((w) => w.spec === "mapping")!.data;
  const vendors = m.vendors as Record<string, string>;
  const categories = m.categories as Record<string, string>;
  // (7) alias: raw counterparty "Nimbus AI" resolves to the Nimbus id.
  assertEquals(vendors["Nimbus AI"], "v-nimbus");
  // (8) un-overlayed exact match still present under its own name.
  assertEquals(vendors["Acme Insurance Co"], "v-acme");
  // (7) category alias.
  assertEquals(categories.Software, "c-swsub");
  assertEquals(m.fallbackCategoryId, "c-none");
});

// (4) buildMapping must never bind a soft-deleted vendor id, even a lower one.
Deno.test("buildMapping: a soft-deleted vendor id is never bound; the active dup wins (gotcha #2)", async () => {
  const cfg = {
    ...CFG,
    vendorOverlay: { "Nimbus AI": "Nimbus" },
  } as unknown as Cfg;
  const { context, writes } = stubContextWithData({
    vendors: {
      items: [
        { id: "v-000-dead", name: "Nimbus", isDeleted: true }, // lowest id, deleted
        { id: "v-999-live", name: "Nimbus", isDeleted: false },
      ],
    },
    expenseCategories: {
      items: [{ id: "c-none", name: "None", isDeleted: false }],
    },
  }, cfg);
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", fallbackCategoryName: "None" } as any,
    context,
  );
  const vendors =
    (writes.find((w) => w.spec === "mapping")!.data.vendors) as Record<
      string,
      string
    >;
  // Without the deleted-filter, rawNameIndex's lowest-id rule would pick the dead
  // id; with it, only the active row survives.
  assertEquals(vendors["Nimbus"], "v-999-live");
  assertEquals(vendors["Nimbus AI"], "v-999-live"); // alias resolves to the ACTIVE id
});

// (9) a soft-deleted fallback category is not bound → buildMapping throws.
Deno.test("buildMapping: a soft-deleted fallback category is not bound → throws (gotcha #2)", async () => {
  const { context } = stubContextWithData({
    vendors: { items: [] },
    expenseCategories: {
      items: [{ id: "c-dead", name: "None", isDeleted: true }], // only a deleted None
    },
  });
  await assertRejects(
    () =>
      model.methods.buildMapping.execute(
        // deno-lint-ignore no-explicit-any
        { currencyId: "1", fallbackCategoryName: "None" } as any,
        context,
      ),
    Error,
    "fallback category",
  );
});

// ---------------------------------------------------------------------------
// vendor-category-overlay (§7.5) — assign a category by VENDOR when Mercury left
// the txn uncategorized. Placeholder vendor/category names (fabricated, never the
// real go-live literals — see [[depersonalize-tests-before-publish]]).
// ---------------------------------------------------------------------------

Deno.test("overlayTargetFor(): returns the target on a normName match, null on a miss (unlike applyOverlay)", () => {
  const overlay = { "ACME INSURANCE CO": "Insurance" };
  assertEquals(overlayTargetFor("ACME INSURANCE CO", overlay), "Insurance");
  assertEquals(overlayTargetFor("  acme insurance co ", overlay), "Insurance"); // case/space-insensitive
  assertEquals(overlayTargetFor("Someone Else", overlay), null); // MISS → null (not the raw name)
  assertEquals(overlayTargetFor(null, overlay), null);
  assertEquals(overlayTargetFor("__proto__", overlay), null); // no accidental prototype hit
});

Deno.test("upsertExpenseCategories: ensures vendorCategoryOverlay targets for MATCHING candidate counterparties only (§7.5)", async () => {
  const cfg = {
    ...CFG,
    vendorCategoryOverlay: {
      "ACME INSURANCE CO": "Insurance",
      "STATE TAX BUREAU": "Taxes",
    },
  } as unknown as Cfg;
  const { context, writes } = stubContext(cfg);
  await model.methods.upsertExpenseCategories.execute(
    {
      txns: [
        txn({ id: "t1", counterparty: "ACME INSURANCE CO", rawCategory: null }), // null cat → needs vendor category
        txn({ id: "t2", counterparty: "Widget Co", rawCategory: "Software" }), // carries its own category
        txn({
          id: "t3",
          counterparty: "STATE TAX BUREAU",
          rawCategory: null,
          direction: "credit",
        }), // non-candidate → its vendor target is NOT ensured
      ],
      dryRun: true,
      _fetch: refFetcher().f,
      // deno-lint-ignore no-explicit-any
    } as any,
    context,
  );
  const rows =
    (writes.find((w) => w.spec === "categorySync")!.data.rows) as Array<
      Record<string, unknown>
    >;
  // Insurance (t1 vendor target) + Software (t2 own category) + Uncategorized
  // fallback. Taxes is ABSENT: its only txn (t3) is a non-candidate credit.
  assertEquals(rows.map((r) => r.name).sort(), [
    "Insurance",
    "Software",
    "Uncategorized",
  ]);
});

Deno.test("buildMapping: vendorCategoryOverlay emits a SEPARATE vendorCategories namespace; the vendor category OVERRIDES a real rawCategory (hard-override, §7.5)", async () => {
  const cfg = {
    ...CFG,
    vendorCategoryOverlay: {
      "ACME INSURANCE CO": "Insurance",
      "STATE TAX BUREAU": "Taxes",
    },
  } as unknown as Cfg;
  const { context, writes } = stubContextWithData({
    vendors: {
      items: [{ id: "v-acme", name: "ACME INSURANCE CO", isDeleted: false }],
    },
    expenseCategories: {
      items: [
        { id: "c-ins", name: "Insurance", isDeleted: false },
        { id: "c-tax", name: "Taxes", isDeleted: false },
        { id: "c-sw", name: "Software", isDeleted: false },
        { id: "c-none", name: "None", isDeleted: false },
      ],
    },
  }, cfg);
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", fallbackCategoryName: "None" } as any,
    context,
  );
  const data = writes.find((w) => w.spec === "mapping")!.data;
  const categories = data.categories as Record<string, string>;
  const vendorCategories = data.vendorCategories as Record<string, string>;
  // Counterparty-keyed aliases land in the SEPARATE vendorCategories namespace,
  // NOT in the rawCategory/counterparty `categories` table.
  assertEquals(vendorCategories["ACME INSURANCE CO"], "c-ins");
  assertEquals(vendorCategories["STATE TAX BUREAU"], "c-tax");
  assertEquals(categories["ACME INSURANCE CO"], undefined);
  assertEquals(categories.Software, "c-sw"); // own-name category untouched
  const m: Mapping = {
    currencyId: data.currencyId as string,
    vendors: data.vendors as Record<string, string>,
    categories,
    vendorCategories,
    fallbackCategoryId: data.fallbackCategoryId as string,
  };
  // null rawCategory → vendor's curated category.
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "ACME INSURANCE CO", rawCategory: null }),
      m,
    )
      .category_id,
    "c-ins",
  );
  // HARD-OVERRIDE: a REAL Mercury rawCategory is OVERRIDDEN by the vendor category.
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "ACME INSURANCE CO", rawCategory: "Software" }),
      m,
    ).category_id,
    "c-ins",
  );
  // unmatched vendor + null category → the resolved fallback id.
  assertEquals(
    mapTxnToExpense(txn({ counterparty: "Nobody", rawCategory: null }), m)
      .category_id,
    "c-none",
  );
  // unmatched vendor WITH a real rawCategory → resolves via `categories` (the
  // hard-override tier misses, so the rawCategory tier still works).
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "Widget Co", rawCategory: "Software" }),
      m,
    )
      .category_id,
    "c-sw",
  );
});

Deno.test("buildMapping: an unresolved vendorCategoryOverlay target is dropped; the row falls to fallback (§7.5)", async () => {
  const cfg = {
    ...CFG,
    vendorCategoryOverlay: { "ACME INSURANCE CO": "Insurance" },
  } as unknown as Cfg;
  const { context, writes } = stubContextWithData({
    vendors: { items: [] },
    // No "Insurance" category exists → the alias target cannot resolve.
    expenseCategories: {
      items: [{ id: "c-none", name: "None", isDeleted: false }],
    },
  }, cfg);
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", fallbackCategoryName: "None" } as any,
    context,
  );
  const data = writes.find((w) => w.spec === "mapping")!.data;
  const vendorCategories = data.vendorCategories as Record<string, string>;
  assertEquals(vendorCategories["ACME INSURANCE CO"], undefined); // alias dropped, never a bad bind
  const m: Mapping = {
    currencyId: "1",
    vendors: {},
    categories: data.categories as Record<string, string>,
    vendorCategories,
    fallbackCategoryId: data.fallbackCategoryId as string,
  };
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "ACME INSURANCE CO", rawCategory: null }),
      m,
    )
      .category_id,
    "c-none",
  );
});

Deno.test("buildMapping: a vendorCategoryOverlay key coinciding with a real category name lives in its OWN namespace and never touches the rawCategory binding (namespace isolation, §7.5 — retires COR-1)", async () => {
  // Adversarial: a counterparty literally named "Software" mapped to Taxes. The
  // separate vendorCategories namespace means it can never overwrite the real
  // Software→id binding an unrelated txn depends on — no collision guard needed.
  const cfg = {
    ...CFG,
    vendorCategoryOverlay: { "Software": "Taxes" },
  } as unknown as Cfg;
  const { context, writes } = stubContextWithData({
    vendors: { items: [] },
    expenseCategories: {
      items: [
        { id: "c-sw", name: "Software", isDeleted: false },
        { id: "c-tax", name: "Taxes", isDeleted: false },
        { id: "c-none", name: "None", isDeleted: false },
      ],
    },
  }, cfg);
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", fallbackCategoryName: "None" } as any,
    context,
  );
  const data = writes.find((w) => w.spec === "mapping")!.data;
  const categories = data.categories as Record<string, string>;
  const vendorCategories = data.vendorCategories as Record<string, string>;
  // The real category own-name key is preserved (the alias lives elsewhere).
  assertEquals(categories.Software, "c-sw");
  assertEquals(vendorCategories.Software, "c-tax"); // override alias isolated
  const m: Mapping = {
    currencyId: "1",
    vendors: {},
    categories,
    vendorCategories,
    fallbackCategoryId: data.fallbackCategoryId as string,
  };
  // An unrelated txn correctly categorized "Software" by Mercury still resolves
  // to the real Software id — the rawCategory tier is unaffected.
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "Widget Co", rawCategory: "Software" }),
      m,
    )
      .category_id,
    "c-sw",
  );
  // But a txn FROM the "Software"-named counterparty hard-overrides to Taxes.
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "Software", rawCategory: "Software" }),
      m,
    )
      .category_id,
    "c-tax",
  );
});

Deno.test("upsertExpenseCategories: ensures the vendor target for a matched counterparty EVEN WHEN its txns carry a real rawCategory (hard-override ensure-for-all, §7.5)", async () => {
  const cfg = {
    ...CFG,
    vendorCategoryOverlay: { "ACME INSURANCE CO": "Insurance" },
  } as unknown as Cfg;
  const { context, writes } = stubContext(cfg);
  await model.methods.upsertExpenseCategories.execute(
    {
      txns: [
        // Matches the overlay key AND carries a real rawCategory. Under hard-
        // override this row routes to the vendor category, so "Insurance" MUST be
        // ensured (the FALLBACK variant's COR-3 rawCategory===null guard is gone).
        txn({
          id: "t1",
          counterparty: "ACME INSURANCE CO",
          rawCategory: "Software",
        }),
      ],
      dryRun: true,
      _fetch: refFetcher().f,
      // deno-lint-ignore no-explicit-any
    } as any,
    context,
  );
  const rows =
    (writes.find((w) => w.spec === "categorySync")!.data.rows) as Array<
      Record<string, unknown>
    >;
  // Software (own category) + Insurance (vendor target) + Uncategorized fallback.
  assertEquals(rows.map((r) => r.name).sort(), [
    "Insurance",
    "Software",
    "Uncategorized",
  ]);
});

Deno.test("vendorCategoryOverlay: absent/empty is inert — no counterparty aliases (back-compat, §7.5)", async () => {
  // Default CFG carries no vendorCategoryOverlay → categories has only own-name entries.
  const { context, writes } = stubContextWithData({
    vendors: { items: [] },
    expenseCategories: {
      items: [{ id: "c-none", name: "None", isDeleted: false }],
    },
  });
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", fallbackCategoryName: "None" } as any,
    context,
  );
  const data = writes.find((w) => w.spec === "mapping")!.data;
  const categories = data.categories as Record<string, string>;
  assertEquals(categories, { None: "c-none" }); // no counterparty keys injected
  // The hard-override namespace is emitted but empty (inert) when the overlay is absent.
  assertEquals(data.vendorCategories, {});
});

Deno.test("mapTxnToExpense: hard-override collapses two inconsistently-categorized spellings of one vendor into a single category (§7.5 motivation)", () => {
  // Motivating scenario (fabricated equivalents of the real Zetaly split): the
  // same recurring sub arrives under two spellings with DIFFERENT Mercury raw
  // categories. A vendorCategories entry for each spelling routes BOTH to one
  // category, regardless of the real rawCategory.
  const m: Mapping = {
    currencyId: "1",
    vendors: {},
    categories: { Widgets: "c-widget", Snacks: "c-snack" },
    vendorCategories: {
      "Widget.co": "c-target",
      "WidgetCo": "c-target",
    },
    fallbackCategoryId: "c-none",
  };
  // Spelling A: Mercury said Widgets → overridden to the target.
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "Widget.co", rawCategory: "Widgets" }),
      m,
    )
      .category_id,
    "c-target",
  );
  // Spelling B: Mercury said Snacks → overridden to the SAME target.
  assertEquals(
    mapTxnToExpense(txn({ counterparty: "WidgetCo", rawCategory: "Snacks" }), m)
      .category_id,
    "c-target",
  );
});

Deno.test("mapTxnToExpense: a Mapping WITHOUT vendorCategories routes by the frozen rawCategory→counterparty→fallback order (back-compat, §7.5)", () => {
  // An older `mapping` snapshot (pre-override) carries no vendorCategories field.
  // ownLookup null-guards the absent table, so resolution is byte-identical to old.
  const m: Mapping = {
    currencyId: "1",
    vendors: {},
    categories: { Software: "c-sw", "ACME INSURANCE CO": "c-cp" },
    fallbackCategoryId: "c-none",
  };
  assertEquals(
    mapTxnToExpense(txn({ counterparty: "X", rawCategory: "Software" }), m)
      .category_id,
    "c-sw", // rawCategory tier
  );
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "ACME INSURANCE CO", rawCategory: null }),
      m,
    ).category_id,
    "c-cp", // counterparty tier
  );
  assertEquals(
    mapTxnToExpense(txn({ counterparty: "Nobody", rawCategory: null }), m)
      .category_id,
    "c-none", // fallback tier
  );
});

// (COR-2) two distinct raw counterparties → SAME target collapse to ONE create.
Deno.test("upsertVendors: two raws mapped to the same target collapse to a single create (mapping-overlay)", async () => {
  const cfg = {
    ...CFG,
    vendorOverlay: { "Nimbus AI": "Nimbus", "Nimbus AI PBC": "Nimbus" },
  } as unknown as Cfg;
  const { sync } = await runUpsertVendors(
    [
      txn({ id: "t1", counterparty: "Nimbus AI" }),
      txn({ id: "t2", counterparty: "Nimbus AI PBC" }),
    ],
    refFetcher().f,
    true, // dryRun
    cfg,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // Both map to "Nimbus" → distinctByNorm collapses to a single would-create.
  assertEquals(rows.map((r) => r.name), ["Nimbus"]);
});

// (SEC-1/COR-1 fix) a case-variant counterparty is overlayed, NOT re-created as a
// duplicate vendor — the sprawl this feature exists to prevent.
Deno.test("upsertVendors: a case-variant counterparty resolves to the target, no duplicate create (SEC-1/COR-1)", async () => {
  // The active "Nimbus" already exists in IN; the txn counterparty is the
  // lowercase "nimbus ai". Without the case-insensitive overlay, this would
  // create a NEW "nimbus ai" vendor. With the fix it maps to "Nimbus" and
  // skips (already-exists) — no sprawl.
  const { f } = refFetcher({
    initial: [{ id: "v-nimbus", name: "Nimbus" }],
  });
  const cfg = {
    ...CFG,
    vendorOverlay: { "Nimbus AI": "Nimbus" },
  } as unknown as Cfg;
  const { sync } = await runUpsertVendors(
    [txn({ id: "t1", counterparty: "nimbus ai" })],
    f,
    false, // real run — would POST a create if the overlay missed
    cfg,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].name, "Nimbus"); // mapped to the target spelling
  assertEquals(rows[0].action, "skip"); // already-exists → NO duplicate created
  assertEquals(rows[0].reason, "already-exists");
});
