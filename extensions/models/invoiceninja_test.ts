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
  appendOpenPair,
  applyOverlay,
  applyPayment,
  boolOrNull,
  buildInvoiceIndex,
  buildMarkSentIndex,
  buildNameIndex,
  buildTaskLineItem,
  closeOpenPair,
  collectClientDomains,
  computedInvoiceStatus,
  decideStart,
  decideStop,
  derivedExpenseStatus,
  distinctByNorm,
  DRYRUN_SENTINEL,
  emailDomainOf,
  encodeCustomField,
  type FetchLike,
  flattenPaymentables,
  hasOpenTimeLogPair,
  inFetch,
  inFetchAll,
  INVOICE_STATUS,
  type InvoiceIndex,
  invoiceTasksForOne,
  isCandidate,
  isOpenEntry,
  isRunning,
  isValidHashid,
  latestOpenPairIndex,
  mapClientToBody,
  mapInvoiceToBody,
  mapMarkSentBody,
  mapPaymentToBody,
  type Mapping,
  mappingHasSentinel,
  mapProjectToBody,
  mapTaskToBody,
  mapTxnToExpense,
  model,
  normalizeClient,
  normalizeClientContact,
  normalizeClientLean,
  normalizeCompanySettings,
  normalizeExpense,
  normalizeInvoice,
  normalizeMapItem,
  normalizePayment,
  normalizeProject,
  normalizeTask,
  normName,
  notDeleted,
  numOrNull,
  overlayAliases,
  overlayTargetFor,
  ownLookupKeyNorm,
  ownLookupNorm,
  parseTimeLog,
  parseTimeLogEntries,
  PAYMENT_STATUS,
  rawNameIndex,
  resolveByNorm,
  resolveCompanyId,
  splitCustomField,
  strOrNull,
  upsertClient,
  upsertExpense,
  upsertInvoice,
  upsertProject,
  upsertTask,
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
  // Deletion fields default to null when absent (a live row / pre-fix response).
  assertEquals(exp.isDeleted, null);
  assertEquals(exp.archivedAt, null);
});

Deno.test("normalizeExpense() parses is_deleted/archived_at (with_trashed leak fix)", () => {
  // IN's listExpenses returns soft-deleted/archived expenses in both
  // with_trashed states; the read schema must surface them so reports exclude.
  assertEquals(
    normalizeExpense({
      id: "exp-del",
      amount: "9.99",
      custom_value1: "mercury-txn-del",
      is_deleted: true,
      archived_at: 1720000000,
    }),
    {
      id: "exp-del",
      amount: 9.99,
      date: null,
      paymentDate: null,
      categoryId: null,
      vendorId: null,
      clientId: null,
      invoiceId: null,
      currencyId: null,
      derivedStatus: "logged",
      shouldBeInvoiced: null,
      customValue1: "mercury-txn-del",
      isDeleted: true,
      archivedAt: 1720000000,
    },
  );
  // archived_at 0 → null (mirrors normalizeInvoice/normalizeMapItem).
  assertEquals(
    normalizeExpense({ id: "e", is_deleted: false, archived_at: 0 }).archivedAt,
    null,
  );
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
  // Optional per-write overrides (lifetime/garbageCollection/tags) — recorded
  // so the clients-surface tests can assert the getClients lifetime override.
  overrides?: Record<string, unknown>;
}

/** Stub ExecuteContext: no-op logger (recording info+warning), writeResource. */
function stubContext(cfg: Cfg = CFG) {
  const writes: WriteCall[] = [];
  const infos: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const warnings: Array<{ message: string; data?: Record<string, unknown> }> =
    [];
  const noop = (_m: string, _p?: Record<string, unknown>) => {};
  const context = {
    globalArgs: cfg,
    logger: {
      debug: noop,
      info: (m: string, p?: Record<string, unknown>) => {
        infos.push({ message: m, ...(p !== undefined ? { data: p } : {}) });
      },
      warning: (m: string, p?: Record<string, unknown>) => {
        warnings.push({ message: m, ...(p !== undefined ? { data: p } : {}) });
      },
      error: noop,
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
      overrides?: Record<string, unknown>,
    ) => {
      writes.push({
        spec,
        name,
        data,
        ...(overrides !== undefined ? { overrides } : {}),
      });
      return Promise.resolve({ name });
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { context, writes, infos, warnings };
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

Deno.test("listInvoices: scope arg suffixes the snapshot instance name [SCOPE-INV]", async () => {
  const { f } = pagedFetcher([[]]);
  const { context, writes } = stubContext();
  await model.methods.listInvoices.execute(
    // deno-lint-ignore no-explicit-any
    { scope: "snapshot-apply", _fetch: f } as any,
    context,
  );
  // Unique instance name so data.latest resolves it unambiguously across
  // workflows; the spec stays the resource type.
  assertEquals(writes[0].spec, "invoices");
  assertEquals(writes[0].name, "invoices--snapshot-apply");
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

// (V1.1) per-scope resource naming -------------------------------------------
Deno.test("upsertExpenses: syncScope names per-scope resources and self-describes scope [finops V1.1]", async () => {
  const { f } = writeFetcher();
  const { context, writes } = stubContext();
  await model.methods.upsertExpenses.execute(
    // deno-lint-ignore no-explicit-any
    {
      txns: [txn()],
      mapping: MAPPING,
      dryRun: true,
      syncScope: "mercury-abc",
      _fetch: f,
    } as any,
    context,
  );
  // writeResource SPEC (first arg) stays the resource type; only the NAME varies.
  const sync = writes.find((w) => w.spec === "expenseSync")!;
  const errs = writes.find((w) => w.spec === "expenseSyncErrors")!;
  assertEquals(sync.name, "expenseSync--mercury-abc");
  assertEquals(errs.name, "expenseSyncErrors--mercury-abc");
  // The payload `scope` self-describes the scope key (was a constant literal).
  assertEquals(sync.data.scope, "mercury-abc");
  assertEquals(errs.data.scope, "mercury-abc");
});

Deno.test("upsertExpenses: absent syncScope keeps the legacy bare names [finops V1.1 back-compat]", async () => {
  const { f } = writeFetcher();
  const { sync, errs } = await runUpsertExpenses([txn()], f, true);
  assertEquals(sync.name, "expenseSync");
  assertEquals(errs.name, "expenseSyncErrors");
  assertEquals(sync.data.scope, "expenseSync");
  // FR-4: each resource keeps its OWN legacy `scope` literal — the errors payload
  // must stay "expenseSyncErrors", not inherit the sync resource's default.
  assertEquals(errs.data.scope, "expenseSyncErrors");
});

// (finops-digest) finopsDigest method ----------------------------------------

/** Stub context for finopsDigest: a fake expenseSync repo + file writer capture. */
function finopsDigestContext() {
  const meta = { name: "expenseSync--mercury-1", version: 1 };
  const snap = {
    scope: "mercury-1",
    rows: [
      {
        dedupKey: "m1",
        action: "would-create",
        amount: 50,
        date: "2026-07-20",
        counterparty: "Hetzner",
        source: "mercury",
      },
      {
        dedupKey: "m2",
        action: "skip",
        amount: 20,
        date: "2026-07-19",
        counterparty: "Vultr",
        source: "mercury",
      },
    ],
    dryRun: true,
    retrievedAt: "2026-08-02T10:00:00Z",
  };
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const files: Array<{ spec: string; name: string; text: string }> = [];
  const noop = (_m: string, _p?: Record<string, unknown>) => {};
  const context = {
    globalArgs: CFG,
    logger: { debug: noop, info: noop, warning: noop, error: noop },
    modelType: null,
    modelId: "invoiceninja-prod",
    dataRepository: {
      findAllForModel: () => Promise.resolve([meta]),
      getContent: (_t: unknown, _m: string, name: string) =>
        Promise.resolve(
          name === meta.name
            ? new TextEncoder().encode(JSON.stringify(snap))
            : null,
        ),
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    createFileWriter: (spec: string, name: string) => ({
      writeText: (text: string) => {
        files.push({ spec, name, text });
        return Promise.resolve({ name });
      },
    }),
    // deno-lint-ignore no-explicit-any
  } as any;
  return { context, writes, files };
}

Deno.test("finopsDigest: format=all writes summary + detailed markdown resources AND the HTML file", async () => {
  const { context, writes, files } = finopsDigestContext();
  const res = await model.methods.finopsDigest.execute(
    { format: "all" },
    context,
  );
  const summary = writes.find((w) => w.name === "finops-summary.md")!;
  const detailed = writes.find((w) => w.name === "finops-detailed.md")!;
  assertEquals(summary.spec, "finopsDigest");
  assertEquals(summary.data.format, "summary");
  assertEquals(detailed.data.format, "detailed");
  // Meta present for gating/labeling without re-parsing.
  assertEquals(summary.data.newCount, 1);
  assertEquals(summary.data.syncedCount, 1);
  assertEquals(
    (summary.data.window as Record<string, unknown>).start,
    "2026-07-19",
  );
  // The HTML file was written via the file spec.
  assertEquals(files.length, 1);
  assertEquals(files[0].spec, "finopsHtml");
  assertEquals(files[0].name, "finops-digest.html");
  assertEquals(files[0].text.startsWith("<!doctype html>"), true);
  // Three handles returned.
  assertEquals(res.dataHandles.length, 3);
});

Deno.test("finopsDigest: format=summary writes ONLY the summary markdown", async () => {
  const { context, writes, files } = finopsDigestContext();
  await model.methods.finopsDigest.execute({ format: "summary" }, context);
  assertEquals(writes.map((w) => w.name), ["finops-summary.md"]);
  assertEquals(files.length, 0);
});

Deno.test("finopsDigest: format=html writes ONLY the HTML file", async () => {
  const { context, writes, files } = finopsDigestContext();
  await model.methods.finopsDigest.execute({ format: "html" }, context);
  assertEquals(writes.length, 0);
  assertEquals(files.map((f) => f.name), ["finops-digest.html"]);
});

Deno.test("finopsDigest: default format (undefined) behaves as 'all'", async () => {
  const { context, writes, files } = finopsDigestContext();
  await model.methods.finopsDigest.execute({}, context);
  assertEquals(writes.length, 2);
  assertEquals(files.length, 1);
});

Deno.test("finopsDigest: format=detailed writes ONLY the detailed markdown", async () => {
  const { context, writes, files } = finopsDigestContext();
  await model.methods.finopsDigest.execute({ format: "detailed" }, context);
  assertEquals(writes.map((w) => w.name), ["finops-detailed.md"]);
  assertEquals(files.length, 0);
});

Deno.test("finopsDigest: an empty run (no expenseSync resources) writes valid views, never throws", async () => {
  const { context, writes, files } = finopsDigestContext();
  context.dataRepository.findAllForModel = () => Promise.resolve([]);
  const res = await model.methods.finopsDigest.execute(
    { format: "all" },
    context,
  );
  const summary = writes.find((w) => w.name === "finops-summary.md")!;
  assertEquals(summary.data.newCount, 0);
  assertEquals(summary.data.syncedCount, 0);
  assertEquals((summary.data.window as Record<string, unknown>).start, null);
  assertEquals(summary.data.generatedAt, null);
  assertEquals(files.length, 1);
  assertEquals(files[0].text.startsWith("<!doctype html>"), true);
  assertEquals(res.dataHandles.length, 3);
});

Deno.test("finopsDigest: throws a clear error when dataRepository is unavailable", async () => {
  const { context } = finopsDigestContext();
  context.dataRepository = undefined;
  await assertRejects(
    () => model.methods.finopsDigest.execute({ format: "all" }, context),
    Error,
    "dataRepository is unavailable",
  );
});

Deno.test("finopsDigest: html format throws when createFileWriter is unavailable", async () => {
  const { context } = finopsDigestContext();
  context.createFileWriter = undefined;
  await assertRejects(
    () => model.methods.finopsDigest.execute({ format: "html" }, context),
    Error,
    "createFileWriter is unavailable",
  );
});

// (maintenance) archiveExpenses ----------------------------------------------

/** A FetchLike that records url + parsed JSON body (the shared fetcher drops the body). */
function bodyFetcher(respBody: unknown): {
  f: FetchLike;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const f: FetchLike = (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(respBody),
    });
  };
  return { f, calls };
}

Deno.test("archiveExpenses: dryRun previews without hitting the API", async () => {
  const { f, calls } = bodyFetcher({});
  const { context } = stubContext();
  const res = await model.methods.archiveExpenses.execute(
    { ids: ["a", "b"], action: "archive", dryRun: true, _fetch: f },
    context,
  );
  assertEquals(calls.length, 0); // no network in dry-run
  assertEquals(res.dataHandles.length, 0);
});

Deno.test("archiveExpenses: live POSTs /expenses/bulk with action + ids", async () => {
  const { f, calls } = bodyFetcher({ data: [{ id: "a" }, { id: "b" }] });
  const { context } = stubContext();
  await model.methods.archiveExpenses.execute(
    { ids: ["a", "b"], action: "archive", dryRun: false, _fetch: f },
    context,
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url.includes("/expenses/bulk"), true);
  assertEquals(calls[0].body, { action: "archive", ids: ["a", "b"] });
});

Deno.test("archiveExpenses: delete action is passed through", async () => {
  const { f, calls } = bodyFetcher({ data: [{ id: "a" }] });
  const { context } = stubContext();
  await model.methods.archiveExpenses.execute(
    { ids: ["a"], action: "delete", dryRun: false, _fetch: f },
    context,
  );
  assertEquals((calls[0].body as { action: string }).action, "delete");
});

// (maintenance) archiveTasks --------------------------------------------------
Deno.test("archiveTasks: dryRun previews without hitting the API", async () => {
  const { f, calls } = bodyFetcher({});
  const { context } = stubContext();
  const res = await model.methods.archiveTasks.execute(
    { ids: ["t1", "t2"], action: "delete", dryRun: true, _fetch: f },
    context,
  );
  assertEquals(calls.length, 0); // no network in dry-run
  assertEquals(res.dataHandles.length, 0);
});

Deno.test("archiveTasks: live POSTs /tasks/bulk with action + ids", async () => {
  const { f, calls } = bodyFetcher({ data: [{ id: "t1" }] });
  const { context } = stubContext();
  await model.methods.archiveTasks.execute(
    { ids: ["t1"], action: "delete", dryRun: false, _fetch: f },
    context,
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url.includes("/tasks/bulk"), true);
  assertEquals(calls[0].body, { action: "delete", ids: ["t1"] });
});

Deno.test("archiveTasks: defaults to the reversible archive action", async () => {
  const { f, calls } = bodyFetcher({ data: [{ id: "t1" }] });
  const { context } = stubContext();
  await model.methods.archiveTasks.execute(
    // deno-lint-ignore no-explicit-any
    { ids: ["t1"], dryRun: false, _fetch: f } as any,
    context,
  );
  assertEquals((calls[0].body as { action: string }).action, "archive");
});

// (maintenance) archiveClients ------------------------------------------------
Deno.test("archiveClients: dryRun previews without hitting the API", async () => {
  const { f, calls } = bodyFetcher({});
  const { context } = stubContext();
  const res = await model.methods.archiveClients.execute(
    { ids: ["c1", "c2"], action: "delete", dryRun: true, _fetch: f },
    context,
  );
  assertEquals(calls.length, 0); // no network in dry-run
  assertEquals(res.dataHandles.length, 0);
});

Deno.test("archiveClients: live POSTs /clients/bulk with action + ids", async () => {
  const { f, calls } = bodyFetcher({ data: [{ id: "c1" }] });
  const { context } = stubContext();
  await model.methods.archiveClients.execute(
    { ids: ["c1"], action: "archive", dryRun: false, _fetch: f },
    context,
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url.includes("/clients/bulk"), true);
  assertEquals(calls[0].body, { action: "archive", ids: ["c1"] });
});

Deno.test("archiveClients: defaults to the reversible archive action", async () => {
  const { f, calls } = bodyFetcher({ data: [{ id: "c1" }] });
  const { context } = stubContext();
  await model.methods.archiveClients.execute(
    // deno-lint-ignore no-explicit-any
    { ids: ["c1"], dryRun: false, _fetch: f } as any,
    context,
  );
  assertEquals((calls[0].body as { action: string }).action, "archive");
});

// (maintenance) mergeExpenseCategories ----------------------------------------
// (design/specs/invoiceninja-category-merge.spec.md) A single FetchLike that
// serves the two paginated snapshot GETs (expense_categories, expenses) AND
// records/answers the mutating PUT /expenses/{id} + POST /expense_categories/bulk.
// `failPut` forces a specific expense's PUT to 500 (mid-batch-failure test).
function mergeFetcher(opts: {
  categories: Array<Record<string, unknown>>;
  expenses: Array<Record<string, unknown>>;
  failPut?: (id: string) => boolean;
  failPost?: boolean;
}): {
  f: FetchLike;
  calls: Array<{ method: string; url: string; body: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const f: FetchLike = (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    const path = u.pathname;
    const page = Number(u.searchParams.get("page") ?? "1");
    const ok = (json: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(json),
      });
    if (method === "GET") {
      let data: Array<Record<string, unknown>> = [];
      if (path.endsWith("/expense_categories")) {
        data = page === 1 ? opts.categories : [];
      } else if (path.endsWith("/expenses")) {
        data = page === 1 ? opts.expenses : [];
      }
      return ok({
        data,
        meta: { pagination: { current_page: page, total_pages: 1 } },
      });
    }
    if (method === "PUT") {
      const m = path.match(/\/expenses\/([^/]+)$/);
      const id = m ? m[1] : "";
      if (opts.failPut && opts.failPut(id)) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Server Error",
          json: () => Promise.resolve({}),
        });
      }
      return ok({ data: { id } });
    }
    // POST /expense_categories/bulk
    const ids = (body?.ids ?? []) as string[];
    if (opts.failPost) {
      return Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Server Error",
        json: () => Promise.resolve({}),
      });
    }
    return ok({ data: ids.map((id) => ({ id })) });
  };
  return { f, calls };
}

const rawCat = (
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({ id, name, ...extra });
const rawExp = (
  id: string,
  category_id: string | null,
  extra: Record<string, unknown> = {},
) => ({ id, category_id, amount: 10, ...extra });
const mergeAudit = (writes: WriteCall[]) =>
  writes.find((w) => w.spec === "categoryMerge")?.data as
    | Record<string, unknown>
    | undefined;
const puts = <T extends { method: string }>(calls: T[]) =>
  calls.filter((c) => c.method === "PUT");
const posts = <T extends { method: string }>(calls: T[]) =>
  calls.filter((c) => c.method === "POST");

// (T1) dry-run previews the plan and hits the wire with ZERO PUT/POST.
Deno.test("mergeExpenseCategories: dry-run plans reassign+archive, no PUT/POST [T1]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("none", "None"),
      rawCat("src", "Software / Licensing"),
      rawCat("tgt", "Software & Subscriptions"),
    ],
    expenses: [rawExp("e1", "src"), rawExp("e2", "src")],
  });
  const { context, writes } = stubContext();
  await model.methods.mergeExpenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    {
      merges: [{ fromIds: ["src"], toId: "tgt" }],
      dryRun: true,
      _fetch: f,
    } as any,
    context,
  );
  assertEquals(puts(calls).length, 0);
  assertEquals(posts(calls).length, 0);
  const audit = mergeAudit(writes)!;
  assertEquals(audit.dryRun, true);
  assertEquals((audit.reassignments as unknown[]).length, 2); // reassignedCount
  assertEquals(audit.deletions, ["src"]); // deletedCount == 1
});

// (T2) live reassign: one expense on the source → exactly one PUT to toId.
Deno.test("mergeExpenseCategories: live reassign PUTs expenses/{id} category_id=toId [T2]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("none", "None"),
      rawCat("src", "Legal"),
      rawCat("tgt", "Legal / Accounting"),
    ],
    expenses: [rawExp("e1", "src")],
  });
  const { context, writes } = stubContext();
  await model.methods.mergeExpenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    {
      merges: [{ fromIds: ["src"], toId: "tgt" }],
      dryRun: false,
      _fetch: f,
    } as any,
    context,
  );
  const p = puts(calls);
  assertEquals(p.length, 1);
  assertEquals(p[0].url.includes("/expenses/e1"), true);
  assertEquals((p[0].body as { category_id: string }).category_id, "tgt");
  const audit = mergeAudit(writes)!;
  assertEquals((audit.reassignments as unknown[]).length, 1);
});

// (T3) delete-guard: a deleteId that still holds a live expense is NOT archived.
Deno.test("mergeExpenseCategories: delete-guard skips a category with live expenses [T3]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [rawCat("none", "None"), rawCat("d1", "Consulting Services")],
    expenses: [rawExp("e1", "d1")], // still live, not reassigned anywhere
  });
  const { context, writes } = stubContext();
  await model.methods.mergeExpenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    { deleteIds: ["d1"], dryRun: false, _fetch: f } as any,
    context,
  );
  assertEquals(posts(calls).length, 0); // nothing archived
  const audit = mergeAudit(writes)!;
  assertEquals(audit.deletions, []);
  const skipped = audit.skipped as Array<Record<string, unknown>>;
  assertEquals(
    skipped.some((s) =>
      s.categoryId === "d1" && s.reason === "still-has-live-expenses" &&
      s.remaining === 1
    ),
    true,
  );
});

// (T4) fallback guard: the ensured fallback in fromIds/deleteIds throws, NO writes.
Deno.test("mergeExpenseCategories: fallback in fromIds throws with no writes [T4]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("none", "None"),
      rawCat("tgt", "Software & Subscriptions"),
    ],
    expenses: [],
  });
  const { context, writes } = stubContext();
  await assertRejects(
    () =>
      model.methods.mergeExpenseCategories.execute(
        // deno-lint-ignore no-explicit-any
        {
          merges: [{ fromIds: ["none"], toId: "tgt" }],
          dryRun: false,
          _fetch: f,
        } as any,
        context,
      ),
    Error,
    "fallback category",
  );
  assertEquals(puts(calls).length, 0);
  assertEquals(posts(calls).length, 0);
  assertEquals(writes.length, 0); // no categoryMerge audit written
});

// (T5) idempotency: re-running a completed merge is a clean no-op.
Deno.test("mergeExpenseCategories: re-run after completion is a no-op [T5]", async () => {
  const { f, calls } = mergeFetcher({
    // Source already emptied AND archived by the prior run.
    categories: [
      rawCat("none", "None"),
      rawCat("src", "Software / Licensing", { archived_at: 1_700_000_000 }),
      rawCat("tgt", "Software & Subscriptions"),
    ],
    expenses: [rawExp("e1", "tgt")], // already reassigned onto the target
  });
  const { context, writes } = stubContext();
  await model.methods.mergeExpenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    {
      merges: [{ fromIds: ["src"], toId: "tgt" }],
      dryRun: false,
      _fetch: f,
    } as any,
    context,
  );
  assertEquals(puts(calls).length, 0); // nothing to reassign
  assertEquals(posts(calls).length, 0); // already archived → no destructive bulk
  const audit = mergeAudit(writes)!;
  assertEquals((audit.reassignments as unknown[]).length, 0);
  assertEquals(audit.deletions, []);
});

// (T6) archived expenses reassign too, so the source can fully empty.
Deno.test("mergeExpenseCategories: archived expenses are reassigned [T6]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("none", "None"),
      rawCat("src", "Subscriptions"),
      rawCat("tgt", "Software & Subscriptions"),
    ],
    expenses: [rawExp("e1", "src", { archived_at: 1_700_000_000 })],
  });
  const { context, writes } = stubContext();
  await model.methods.mergeExpenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    {
      merges: [{ fromIds: ["src"], toId: "tgt" }],
      dryRun: false,
      _fetch: f,
    } as any,
    context,
  );
  const p = puts(calls);
  assertEquals(p.length, 1);
  assertEquals(p[0].url.includes("/expenses/e1"), true);
  const audit = mergeAudit(writes)!;
  const r = (audit.reassignments as Array<Record<string, unknown>>)[0];
  assertEquals(r.archived, true);
  assertEquals(audit.deletions, ["src"]); // emptied → archived
});

// (T7) multi-group fan-out: both groups apply in one call.
Deno.test("mergeExpenseCategories: two merge groups both apply in one call [T7]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("none", "None"),
      rawCat("a", "Software"),
      rawCat("A", "Software & Subscriptions"),
      rawCat("b", "Legal"),
      rawCat("B", "Legal / Accounting"),
    ],
    expenses: [rawExp("ea", "a"), rawExp("eb", "b")],
  });
  const { context, writes } = stubContext();
  await model.methods.mergeExpenseCategories.execute(
    {
      merges: [
        { fromIds: ["a"], toId: "A" },
        { fromIds: ["b"], toId: "B" },
      ],
      dryRun: false,
      // deno-lint-ignore no-explicit-any
      _fetch: f,
    } as any,
    context,
  );
  const p = puts(calls);
  assertEquals(p.length, 2);
  const byId = Object.fromEntries(
    p.map((c) => [
      c.url.split("/expenses/")[1],
      (c.body as { category_id: string }).category_id,
    ]),
  );
  assertEquals(byId["ea"], "A");
  assertEquals(byId["eb"], "B");
  const archive = posts(calls)[0].body as { action: string; ids: string[] };
  assertEquals(archive.ids.sort(), ["a", "b"]);
  const audit = mergeAudit(writes)!;
  assertEquals((audit.reassignments as unknown[]).length, 2);
});

// (T8) a mid-batch PUT failure processes the rest and flushes the audit.
Deno.test("mergeExpenseCategories: mid-batch failure keeps going, flushes errors [T8]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("none", "None"),
      rawCat("src", "Software / Licensing"),
      rawCat("tgt", "Software & Subscriptions"),
    ],
    expenses: [rawExp("e1", "src"), rawExp("e2", "src"), rawExp("e3", "src")],
    failPut: (id) => id === "e2",
  });
  const { context, writes } = stubContext();
  await model.methods.mergeExpenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    {
      merges: [{ fromIds: ["src"], toId: "tgt" }],
      dryRun: false,
      _fetch: f,
    } as any,
    context,
  );
  const p = puts(calls);
  assertEquals(p.length, 3); // all three attempted
  const audit = mergeAudit(writes)!;
  const errs = audit.errors as Array<Record<string, unknown>>;
  assertEquals(errs.length, 1);
  assertEquals(errs[0].expenseId, "e2");
  // reassignedCount == 2 (plan 3, one failed) — derived from plan minus errors.
  assertEquals((audit.reassignments as unknown[]).length, 3);
  // Source NOT emptied (e2 stayed) → NOT archived.
  assertEquals(audit.deletions, []);
  assertEquals(posts(calls).length, 0);
});

// (T9) an unknown toId is rejected before any write.
Deno.test("mergeExpenseCategories: unknown toId throws with no writes [T9]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [rawCat("src", "Software")],
    expenses: [rawExp("e1", "src")],
  });
  const { context, writes } = stubContext();
  await assertRejects(
    () =>
      model.methods.mergeExpenseCategories.execute(
        // deno-lint-ignore no-explicit-any
        {
          merges: [{ fromIds: ["src"], toId: "ghost" }],
          dryRun: false,
          _fetch: f,
        } as any,
        context,
      ),
    Error,
    "not in the",
  );
  assertEquals(puts(calls).length, 0);
  assertEquals(posts(calls).length, 0);
  assertEquals(writes.length, 0);
});

// (T10) the bulk-archive body carries action+ids and archives EXACTLY the two
// emptied sources of a 2-group run — the two targets (and fallback) never appear.
// (Rewritten from a vacuous version whose 'tgt'/'none' could never be candidates
// regardless of any guard: here BOTH sources are real archive candidates that get
// emptied, so the assertion that only-sources-are-archived is load-bearing.)
Deno.test("mergeExpenseCategories: bulk-archive shape archives exactly the emptied sources [T10]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("none", "None"), // fallback — kept
      rawCat("s1", "Software / Licensing"),
      rawCat("t1", "Software & Subscriptions"), // target 1 — kept
      rawCat("s2", "Subscriptions"),
      rawCat("t2", "Meals / Entertainment"), // target 2 — kept
    ],
    expenses: [rawExp("e1", "s1"), rawExp("e2", "s2")],
  });
  const { context } = stubContext();
  await model.methods.mergeExpenseCategories.execute(
    {
      merges: [
        { fromIds: ["s1"], toId: "t1" },
        { fromIds: ["s2"], toId: "t2" },
      ],
      dryRun: false,
      // deno-lint-ignore no-explicit-any
      _fetch: f,
    } as any,
    context,
  );
  const archive = posts(calls)[0].body as { action: string; ids: string[] };
  assertEquals(archive.action, "archive");
  assertEquals(archive.ids.sort(), ["s1", "s2"]); // exactly the emptied sources
  for (const kept of ["t1", "t2", "none"]) {
    assertEquals(archive.ids.includes(kept), false); // targets + fallback kept
  }
});

// (T11) if the bulk-archive POST itself fails, NOTHING was archived: deletions
// stays [] (never a lie), archiveError carries the attempted ids, deletedCount is
// 0, and the method still RETURNS with the audit persisted (the reassignments
// already landed and must not be lost). [SEC-3/COR-1]
Deno.test("mergeExpenseCategories: archive-POST failure keeps deletions honest [T11]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("none", "None"),
      rawCat("src", "Software / Licensing"),
      rawCat("tgt", "Software & Subscriptions"),
    ],
    expenses: [rawExp("e1", "src")],
    failPost: true,
  });
  const { context, writes } = stubContext();
  const res = await model.methods.mergeExpenseCategories.execute(
    // deno-lint-ignore no-explicit-any
    {
      merges: [{ fromIds: ["src"], toId: "tgt" }],
      dryRun: false,
      _fetch: f,
    } as any,
    context,
  );
  // Reassignment landed (1 PUT), archive POST was attempted (1 POST) and failed.
  assertEquals(puts(calls).length, 1);
  assertEquals(posts(calls).length, 1);
  const audit = mergeAudit(writes)!;
  assertEquals(audit.deletions, []); // nothing archived — not a lie
  const ae = audit.archiveError as Record<string, unknown> | null;
  assertEquals(ae !== null, true);
  assertEquals(ae!.ids as string[], ["src"]); // what we tried to archive
  assertEquals(typeof ae!.error, "string");
  // Method returned (did not reject) and still emitted the audit handle.
  assertEquals((res.dataHandles as unknown[]).length, 1);
});

// (T12) chained/transitive merges (X→Y, Y→Z) are rejected up front — one-hop
// reassignment would strand X's expenses on Y. Throw before any write. [COR-4]
Deno.test("mergeExpenseCategories: chained/transitive merge throws with no writes [T12]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("none", "None"),
      rawCat("X", "Software"),
      rawCat("Y", "Software / Licensing"),
      rawCat("Z", "Software & Subscriptions"),
    ],
    expenses: [rawExp("e1", "X"), rawExp("e2", "Y")],
  });
  const { context, writes } = stubContext();
  await assertRejects(
    () =>
      model.methods.mergeExpenseCategories.execute(
        {
          merges: [
            { fromIds: ["X"], toId: "Y" },
            { fromIds: ["Y"], toId: "Z" },
          ],
          dryRun: false,
          // deno-lint-ignore no-explicit-any
          _fetch: f,
        } as any,
        context,
      ),
    Error,
    "chained/transitive merge",
  );
  assertEquals(puts(calls).length, 0);
  assertEquals(posts(calls).length, 0);
  assertEquals(writes.length, 0);
});

// (T13) fail-CLOSED fallback: when fallbackName resolves to NO live category the
// method REFUSES to run (rather than silently skipping the guard, which would
// leave the real fallback exposed). [SEC-1]
Deno.test("mergeExpenseCategories: unresolved fallback name fails closed [T13]", async () => {
  const { f, calls } = mergeFetcher({
    // No category named 'None' at all → the guard cannot bind.
    categories: [
      rawCat("src", "Software / Licensing"),
      rawCat("tgt", "Software & Subscriptions"),
    ],
    expenses: [rawExp("e1", "src")],
  });
  const { context, writes } = stubContext();
  await assertRejects(
    () =>
      model.methods.mergeExpenseCategories.execute(
        // deno-lint-ignore no-explicit-any
        {
          merges: [{ fromIds: ["src"], toId: "tgt" }],
          dryRun: false,
          _fetch: f,
        } as any,
        context,
      ),
    Error,
    "refusing to run a merge without a resolved fallback guard",
  );
  assertEquals(puts(calls).length, 0);
  assertEquals(posts(calls).length, 0);
  assertEquals(writes.length, 0);
});

// (T14) SEC-2: a soft-deleted duplicate named 'None' with a SMALLER id must NOT
// hijack the guard. Resolution is over LIVE categories only, so the guard binds
// the live 'None' — and putting THAT id in fromIds throws V2. (Under the old
// unfiltered resolveByNorm the dead 'aaa' id would have won and the live 'none'
// would have been unprotected.)
Deno.test("mergeExpenseCategories: archived duplicate name does not hijack the fallback guard [T14]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("aaa", "None", { is_deleted: true }), // dead dup, lexicographically smallest
      rawCat("none", "None"), // the live fallback
      rawCat("tgt", "Software & Subscriptions"),
    ],
    expenses: [],
  });
  const { context, writes } = stubContext();
  await assertRejects(
    () =>
      model.methods.mergeExpenseCategories.execute(
        // Merging the LIVE fallback must be refused (V2) — proving the guard
        // bound to 'none', not the dead 'aaa'.
        // deno-lint-ignore no-explicit-any
        {
          merges: [{ fromIds: ["none"], toId: "tgt" }],
          dryRun: false,
          _fetch: f,
        } as any,
        context,
      ),
    Error,
    "must not appear in any fromIds/deleteIds",
  );
  assertEquals(puts(calls).length, 0);
  assertEquals(writes.length, 0);
});

// (T15) explicit fallbackId: bypasses the name lookup and guards that id. An
// unknown fallbackId is rejected; a valid one protects its category (V2). [SEC-1]
Deno.test("mergeExpenseCategories: explicit fallbackId is validated and guards [T15]", async () => {
  const { f, calls } = mergeFetcher({
    categories: [
      rawCat("keep", "House Fallback"),
      rawCat("src", "Software / Licensing"),
      rawCat("tgt", "Software & Subscriptions"),
    ],
    expenses: [rawExp("e1", "src")],
  });
  // (a) unknown fallbackId → reject before any write.
  {
    const { context, writes } = stubContext();
    await assertRejects(
      () =>
        model.methods.mergeExpenseCategories.execute(
          // deno-lint-ignore no-explicit-any
          {
            merges: [{ fromIds: ["src"], toId: "tgt" }],
            fallbackId: "ghost",
            dryRun: false,
            _fetch: f,
          } as any,
          context,
        ),
      Error,
      "cannot guard it",
    );
    assertEquals(writes.length, 0);
  }
  // (b) valid fallbackId protects its category — placing it in deleteIds throws V2.
  {
    const { context, writes } = stubContext();
    await assertRejects(
      () =>
        model.methods.mergeExpenseCategories.execute(
          // deno-lint-ignore no-explicit-any
          {
            deleteIds: ["keep"],
            fallbackId: "keep",
            dryRun: false,
            _fetch: f,
          } as any,
          context,
        ),
      Error,
      "must not appear in any fromIds/deleteIds",
    );
    assertEquals(writes.length, 0);
  }
  assertEquals(puts(calls).length, 0);
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

// ===========================================================================
// Case-variant counterparty attribution (follow-up #2)
// ===========================================================================

Deno.test("ownLookupNorm: byte-exact fast path; case-insensitive fallback; null-safe", () => {
  const table = { "ACME INSURANCE CO": "c-ins", "Widget.Co": "c-widget" };
  // Byte-exact match (fast path).
  assertEquals(ownLookupNorm(table, "ACME INSURANCE CO"), "c-ins");
  assertEquals(ownLookupNorm(table, "Widget.Co"), "c-widget");
  // Case-insensitive fallback.
  assertEquals(ownLookupNorm(table, "acme insurance co"), "c-ins");
  assertEquals(ownLookupNorm(table, "ACME insurance co"), "c-ins");
  assertEquals(ownLookupNorm(table, "  Acme Insurance Co  "), "c-ins"); // trim
  assertEquals(ownLookupNorm(table, "widget.co"), "c-widget");
  assertEquals(ownLookupNorm(table, "WIDGET.CO"), "c-widget");
  // Miss → undefined.
  assertEquals(ownLookupNorm(table, "Nobody"), undefined);
  assertEquals(ownLookupNorm(table, ""), undefined); // empty → no match
  // Null-safe.
  assertEquals(ownLookupNorm(table, null), undefined);
  assertEquals(ownLookupNorm(undefined, "ACME INSURANCE CO"), undefined);
  assertEquals(ownLookupNorm(undefined, null), undefined);
  // Prototype safety — no accidental hit on inherited members.
  assertEquals(ownLookupNorm(table, "__proto__"), undefined);
  assertEquals(ownLookupNorm(table, "constructor"), undefined);
  assertEquals(ownLookupNorm(table, "toString"), undefined);
});

Deno.test("mapTxnToExpense: case-variant counterparty resolves through vendorCategories (hard-override, follow-up #2)", () => {
  // Config key is uppercase; bank counterparty is mixed-case. The case-insensitive
  // fallback in ownLookupNorm bridges the gap — the vendor category wins over
  // Mercury's rawCategory.
  const m: Mapping = {
    currencyId: "1",
    vendors: { "ACME INSURANCE CO": "v-acme" },
    categories: { "Software": "c-sw" },
    vendorCategories: { "ACME INSURANCE CO": "c-ins" },
    fallbackCategoryId: "c-none",
  };
  // Exact match (fast path) — unchanged behavior.
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "ACME INSURANCE CO", rawCategory: "Software" }),
      m,
    ).category_id,
    "c-ins",
  );
  // Case-variant match — NEW: resolves via normName fallback.
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "Acme Insurance Co", rawCategory: "Software" }),
      m,
    ).category_id,
    "c-ins", // hard-override wins, even with different case
  );
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "acme insurance co", rawCategory: null }),
      m,
    ).category_id,
    "c-ins",
  );
  // Whitespace-variant match — also resolves.
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "  ACME INSURANCE CO  ", rawCategory: null }),
      m,
    ).category_id,
    "c-ins",
  );
  // Vendor attribution also works case-insensitively.
  assertEquals(
    vendorFor("acme insurance co", m),
    "v-acme",
  );
  assertEquals(
    vendorFor("Acme Insurance Co", m),
    "v-acme",
  );
});

Deno.test("mapTxnToExpense: case-variant counterparty resolves through categories (counterparty tier)", () => {
  // The categories table is keyed by counterparty (via rawNameIndex + overlayAliases).
  // A case-variant counterparty resolves through the normName fallback.
  const m: Mapping = {
    currencyId: "1",
    vendors: {},
    categories: { "ACME INSURANCE CO": "c-cp" },
    fallbackCategoryId: "c-none",
  };
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "Acme Insurance Co", rawCategory: null }),
      m,
    )
      .category_id,
    "c-cp",
  );
  assertEquals(
    mapTxnToExpense(
      txn({ counterparty: "acme insurance co", rawCategory: null }),
      m,
    )
      .category_id,
    "c-cp",
  );
});

Deno.test("mapTxnToExpense: case-variant rawCategory resolves through categories (rawCategory tier)", () => {
  // The categories table is also keyed by rawCategory. A case-variant rawCategory
  // resolves through the normName fallback.
  const m: Mapping = {
    currencyId: "1",
    vendors: {},
    categories: { "Software": "c-sw" },
    fallbackCategoryId: "c-none",
  };
  assertEquals(
    mapTxnToExpense(txn({ counterparty: "Nobody", rawCategory: "software" }), m)
      .category_id,
    "c-sw",
  );
  assertEquals(
    mapTxnToExpense(txn({ counterparty: "Nobody", rawCategory: "SOFTWARE" }), m)
      .category_id,
    "c-sw",
  );
});

Deno.test("mapTxnToExpense: exact match preferred over case-variant (deterministic precedence)", () => {
  // If the mapping has BOTH an exact match AND a case-variant match for different
  // targets, the exact match wins (fast path returns first).
  const m: Mapping = {
    currencyId: "1",
    vendors: {},
    categories: { "acme": "c-lower", "ACME": "c-upper" },
    fallbackCategoryId: "c-none",
  };
  // "ACME" is byte-exact → c-upper (fast path).
  assertEquals(
    mapTxnToExpense(txn({ counterparty: "ACME", rawCategory: null }), m)
      .category_id,
    "c-upper",
  );
  // "acme" is byte-exact → c-lower (fast path).
  assertEquals(
    mapTxnToExpense(txn({ counterparty: "acme", rawCategory: null }), m)
      .category_id,
    "c-lower",
  );
  // "Acme" is neither → falls back to case-insensitive scan; first entry wins
  // (Object.entries iteration order = insertion order; "acme" was inserted first
  // in the literal above).
  assertEquals(
    mapTxnToExpense(txn({ counterparty: "Acme", rawCategory: null }), m)
      .category_id,
    "c-lower",
  );
});

Deno.test("upsertExpenseCategories: case-variant counterparty logs info (not warning) and ensures the target (follow-up #2)", async () => {
  // The counterparty "acme insurance co" (lowercase) matches the overlay key
  // "ACME INSURANCE CO" (uppercase) case-insensitively. Under the new behavior
  // the target IS ensured (the mapping consume will match), and the log is info
  // (not warning) — it's an audit note, not an error.
  const cfg = {
    ...CFG,
    vendorCategoryOverlay: { "ACME INSURANCE CO": "Insurance" },
  } as unknown as Cfg;
  const { context, writes, infos } = stubContext(cfg);
  await model.methods.upsertExpenseCategories.execute(
    {
      txns: [
        txn({
          id: "t1",
          counterparty: "acme insurance co", // lowercase variant
          rawCategory: null,
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
  // Insurance (vendor target) + Uncategorized fallback. The target IS ensured
  // because the case-insensitive match succeeded.
  assertEquals(rows.map((r) => r.name).sort(), [
    "Insurance",
    "Uncategorized",
  ]);
  // The info log fired for the case-variant match.
  const variantInfos = infos.filter((l) =>
    l.message.includes("case/whitespace variant")
  );
  assertEquals(variantInfos.length, 1);
  assertEquals(variantInfos[0].data?.key, "ACME INSURANCE CO");
  assertEquals(variantInfos[0].data?.cp, "acme insurance co");
});

// ===========================================================================
// §7.6 Dry-run mapping projection (faithful preview) — buildMapping unions
// would-create vendor/category names (from vendorSync/categorySync) onto the
// DRYRUN_SENTINEL id when dryRun=true; upsertExpenses resolves those binds
// into additive projectedVendor/projectedCategory preview fields; a live
// write THROWS if a sentinel ever resolves. All synthetic names — no real
// vendor/counterparty data.
// ===========================================================================

// (1) buildMapping (dryRun): unions a would-create VENDOR name onto the sentinel.
Deno.test("buildMapping (dryRun): unions a would-create vendor name into the mapping bound to DRYRUN_SENTINEL [§7.6]", async () => {
  const { context, writes } = stubContextWithData({
    vendors: { items: [{ id: "v-aws", name: "AWS" }] },
    expenseCategories: { items: [{ id: "c-unc", name: "Uncategorized" }] },
    vendorSync: {
      rows: [
        { name: "Widget Co", action: "would-create", vendorId: null },
        {
          name: "AWS",
          action: "skip",
          vendorId: "v-aws",
          reason: "already-exists",
        },
      ],
    },
  });
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", dryRun: true } as any,
    context,
  );
  const m = writes.find((w) => w.spec === "mapping")!.data;
  assertEquals(m.vendors, { AWS: "v-aws", "Widget Co": DRYRUN_SENTINEL });
});

// (2) symmetric — buildMapping (dryRun): unions a would-create CATEGORY name.
Deno.test("buildMapping (dryRun): unions a would-create category name into the mapping bound to DRYRUN_SENTINEL [§7.6]", async () => {
  const { context, writes } = stubContextWithData({
    vendors: { items: [] },
    expenseCategories: { items: [{ id: "c-unc", name: "Uncategorized" }] },
    categorySync: {
      rows: [{ name: "Utilities", action: "would-create", categoryId: null }],
    },
  });
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", dryRun: true } as any,
    context,
  );
  const m = writes.find((w) => w.spec === "mapping")!.data;
  assertEquals(m.categories, {
    Uncategorized: "c-unc",
    Utilities: DRYRUN_SENTINEL,
  });
});

// (3) a real existing bind ALWAYS wins over a same-normalized-name would-create.
Deno.test("buildMapping (dryRun): a real existing vendor wins over a same-name would-create (real hashid, not sentinel) [§7.6]", async () => {
  const { context, writes } = stubContextWithData({
    vendors: { items: [{ id: "v-widget", name: "Widget Co" }] },
    expenseCategories: { items: [{ id: "c-unc", name: "Uncategorized" }] },
    vendorSync: {
      // Case-variant would-create row for the SAME normalized entity.
      rows: [{ name: "widget co", action: "would-create", vendorId: null }],
    },
  });
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", dryRun: true } as any,
    context,
  );
  const m = writes.find((w) => w.spec === "mapping")!.data;
  assertEquals(m.vendors, { "Widget Co": "v-widget" }); // no sentinel key added
});

// (4) dryRun=false: NO sentinel binds, and vendorSync/categorySync are never read.
Deno.test("buildMapping (dryRun=false): produces NO sentinel binds and never reads vendorSync/categorySync [§7.6]", async () => {
  const seed: Record<string, Record<string, unknown>> = {
    vendors: { items: [{ id: "v-aws", name: "AWS" }] },
    expenseCategories: { items: [{ id: "c-unc", name: "Uncategorized" }] },
    vendorSync: {
      rows: [{ name: "Widget Co", action: "would-create", vendorId: null }],
    },
    categorySync: {
      rows: [{ name: "Utilities", action: "would-create", categoryId: null }],
    },
  };
  const { context, writes } = stubContextWithData(seed);
  const readCalls: string[] = [];
  // deno-lint-ignore no-explicit-any
  const origRead = (context as any).readResource;
  // deno-lint-ignore no-explicit-any
  (context as any).readResource = (name: string) => {
    readCalls.push(name);
    return origRead(name);
  };
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", dryRun: false } as any,
    context,
  );
  const m = writes.find((w) => w.spec === "mapping")!.data;
  assertEquals(m.vendors, { AWS: "v-aws" }); // no "Widget Co" sentinel entry
  assertEquals(m.categories, { Uncategorized: "c-unc" }); // no "Utilities" sentinel entry
  assertEquals(readCalls.includes("vendorSync"), false);
  assertEquals(readCalls.includes("categorySync"), false);
});

// (5) live-write guard — a sentinel id THROWS before it can ever hit a real POST.
Deno.test("upsertExpense: a sentinel vendor_id THROWS on a live POST (defense-in-depth, §7.6)", async () => {
  const sentinelMapping: Mapping = {
    currencyId: "1",
    vendors: { "Widget Co": DRYRUN_SENTINEL },
    categories: {},
    fallbackCategoryId: "cat-fallback",
  };
  const { f, calls } = writeFetcher();
  await assertRejects(
    () =>
      upsertExpense(
        CFG,
        txn({ counterparty: "Widget Co" }),
        sentinelMapping,
        false, // LIVE
        f,
      ),
    Error,
    DRYRUN_SENTINEL,
  );
  assertEquals(postCount(calls), 0); // never reached the POST
});

Deno.test("upsertExpense: a sentinel category_id THROWS on a live POST (defense-in-depth, §7.6)", async () => {
  const sentinelMapping: Mapping = {
    currencyId: "1",
    vendors: { AWS: "vend-aws" },
    categories: { software: DRYRUN_SENTINEL },
    fallbackCategoryId: "cat-fallback",
  };
  const { f, calls } = writeFetcher();
  await assertRejects(
    () =>
      upsertExpense(
        CFG,
        txn({ rawCategory: "software" }),
        sentinelMapping,
        false,
        f,
      ),
    Error,
    DRYRUN_SENTINEL,
  );
  assertEquals(postCount(calls), 0);
});

// (6) upsertExpenses (dryRun): a sentinel-bound VENDOR resolves — unmatchedVendor
// flips to false and projectedVendor names the match.
Deno.test("upsertExpenses (dryRun): a sentinel-bound vendor reports unmatchedVendor:false + projectedVendor [§7.6]", async () => {
  const mapping: Mapping = {
    currencyId: "1",
    vendors: { "Widget Co": DRYRUN_SENTINEL },
    categories: { software: "cat-sw" },
    fallbackCategoryId: "cat-fallback",
  };
  const { context, writes } = stubContext();
  await model.methods.upsertExpenses.execute(
    {
      txns: [txn({ counterparty: "Widget Co" })],
      mapping,
      dryRun: true,
      _fetch: writeFetcher().f,
      // deno-lint-ignore no-explicit-any
    } as any,
    context,
  );
  const rows = writes.find((w) => w.spec === "expenseSync")!.data
    .rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].unmatchedVendor, false);
  assertEquals(rows[0].projectedVendor, "Widget Co");
  assertEquals(rows[0].projectedCategory, null); // category resolved to a REAL id
  // finops-daily-review (A1/A2): the row carries the source txn's counterparty
  // + source so the finops-review report needs no cross-model join.
  assertEquals(rows[0].counterparty, "Widget Co");
  assertEquals(rows[0].source, "mercury");
});

// (7) symmetric — a sentinel-bound CATEGORY resolves — projectedCategory set.
Deno.test("upsertExpenses (dryRun): a sentinel-bound category reports projectedCategory [§7.6]", async () => {
  const mapping: Mapping = {
    currencyId: "1",
    vendors: { AWS: "vend-aws" },
    categories: { software: DRYRUN_SENTINEL },
    fallbackCategoryId: "cat-fallback",
  };
  const { context, writes } = stubContext();
  await model.methods.upsertExpenses.execute(
    {
      txns: [txn({ rawCategory: "software" })],
      mapping,
      dryRun: true,
      _fetch: writeFetcher().f,
      // deno-lint-ignore no-explicit-any
    } as any,
    context,
  );
  const rows = writes.find((w) => w.spec === "expenseSync")!.data
    .rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].projectedCategory, "software");
  assertEquals(rows[0].projectedVendor, null); // vendor resolved to a REAL id
});

// (8) a genuinely null/blank counterparty stays unmatchedVendor:true, NOT projected.
Deno.test("upsertExpenses (dryRun): a null counterparty stays unmatchedVendor:true, not projected [§7.6]", async () => {
  const mapping: Mapping = {
    currencyId: "1",
    vendors: { "Widget Co": DRYRUN_SENTINEL },
    categories: {},
    fallbackCategoryId: "cat-fallback",
  };
  const { context, writes } = stubContext();
  await model.methods.upsertExpenses.execute(
    {
      txns: [txn({ counterparty: null })],
      mapping,
      dryRun: true,
      _fetch: writeFetcher().f,
      // deno-lint-ignore no-explicit-any
    } as any,
    context,
  );
  const rows = writes.find((w) => w.spec === "expenseSync")!.data
    .rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].unmatchedVendor, true);
  assertEquals(rows[0].projectedVendor, null);
});

// (9) the IN expense POST body NEVER carries the preview-only projected fields.
Deno.test("upsertExpense: the IN POST body never contains projectedVendor/projectedCategory [§7.6]", async () => {
  const { f, calls } = writeFetcher();
  await upsertExpense(CFG, txn(), MAPPING, false, f);
  const postCall = calls.find((c) => (c.method ?? "GET") === "POST")!;
  const body = JSON.parse(postCall.body!) as Record<string, unknown>;
  assertEquals("projectedVendor" in body, false);
  assertEquals("projectedCategory" in body, false);
  // finops-daily-review (A1/A2): the additive row fields are projection-only —
  // never part of the IN expense POST body either.
  assertEquals("counterparty" in body, false);
  assertEquals("source" in body, false);
});

// Pure-helper coverage for the new key-returning lookup.
Deno.test("ownLookupKeyNorm: byte-exact fast path; case-insensitive fallback; null-safe", () => {
  const table = { "Widget Co": DRYRUN_SENTINEL };
  assertEquals(ownLookupKeyNorm(table, "Widget Co"), "Widget Co");
  assertEquals(ownLookupKeyNorm(table, "widget co"), "Widget Co");
  assertEquals(ownLookupKeyNorm(table, "Nobody"), undefined);
  assertEquals(ownLookupKeyNorm(table, null), undefined);
  assertEquals(ownLookupKeyNorm(undefined, "Widget Co"), undefined);
});

// DRP-03 — tier-order invariant: a REAL vendorCategories (tier-1) bind wins over
// a would-create category whose name matches the txn's rawCategory. The row-
// shaper's reimplementation MUST honor the same precedence as the frozen
// mapTxnToExpense, so projectedCategory is null (the real bind resolved, not a
// sentinel). Guards against the two resolution paths drifting.
Deno.test("upsertExpenses (dryRun): a real vendorCategories bind wins over a same-name would-create rawCategory → projectedCategory null (tier-order invariant, DRP-03)", async () => {
  const mapping: Mapping = {
    currencyId: "1",
    vendors: { "Widget Co": "vend-widget" }, // real vendor → projectedVendor null
    // rawCategory "software" would ALSO be a sentinel bind (as if projected),
    // but the tier-1 vendorCategories bind for the counterparty must win first.
    categories: { software: DRYRUN_SENTINEL },
    vendorCategories: { "Widget Co": "cat-real-override" }, // REAL id, tier 1
    fallbackCategoryId: "cat-fallback",
  };
  // Sanity: the frozen body resolves category to the REAL override id, not the
  // sentinel — the invariant the row-shaper must not contradict.
  const body = mapTxnToExpense(
    txn({ counterparty: "Widget Co", rawCategory: "software" }),
    mapping,
  );
  assertEquals(body.category_id, "cat-real-override");
  const { context, writes } = stubContext();
  await model.methods.upsertExpenses.execute(
    {
      txns: [txn({ counterparty: "Widget Co", rawCategory: "software" })],
      mapping,
      dryRun: true,
      _fetch: writeFetcher().f,
      // deno-lint-ignore no-explicit-any
    } as any,
    context,
  );
  const rows = writes.find((w) => w.spec === "expenseSync")!.data
    .rows as Array<Record<string, unknown>>;
  // The real tier-1 category bind resolved → no sentinel → NOT projected.
  assertEquals(rows[0].projectedCategory, null);
  assertEquals(rows[0].projectedVendor, null);
  assertEquals(rows[0].unmatchedVendor, false);
});

// DRP-04 — case-variant integration: the txn counterparty spelling differs in
// case from the sentinel-bound mapping key. projectedVendor must report the
// CANONICAL bound key ("Widget Co"), not the raw txn spelling ("WIDGET CO").
Deno.test("upsertExpenses (dryRun): a case-variant counterparty projects the canonical bound key, not the raw txn spelling (DRP-04)", async () => {
  const mapping: Mapping = {
    currencyId: "1",
    vendors: { "Widget Co": DRYRUN_SENTINEL }, // canonical spelling
    categories: {},
    fallbackCategoryId: "cat-fallback",
  };
  const { context, writes } = stubContext();
  await model.methods.upsertExpenses.execute(
    {
      txns: [txn({ counterparty: "WIDGET CO" })], // upper-case variant
      mapping,
      dryRun: true,
      _fetch: writeFetcher().f,
      // deno-lint-ignore no-explicit-any
    } as any,
    context,
  );
  const rows = writes.find((w) => w.spec === "expenseSync")!.data
    .rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].unmatchedVendor, false);
  assertEquals(rows[0].projectedVendor, "Widget Co"); // canonical key, not "WIDGET CO"
});

// DRP-05 — CATEGORY-side mirror of the "real existing beats same-name would-
// create" invariant: a real expenseCategory wins over a same-normalized-name
// categorySync would-create; buildMapping binds the REAL id, never the sentinel.
Deno.test("buildMapping (dryRun): a real existing category wins over a same-name would-create (real hashid, not sentinel) [DRP-05]", async () => {
  const { context, writes } = stubContextWithData({
    vendors: { items: [] },
    expenseCategories: {
      items: [
        { id: "c-util", name: "Utilities" },
        { id: "c-unc", name: "Uncategorized" },
      ],
    },
    categorySync: {
      // Case-variant would-create row for the SAME normalized category.
      rows: [{ name: "utilities", action: "would-create", categoryId: null }],
    },
  });
  await model.methods.buildMapping.execute(
    // deno-lint-ignore no-explicit-any
    { currencyId: "1", dryRun: true } as any,
    context,
  );
  const m = writes.find((w) => w.spec === "mapping")!.data;
  // Real "Utilities" id kept; no lowercase sentinel key added.
  assertEquals(m.categories, { Utilities: "c-util", Uncategorized: "c-unc" });
});

// DRP-06 — end-to-end DRP-01: a LIVE upsertExpenses fed a sentinel-contaminated
// mapping must THROW atomically (the pre-flight) BEFORE any POST, so a stale
// dry-run mapping never partially writes.
Deno.test("upsertExpenses (dryRun=false): a sentinel-contaminated mapping THROWS atomically before any POST (DRP-01/06)", async () => {
  const mapping: Mapping = {
    currencyId: "1",
    // One sentinel-bound vendor mixed with a legitimately-resolvable one — the
    // pre-flight must abort the WHOLE batch, not just the sentinel row.
    vendors: { AWS: "vend-aws", "Widget Co": DRYRUN_SENTINEL },
    categories: { software: "cat-sw" },
    fallbackCategoryId: "cat-fallback",
  };
  const { f, calls } = writeFetcher();
  const { context } = stubContext();
  await assertRejects(
    () =>
      model.methods.upsertExpenses.execute(
        {
          // The FIRST txn binds a real vendor and would POST live if the batch
          // weren't aborted up-front — proves the throw is atomic (pre-fan-out).
          txns: [
            txn({ counterparty: "AWS" }),
            txn({
              id: "txn-2",
              counterparty: "Widget Co",
            }),
          ],
          mapping,
          dryRun: false,
          _fetch: f,
          // deno-lint-ignore no-explicit-any
        } as any,
        context,
      ),
    Error,
    "dry-run sentinel",
  );
  assertEquals(postCount(calls), 0); // NOTHING written — atomic abort
});

// DRP-06 companion — the SAME contaminated mapping under dryRun:true still
// previews fine (sentinel is a legitimate projection there, not contamination).
Deno.test("upsertExpenses (dryRun=true): the same sentinel-bound mapping previews fine (no pre-flight throw) [DRP-06]", async () => {
  const mapping: Mapping = {
    currencyId: "1",
    vendors: { AWS: "vend-aws", "Widget Co": DRYRUN_SENTINEL },
    categories: { software: "cat-sw" },
    fallbackCategoryId: "cat-fallback",
  };
  const { context, writes } = stubContext();
  await model.methods.upsertExpenses.execute(
    {
      txns: [txn({ id: "txn-2", counterparty: "Widget Co" })],
      mapping,
      dryRun: true,
      _fetch: writeFetcher().f,
      // deno-lint-ignore no-explicit-any
    } as any,
    context,
  );
  const rows = writes.find((w) => w.spec === "expenseSync")!.data
    .rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(rows[0].projectedVendor, "Widget Co");
});

// Pure-helper coverage for the DRP-01 pre-flight predicate.
Deno.test("mappingHasSentinel: true iff any table value is the sentinel; own-values only (DRP-01)", () => {
  assertEquals(
    mappingHasSentinel({
      currencyId: "1",
      vendors: { AWS: "vend-aws" },
      categories: { software: "cat-sw" },
      fallbackCategoryId: "cat-fallback",
    }),
    false,
  );
  assertEquals(
    mappingHasSentinel({
      currencyId: "1",
      vendors: { "Widget Co": DRYRUN_SENTINEL },
      fallbackCategoryId: "cat-fallback",
    }),
    true,
  );
  // vendorCategories tier is also scanned.
  assertEquals(
    mappingHasSentinel({
      currencyId: "1",
      vendorCategories: { "Widget Co": DRYRUN_SENTINEL },
      fallbackCategoryId: "cat-fallback",
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Invoice-write path (design/invoiceninja-invoice-write.md) — injected fetch.
// Fixtures are generic/depersonalized: INV-* numbers, alphanumeric client ids.
// ---------------------------------------------------------------------------

/**
 * A fake {@link FetchLike} that serves BOTH the paginated dedup GET (on
 * `/invoices`) and the create POST. `existingByPage[i]` is the `data[]` for
 * `?page=i+1`; a POST returns `{data:{id}}` unless `throwPostWhenNumber` matches
 * the body's `number` (then HTTP 500 → inFetch throws).
 */
function invoiceFetcher(
  opts: {
    existingByPage?: Array<Array<Record<string, unknown>>>;
    createdId?: string;
    throwPostWhenNumber?: string;
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
        opts.throwPostWhenNumber && body.number === opts.throwPostWhenNumber
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
          Promise.resolve({ data: { id: opts.createdId ?? "inv-new" } }),
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

/** A canonical invoice input (total = 100 × 2 = 200), overridable. */
function inv(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: "INV-1001",
    clientId: "client1",
    date: "2026-01-31",
    status: "draft",
    lineItems: [{
      type: "service",
      notes: "Consulting",
      cost: 100,
      quantity: 2,
    }],
    ...over,
  };
}

/** Run the fan-out method and return the persisted invoiceSync/errors writes. */
async function runUpsertInvoices(
  invoices: Array<Record<string, unknown>>,
  f: FetchLike,
  dryRun: boolean,
) {
  const { context, writes } = stubContext();
  await model.methods.upsertInvoices.execute(
    // deno-lint-ignore no-explicit-any
    { invoices, dryRun, _fetch: f } as any,
    context,
  );
  const sync = writes.find((w) => w.spec === "invoiceSync")!;
  const errs = writes.find((w) => w.spec === "invoiceSyncErrors")!;
  return { sync, errs };
}

// (1) mapInvoiceToBody shape --------------------------------------------------
Deno.test("mapInvoiceToBody: type→type_id, status→status_id, carries number, never amount/send_email [INV-01]", () => {
  const body = mapInvoiceToBody(inv({
    status: "sent",
    lineItems: [
      { type: "product", notes: "Widget", cost: 10, quantity: 3 },
      { type: "service", notes: "Install", cost: 50 },
    ],
  }));
  assertEquals(body.client_id, "client1");
  assertEquals(body.number, "INV-1001");
  assertEquals(body.status_id, 2); // sent
  const items = body.line_items as Array<Record<string, unknown>>;
  assertEquals(items[0].type_id, 1); // product
  assertEquals(items[0].quantity, 3);
  assertEquals(items[1].type_id, 2); // service
  assertEquals(items[1].quantity, 1); // default
  assertEquals("amount" in body, false);
  assertEquals("send_email" in body, false);
});

Deno.test("mapInvoiceToBody: draft is the status_id default [INV-01b]", () => {
  assertEquals(mapInvoiceToBody(inv()).status_id, 1);
});

// (2) idempotency acceptance --------------------------------------------------
Deno.test("upsertInvoices: re-run over existing invoices yields all skip already-exists [INV-02]", async () => {
  const { f, calls } = invoiceFetcher({
    existingByPage: [[{ id: "inv-x", number: "INV-1001", amount: 200 }]],
  });
  const { sync } = await runUpsertInvoices([inv()], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "already-exists");
  assertEquals(rows[0].invoiceId, "inv-x");
  assertEquals(postCount(calls), 0);
});

// (3) dry-run -----------------------------------------------------------------
Deno.test("upsertInvoices: dry-run yields would-create and NO POST [INV-03]", async () => {
  const { f, calls } = invoiceFetcher();
  const { sync } = await runUpsertInvoices([inv()], f, true);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(sync.data.dryRun, true);
  assertEquals(postCount(calls), 0);
});

// (4) substring false-positive guard ------------------------------------------
Deno.test("upsertInvoice: a substring-only number match is NOT treated as existing [INV-04]", async () => {
  const { f, calls } = invoiceFetcher({
    existingByPage: [[{ id: "inv-x", number: "INV-10010", amount: 200 }]],
    createdId: "inv-new",
  });
  const r = await upsertInvoice(CFG, inv(), false, f);
  assertEquals(r.action, "created");
  assertEquals(postCount(calls), 1);
});

// (5) paginated dedup ---------------------------------------------------------
Deno.test("upsertInvoice: an exact number match on page 2 IS found [INV-05]", async () => {
  const { f, calls } = invoiceFetcher({
    existingByPage: [
      [{ id: "other", number: "INV-2002", amount: 5 }],
      [{ id: "inv-hit", number: "INV-1001", amount: 200 }],
    ],
  });
  const r = await upsertInvoice(CFG, inv(), false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "already-exists");
  assertEquals(r.invoiceId, "inv-hit");
  assertEquals(postCount(calls), 0);
  assertEquals(calls.length, 2); // scanned both pages
});

// (6) in-batch duplicate number -----------------------------------------------
Deno.test("upsertInvoices: a duplicate number in the batch creates ONCE, marks the second [INV-06]", async () => {
  const { f, calls } = invoiceFetcher({ createdId: "inv-new" });
  const { sync } = await runUpsertInvoices([inv(), inv()], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "created");
  assertEquals(rows[1].action, "skip");
  assertEquals(rows[1].reason, "in-batch-duplicate");
  assertEquals(postCount(calls), 1);
});

Deno.test("upsertInvoices: in-batch duplicate holds in dry-run [INV-06b]", async () => {
  const { f, calls } = invoiceFetcher();
  const { sync } = await runUpsertInvoices([inv(), inv()], f, true);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(rows[1].action, "skip");
  assertEquals(rows[1].reason, "in-batch-duplicate");
  assertEquals(postCount(calls), 0);
});

// (7) mid-batch failure -------------------------------------------------------
Deno.test("upsertInvoices: a mid-batch POST failure still flushes both resources [INV-07]", async () => {
  const invA = inv({ number: "INV-A" });
  const invB = inv({ number: "INV-B" });
  const invC = inv({ number: "INV-C" });
  const { f } = invoiceFetcher({
    throwPostWhenNumber: "INV-B",
    createdId: "inv-ok",
  });
  const { sync, errs } = await runUpsertInvoices([invA, invB, invC], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // A and C created; B threw → no sync row, only an error row.
  assertEquals(rows.map((r) => r.dedupKey), ["INV-A", "INV-C"]);
  assertEquals(rows[0].action, "created");
  const eRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(eRows.length, 1);
  assertEquals(eRows[0].dedupKey, "INV-B");
  assertEquals(String(eRows[0].error).includes("HTTP 500"), true);
});

// (8) blank number ------------------------------------------------------------
Deno.test("upsertInvoices: a blank number is a skip + surfaced error, NO ?filter= call [INV-08]", async () => {
  const { f, calls } = invoiceFetcher();
  const { sync, errs } = await runUpsertInvoices(
    [inv({ number: "" })],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "blank-dedup-key");
  const eRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(eRows[0].error, "blank-dedup-key");
  assertEquals(calls.length, 0); // never hit the wire with an empty filter
});

// (9) invalid input -----------------------------------------------------------
Deno.test("upsertInvoices: missing clientId / no line items / non-finite cost → skip invalid, NO POST [INV-09]", async () => {
  const { f: f1, calls: c1 } = invoiceFetcher();
  const { sync: s1 } = await runUpsertInvoices(
    [inv({ clientId: "" })],
    f1,
    false,
  );
  assertEquals(
    (s1.data.rows as Array<Record<string, unknown>>)[0].reason,
    "invalid",
  );
  assertEquals(postCount(c1), 0);

  const { f: f2, calls: c2 } = invoiceFetcher();
  const { sync: s2 } = await runUpsertInvoices(
    [inv({ lineItems: [] })],
    f2,
    false,
  );
  assertEquals(
    (s2.data.rows as Array<Record<string, unknown>>)[0].reason,
    "invalid",
  );
  assertEquals(postCount(c2), 0);

  const { f: f3, calls: c3 } = invoiceFetcher();
  const { sync: s3 } = await runUpsertInvoices(
    [inv({
      lineItems: [{ type: "service", notes: "x", cost: "not-a-number" }],
    })],
    f3,
    false,
  );
  assertEquals(
    (s3.data.rows as Array<Record<string, unknown>>)[0].reason,
    "invalid",
  );
  assertEquals(postCount(c3), 0);
});

// (10) real create ------------------------------------------------------------
Deno.test("upsertInvoice: real create POSTs /invoices with mandatory headers, returns id [INV-10]", async () => {
  const { f, calls } = invoiceFetcher({ createdId: "inv-777" });
  const r = await upsertInvoice(CFG, inv(), false, f);
  assertEquals(r.action, "created");
  assertEquals(r.invoiceId, "inv-777");
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.url.includes("/invoices"), true);
  assertEquals(post.headers?.["X-API-TOKEN"], "SEKRIT");
  assertEquals(post.headers?.["X-Requested-With"], "XMLHttpRequest");
  assertEquals(post.headers?.["Content-Type"], "application/json");
  assertEquals(
    (JSON.parse(post.body!) as Record<string, unknown>).number,
    "INV-1001",
  );
});

// (11) status 'sent' never emails ---------------------------------------------
Deno.test("upsertInvoice: status 'sent' sets status_id=2 but hits NO email/send endpoint [INV-11]", async () => {
  const { f, calls } = invoiceFetcher({ createdId: "inv-9" });
  const r = await upsertInvoice(CFG, inv({ status: "sent" }), false, f);
  assertEquals(r.action, "created");
  const post = calls.find((c) => c.method === "POST")!;
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assertEquals(body.status_id, 2);
  assertEquals("send_email" in body, false);
  assertEquals(
    calls.some((c) => c.url.includes("/email") || c.url.includes("send_email")),
    false,
  );
  assertEquals(calls.length, 2); // dedup GET + create POST only
});

// (12) snapshot shape + always-flush ------------------------------------------
Deno.test("upsertInvoices: flushes invoiceSync shape + invoiceSyncErrors even with 0 errors [INV-12]", async () => {
  const { f } = invoiceFetcher({ createdId: "inv-1" });
  const { sync, errs } = await runUpsertInvoices([inv()], f, false);
  assertEquals(sync.spec, "invoiceSync");
  assertEquals(sync.data.dryRun, false);
  assertEquals(typeof sync.data.retrievedAt, "string");
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].dedupKey, "INV-1001");
  assertEquals(rows[0].total, 200);
  assertEquals(rows[0].status, "draft");
  assertEquals(errs.spec, "invoiceSyncErrors");
  assertEquals((errs.data.rows as unknown[]).length, 0);
  assertEquals(typeof errs.data.retrievedAt, "string");
});

Deno.test("upsertInvoices: syncScope names the per-scope resources [INV-12b]", async () => {
  const { f } = invoiceFetcher({ createdId: "inv-1" });
  const { context, writes } = stubContext();
  await model.methods.upsertInvoices.execute(
    // deno-lint-ignore no-explicit-any
    {
      invoices: [inv()],
      dryRun: false,
      syncScope: "backfill",
      _fetch: f,
    } as any,
    context,
  );
  assertEquals(
    writes.find((w) => w.spec === "invoiceSync")!.name,
    "invoiceSync--backfill",
  );
  assertEquals(
    writes.find((w) => w.spec === "invoiceSyncErrors")!.name,
    "invoiceSyncErrors--backfill",
  );
});

// (13) exists-amount-mismatch -------------------------------------------------
Deno.test("upsertInvoice: an exact number match with a different total flags exists-amount-mismatch [INV-13]", async () => {
  const { f } = invoiceFetcher({
    existingByPage: [[{ id: "inv-x", number: "INV-1001", amount: 999 }]],
  });
  const r = await upsertInvoice(CFG, inv(), false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "exists-amount-mismatch");
  assertEquals(r.invoiceId, "inv-x");
});

// (14) hardening: prototype-chain type + bad quantity/number/total ------------
Deno.test("upsertInvoices: a prototype-chain line type (constructor/__proto__) is invalid, NO POST [INV-14]", async () => {
  for (const badType of ["constructor", "__proto__", "toString"]) {
    const { f, calls } = invoiceFetcher();
    const { sync } = await runUpsertInvoices(
      [inv({ lineItems: [{ type: badType, notes: "x", cost: 10 }] })],
      f,
      false,
    );
    assertEquals(
      (sync.data.rows as Array<Record<string, unknown>>)[0].reason,
      "invalid",
    );
    assertEquals(postCount(calls), 0);
  }
});

Deno.test("upsertInvoices: a non-positive or non-finite quantity is invalid, NO POST [INV-15]", async () => {
  for (const q of [0, -1, "not-a-number"]) {
    const { f, calls } = invoiceFetcher();
    const { sync } = await runUpsertInvoices(
      [inv({
        lineItems: [{ type: "product", notes: "x", cost: 10, quantity: q }],
      })],
      f,
      false,
    );
    assertEquals(
      (sync.data.rows as Array<Record<string, unknown>>)[0].reason,
      "invalid",
    );
    assertEquals(postCount(calls), 0);
  }
});

Deno.test("upsertInvoices: a whitespace-only number is treated as blank, NO ?filter= call [INV-16]", async () => {
  const { f, calls } = invoiceFetcher();
  const { sync, errs } = await runUpsertInvoices(
    [inv({ number: "   " })],
    f,
    false,
  );
  assertEquals(
    (sync.data.rows as Array<Record<string, unknown>>)[0].reason,
    "blank-dedup-key",
  );
  assertEquals(
    (errs.data.rows as Array<Record<string, unknown>>)[0].error,
    "blank-dedup-key",
  );
  assertEquals(calls.length, 0);
});

Deno.test("upsertInvoices: an overflowing (non-finite) total is invalid, NO POST [INV-17]", async () => {
  const { f, calls } = invoiceFetcher();
  const { sync } = await runUpsertInvoices(
    [inv({
      lineItems: [{ type: "product", notes: "x", cost: 1e308, quantity: 1e10 }],
    })],
    f,
    false,
  );
  assertEquals(
    (sync.data.rows as Array<Record<string, unknown>>)[0].reason,
    "invalid",
  );
  assertEquals(postCount(calls), 0);
});

Deno.test("mapInvoiceToBody: a negative-cost (discount) line is allowed and carried [INV-18]", () => {
  const body = mapInvoiceToBody(inv({
    lineItems: [
      { type: "service", notes: "Work", cost: 100, quantity: 1 },
      { type: "product", notes: "Loyalty discount", cost: -20, quantity: 1 },
    ],
  }));
  const items = body.line_items as Array<Record<string, unknown>>;
  assertEquals(items.length, 2);
  assertEquals(items[1].cost, -20);
});

// ===========================================================================
// Clients surface (design/invoiceninja-entity-crud.md §1). Read = by-id batch
// fan-out into a short-lived PII snapshot; write = gated check-then-create
// dedup'd on the client `number`. Injected FetchLike, bugzilla pattern.
// ===========================================================================

/** Resolved config carrying a non-default clientSnapshotLifetime for §1 tests. */
const CLIENT_CFG = {
  baseUrl: "https://clients.example.com/api/v1",
  apiToken: "SEKRIT",
  perPage: 100,
  withTrashed: false,
  dryRun: true,
  clientSnapshotLifetime: "24h",
} as unknown as Cfg;

/** A raw `/clients/{id}` API record (with include=contacts), overridable. */
function rawClient(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "cl1",
    number: "CUST-001",
    name: "Fakecorp Industries",
    balance: "125.50",
    paid_to_date: "300.00",
    is_deleted: false,
    archived_at: 0,
    contacts: [
      {
        id: "ct-1",
        first_name: "Ada",
        last_name: "Ledger",
        email: "ada@fakecorp.example",
      },
    ],
    ...over,
  };
}

/**
 * A fake {@link FetchLike} serving GET /clients/{id}?include=contacts. `byId`
 * maps a hashid to its raw record; an id in `failId` returns HTTP 404 (→ inFetch
 * throws). Records url + headers so tests can assert the include + that a bad id
 * never reached the wire.
 */
function clientGetFetcher(
  byId: Record<string, Record<string, unknown>>,
  opts: { failId?: string } = {},
): { f: FetchLike; calls: WFetchRec[] } {
  const calls: WFetchRec[] = [];
  const f: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const m = new URL(url).pathname.match(/\/clients\/([^/]+)$/);
    const id = m ? m[1] : "";
    if (opts.failId && id === opts.failId) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () => Promise.resolve({}),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ data: byId[id] ?? { id, number: id } }),
    });
  };
  return { f, calls };
}

/** A canonical client input (§1 ClientInput), overridable. */
function cli(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: "CUST-001",
    name: "Fakecorp Industries",
    ...over,
  };
}

/** Run upsertClients and return the persisted clientSync/errors writes. */
async function runUpsertClients(
  clients: Array<Record<string, unknown>>,
  f: FetchLike,
  dryRun: boolean,
) {
  const { context, writes } = stubContext();
  await model.methods.upsertClients.execute(
    // deno-lint-ignore no-explicit-any
    { clients, dryRun, _fetch: f } as any,
    context,
  );
  const sync = writes.find((w) => w.spec === "clientSync")!;
  const errs = writes.find((w) => w.spec === "clientSyncErrors")!;
  return { sync, errs };
}

// (1) isValidHashid ----------------------------------------------------------
Deno.test("isValidHashid: accepts an IN hashid, rejects path/empty [CLI-01]", () => {
  assertEquals(isValidHashid("Wpmbk5ezJn"), true);
  assertEquals(isValidHashid("../../users/5"), false);
  assertEquals(isValidHashid("1/2"), false);
  assertEquals(isValidHashid("a.b"), false);
  assertEquals(isValidHashid(""), false);
});

// (2) normalizeClient / normalizeClientContact ------------------------------
Deno.test("normalizeClient: maps fields, flattens contacts, 0 archived_at → null [CLI-02]", () => {
  const c = normalizeClient(rawClient());
  assertEquals(c.id, "cl1");
  assertEquals(c.number, "CUST-001");
  assertEquals(c.name, "Fakecorp Industries");
  assertEquals(c.balance, 125.5);
  assertEquals(c.paidToDate, 300);
  assertEquals(c.isDeleted, false);
  assertEquals(c.archivedAt, null); // 0 → null
  assertEquals(c.contacts.length, 1);
  assertEquals(c.contacts[0], {
    id: "ct-1",
    firstName: "Ada",
    lastName: "Ledger",
    email: "ada@fakecorp.example",
  });
});

Deno.test("normalizeClient: a missing/non-array contacts becomes [] [CLI-02b]", () => {
  assertEquals(
    normalizeClient(rawClient({ contacts: undefined })).contacts,
    [],
  );
  assertEquals(normalizeClient(rawClient({ contacts: "nope" })).contacts, []);
  // A real positive archived_at is preserved.
  assertEquals(
    normalizeClient(rawClient({ archived_at: 1720000000 })).archivedAt,
    1720000000,
  );
});

Deno.test("normalizeClientContact: snake→camel, blanks → null [CLI-02c]", () => {
  assertEquals(
    normalizeClientContact({ id: "ct-9", first_name: "", email: "x@y.z" }),
    { id: "ct-9", firstName: null, lastName: null, email: "x@y.z" },
  );
});

// (3) getClients read fan-out ------------------------------------------------
Deno.test("getClients: fetches each id with include=contacts, snapshots normalized rows + lifetime override [CLI-03]", async () => {
  const { f, calls } = clientGetFetcher({
    "cl1": rawClient(),
    "cl2": rawClient({ id: "cl2", number: "CUST-002", name: "Beta LLC" }),
  });
  const { context, writes } = stubContext(CLIENT_CFG);
  await model.methods.getClients.execute(
    // deno-lint-ignore no-explicit-any
    { ids: ["cl1", "cl2"], _fetch: f } as any,
    context,
  );
  const snap = writes.find((w) => w.spec === "clients")!;
  assertEquals(snap.name, "clients");
  assertEquals(snap.data.count, 2);
  const items = snap.data.items as Array<Record<string, unknown>>;
  assertEquals(items.map((i) => i.number), ["CUST-001", "CUST-002"]);
  assertEquals((snap.data.errors as unknown[]).length, 0);
  // lifetime override flows from cfg.clientSnapshotLifetime.
  assertEquals(snap.overrides?.lifetime, "24h");
  // include=contacts requested on every id.
  assertEquals(calls.length, 2);
  assertEquals(calls[0].url.includes("include=contacts"), true);
  assertEquals(calls[0].url.includes("/clients/cl1"), true);
});

Deno.test("getClients: scope arg writes clients--<scope> instance name [SCOPE-CLI]", async () => {
  const { f } = clientGetFetcher({ "cl1": rawClient() });
  const { context, writes } = stubContext(CLIENT_CFG);
  await model.methods.getClients.execute(
    // deno-lint-ignore no-explicit-any
    { ids: ["cl1"], scope: "snapshot-apply", _fetch: f } as any,
    context,
  );
  const snap = writes.find((w) => w.spec === "clients")!;
  assertEquals(snap.name, "clients--snapshot-apply");
  // Envelope `scope` field tracks the instance name for round-trip clarity.
  assertEquals(snap.data.scope, "clients--snapshot-apply");
});

Deno.test("getClients: a blank/invalid id is skipped + surfaced, NEVER hits the wire [CLI-04]", async () => {
  const { f, calls } = clientGetFetcher({ "cl1": rawClient() });
  const { context, writes } = stubContext(CLIENT_CFG);
  await model.methods.getClients.execute(
    // deno-lint-ignore no-explicit-any
    { ids: ["../../users/5", "", "cl1"], _fetch: f } as any,
    context,
  );
  const snap = writes.find((w) => w.spec === "clients")!;
  const errors = snap.data.errors as Array<Record<string, unknown>>;
  assertEquals((snap.data.items as unknown[]).length, 1); // only cl1 fetched
  assertEquals(errors.length, 2);
  assertEquals(errors.every((e) => e.error === "invalid-id"), true);
  // Exactly one wire call — the two bad ids never reached the path.
  assertEquals(calls.length, 1);
  assertEquals(
    calls.some((c) => c.url.includes("users") || c.url.includes("..")),
    false,
  );
});

Deno.test("getClients: a per-id fetch failure surfaces an error but the batch continues [CLI-05]", async () => {
  const { f } = clientGetFetcher(
    { "cl1": rawClient(), "cl2": rawClient({ id: "cl2", number: "C2" }) },
    { failId: "cl1" },
  );
  const { context, writes } = stubContext(CLIENT_CFG);
  await model.methods.getClients.execute(
    // deno-lint-ignore no-explicit-any
    { ids: ["cl1", "cl2"], _fetch: f } as any,
    context,
  );
  const snap = writes.find((w) => w.spec === "clients")!;
  const items = snap.data.items as Array<Record<string, unknown>>;
  const errors = snap.data.errors as Array<Record<string, unknown>>;
  assertEquals(items.map((i) => i.id), ["cl2"]); // cl2 still fetched
  assertEquals(errors.length, 1);
  assertEquals(errors[0].id, "cl1");
  assertEquals(String(errors[0].error).includes("HTTP 404"), true);
});

Deno.test("getClients: the `clients` resource is short-lived + single-version + schema-valid [CLI-06]", () => {
  const spec = model.resources.clients;
  assertEquals(spec.lifetime, "1h"); // short default
  assertEquals(spec.garbageCollection, 1); // no PII history
  // A normalized snapshot parses against the declared schema.
  const parsed = spec.schema.safeParse({
    scope: "clients",
    count: 1,
    items: [normalizeClient(rawClient())],
    errors: [{ id: "bad", error: "invalid-id" }],
    retrievedAt: new Date().toISOString(),
  });
  assertEquals(parsed.success, true);
});

// (3b) listClients — lean discovery surface: id/number/name only, no PII ------
Deno.test("normalizeClientLean: keeps only id/number/name, drops all PII [CLI-19]", () => {
  const lean = normalizeClientLean({
    id: "cl9",
    number: "CUST-009",
    name: "Fakecorp Industries",
    phone: "555-0100",
    address1: "1 Main St",
    id_number: "TAX-123",
    contacts: [{ email: "ada@fakecorp.example" }],
  });
  assertEquals(lean, {
    id: "cl9",
    number: "CUST-009",
    name: "Fakecorp Industries",
  });
  // No PII key survives into the lean row.
  assertEquals(Object.keys(lean).sort(), ["id", "name", "number"]);
});

Deno.test("listClients: paginates WITHOUT include=contacts, stores lean rows + lifetime override [CLI-20]", async () => {
  const { f, calls } = pagedFetcher([
    [{
      id: "cl1",
      number: "CUST-001",
      name: "Fakecorp Industries",
      id_number: "TAX-1",
      contacts: [{ email: "ada@fakecorp.example" }],
    }],
    [{ id: "cl2", number: "CUST-002", name: "Beta LLC", phone: "555" }],
  ]);
  const { context, writes } = stubContext(CLIENT_CFG);
  await model.methods.listClients.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  const snap = writes.find((w) => w.spec === "clientList")!;
  assertEquals(snap.name, "clients-list");
  assertEquals(snap.data.count, 2);
  const items = snap.data.items as Array<Record<string, unknown>>;
  assertEquals(items.map((i) => i.id), ["cl1", "cl2"]);
  // Only id/number/name stored — no PII on any row.
  for (const it of items) {
    assertEquals(Object.keys(it).sort(), ["id", "name", "number"]);
  }
  // lifetime override flows from cfg.clientSnapshotLifetime.
  assertEquals(snap.overrides?.lifetime, "24h");
  // NEVER requests contacts — that would pull email PII over the wire.
  assertEquals(calls.every((c) => !c.url.includes("include=contacts")), true);
  assertEquals(calls.every((c) => c.url.includes("/clients")), true);
});

Deno.test("listClients: filter lands ONLY in the query, NEVER the resource name (CLI-SEC-1) [CLI-21]", async () => {
  const { f, calls } = pagedFetcher([[]]);
  const { context, writes } = stubContext(CLIENT_CFG);
  await model.methods.listClients.execute(
    // deno-lint-ignore no-explicit-any
    { filter: "jane.doe@example.com", _fetch: f } as any,
    context,
  );
  // CLI-SEC-1: a (potentially PII) filter term must NOT leak into the durable
  // resource key — the name is a constant regardless of filter.
  assertEquals(writes[0].name, "clients-list");
  assertEquals(writes[0].name.includes("jane.doe"), false);
  // ...but it still drives the (transient) query.
  assertEquals(calls[0].url.includes("filter="), true);
});

Deno.test("listClients: the `clientList` resource is short-lived + single-version [CLI-22]", () => {
  const spec = model.resources.clientList;
  assertEquals(spec.lifetime, "1h"); // short default
  assertEquals(spec.garbageCollection, 1); // no client-name history
  const parsed = spec.schema.safeParse({
    scope: "clients-list",
    count: 1,
    items: [normalizeClientLean({ id: "cl1", number: "C1", name: "X" })],
    retrievedAt: new Date().toISOString(),
  });
  assertEquals(parsed.success, true);
});

// (3b) clientDomains — §7 lead-spam allowlist source (DOMAIN-only) -----------
Deno.test("emailDomainOf: returns the lowercased domain, NEVER the local part [CLI-30]", () => {
  assertEquals(emailDomainOf("Ada@Fakecorp.EXAMPLE"), "fakecorp.example");
  assertEquals(emailDomainOf("a@sub.acme.co.uk"), "sub.acme.co.uk");
  // Rejected: no local part, no domain, no dot, embedded whitespace, blank/null.
  assertEquals(emailDomainOf("@acme.com"), null);
  assertEquals(emailDomainOf("ada@"), null);
  assertEquals(emailDomainOf("ada"), null);
  assertEquals(emailDomainOf("ada@localhost"), null);
  assertEquals(emailDomainOf("a b@acme.com"), null);
  assertEquals(emailDomainOf(null), null);
  assertEquals(emailDomainOf("   "), null);
  // DOM-1: a multi-@ value must NOT resolve to the trailing domain (allowlist
  // poisoning) — exactly one @ is required.
  assertEquals(emailDomainOf("victim@real.com@attacker.com"), null);
});

Deno.test("collectClientDomains: dedupes + sorts, drops invalids, free-mail INCLUDED, no local part [CLI-31]", () => {
  const domains = collectClientDomains([
    { contacts: [{ email: "a@Acme.com" }, { email: "b@acme.com" }] },
    { contacts: [{ email: "c@gmail.com" }, { email: "bogus" }, { email: null }] },
    { contacts: [] },
  ]);
  // One acme.com (deduped, case-folded), free-mail kept (consumer filters), sorted.
  assertEquals(domains, ["acme.com", "gmail.com"]);
  const blob = JSON.stringify(domains);
  assertEquals(blob.includes("@"), false);
  assertEquals(blob.includes("bogus"), false);
});

Deno.test("clientDomains: snapshots ONLY domains — no address/local part reaches the resource [CLI-32]", async () => {
  const { f, calls } = pagedFetcher([[
    rawClient(), // contact ada@fakecorp.example
    rawClient({
      id: "cl2",
      number: "CUST-002",
      name: "Beta LLC",
      contacts: [
        { id: "ct-2", first_name: "Bo", last_name: "B", email: "bo@beta.io" },
        { id: "ct-3", first_name: "X", last_name: "Y", email: "x@fakecorp.example" },
      ],
    }),
  ]]);
  const { context, writes, infos } = stubContext(CLIENT_CFG);
  await model.methods.clientDomains.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  const snap = writes.find((w) => w.spec === "clientDomains")!;
  assertEquals(snap.name, "client-domains");
  // Deduped across clients + contacts, sorted; domain-only.
  assertEquals(snap.data.domains, ["beta.io", "fakecorp.example"]);
  assertEquals(snap.data.count, 2);
  // PII GUARD: the full serialized snapshot carries NO local part / address.
  const blob = JSON.stringify(snap.data);
  assertEquals(blob.includes("ada"), false);
  assertEquals(blob.includes("bo@"), false);
  assertEquals(blob.includes("@fakecorp"), false);
  // TEST-1: the logger carries the COUNT only — never a domain, email, or
  // local part. Guards against a debug regression leaking PII to logs.
  const logBlob = JSON.stringify(infos);
  assertEquals(logBlob.includes("@"), false);
  assertEquals(logBlob.includes("beta.io"), false);
  assertEquals(logBlob.includes("fakecorp"), false);
  assertEquals(infos.some((i) => i.data?.count === 2), true);
  // lifetime override flows from cfg.clientSnapshotLifetime.
  assertEquals(snap.overrides?.lifetime, "24h");
  // include=contacts IS requested (emails read transiently, reduced to domains).
  assertEquals(calls[0].url.includes("include=contacts"), true);
});

Deno.test("clientDomains: the `clientDomains` resource is short-lived, single-version, schema-valid [CLI-33]", () => {
  const spec = model.resources.clientDomains;
  assertEquals(spec.lifetime, "1h");
  assertEquals(spec.garbageCollection, 1);
  const parsed = spec.schema.safeParse({
    scope: "client-domains",
    count: 1,
    domains: ["acme.com"],
    retrievedAt: new Date().toISOString(),
  });
  assertEquals(parsed.success, true);
});

// (4) mapClientToBody --------------------------------------------------------
Deno.test("mapClientToBody: carries number + optional fields, snake_case contacts, NEVER balances [CLI-07]", () => {
  const body = mapClientToBody(cli({
    idNumber: "EIN-99",
    publicNotes: "net-30",
    privateNotes: "priority",
    contacts: [{ firstName: "Ada", lastName: "Ledger", email: "ada@x.z" }],
  }));
  assertEquals(body.number, "CUST-001");
  assertEquals(body.name, "Fakecorp Industries");
  assertEquals(body.id_number, "EIN-99");
  assertEquals(body.public_notes, "net-30");
  assertEquals(body.private_notes, "priority");
  const contacts = body.contacts as Array<Record<string, unknown>>;
  assertEquals(contacts[0], {
    first_name: "Ada",
    last_name: "Ledger",
    email: "ada@x.z",
  });
  // IN derives balances — the body must never set them.
  assertEquals("balance" in body, false);
  assertEquals("paid_to_date" in body, false);
});

Deno.test("mapClientToBody: omits blank optionals + drops all-blank contacts [CLI-07b]", () => {
  const body = mapClientToBody(
    cli({ idNumber: "", contacts: [{}, { email: "" }] }),
  );
  assertEquals("id_number" in body, false);
  assertEquals("contacts" in body, false); // no createable contact
  // Absent contacts also omit the key entirely.
  assertEquals("contacts" in mapClientToBody(cli()), false);
});

// (5) upsertClients idempotency ----------------------------------------------
Deno.test("upsertClients: re-run over an existing number yields skip already-exists, NO POST [CLI-08]", async () => {
  const { f, calls } = invoiceFetcher({
    existingByPage: [[{ id: "cl-x", number: "CUST-001" }]],
  });
  const { sync } = await runUpsertClients([cli()], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "already-exists");
  assertEquals(rows[0].clientId, "cl-x");
  assertEquals(postCount(calls), 0);
});

// (6) dry-run ----------------------------------------------------------------
Deno.test("upsertClients: dry-run yields would-create and NO POST [CLI-09]", async () => {
  const { f, calls } = invoiceFetcher();
  const { sync } = await runUpsertClients([cli()], f, true);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(sync.data.dryRun, true);
  assertEquals(postCount(calls), 0);
});

// (7) substring false-positive guard -----------------------------------------
Deno.test("upsertClient: a substring-only number match is NOT treated as existing [CLI-10]", async () => {
  const { f, calls } = invoiceFetcher({
    existingByPage: [[{ id: "cl-x", number: "CUST-0010" }]],
    createdId: "cl-new",
  });
  const r = await upsertClient(CFG, cli(), false, f);
  assertEquals(r.action, "created");
  assertEquals(r.clientId, "cl-new");
  assertEquals(postCount(calls), 1);
});

// (8) paginated dedup --------------------------------------------------------
Deno.test("upsertClient: an exact number match on page 2 IS found [CLI-11]", async () => {
  const { f, calls } = invoiceFetcher({
    existingByPage: [
      [{ id: "other", number: "CUST-777" }],
      [{ id: "cl-hit", number: "CUST-001" }],
    ],
  });
  const r = await upsertClient(CFG, cli(), false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "already-exists");
  assertEquals(r.clientId, "cl-hit");
  assertEquals(postCount(calls), 0);
  assertEquals(calls.length, 2); // scanned both pages
});

// (9) in-batch duplicate -----------------------------------------------------
Deno.test("upsertClients: a duplicate number in the batch creates ONCE, marks the second [CLI-12]", async () => {
  const { f, calls } = invoiceFetcher({ createdId: "cl-new" });
  const { sync } = await runUpsertClients([cli(), cli()], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "created");
  assertEquals(rows[1].action, "skip");
  assertEquals(rows[1].reason, "in-batch-duplicate");
  assertEquals(postCount(calls), 1);
});

// (10) mid-batch failure -----------------------------------------------------
Deno.test("upsertClients: a mid-batch POST failure still flushes both resources [CLI-13]", async () => {
  const a = cli({ number: "C-A" });
  const b = cli({ number: "C-B" });
  const c = cli({ number: "C-C" });
  const { f } = invoiceFetcher({
    throwPostWhenNumber: "C-B",
    createdId: "cl-ok",
  });
  const { sync, errs } = await runUpsertClients([a, b, c], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // A and C created; B threw → no sync row, only an error row.
  assertEquals(rows.map((r) => r.dedupKey), ["C-A", "C-C"]);
  assertEquals(rows[0].action, "created");
  const eRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(eRows.length, 1);
  assertEquals(eRows[0].dedupKey, "C-B");
  assertEquals(String(eRows[0].error).includes("HTTP 500"), true);
});

// (11) blank number ----------------------------------------------------------
Deno.test("upsertClients: a blank number is a skip + surfaced error, NO ?filter= call [CLI-14]", async () => {
  const { f, calls } = invoiceFetcher();
  const { sync, errs } = await runUpsertClients(
    [cli({ number: "  " })],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "blank-dedup-key");
  const eRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(eRows[0].error, "blank-dedup-key");
  assertEquals(calls.length, 0); // never hit the wire with an empty filter
});

// (12) invalid input (missing name) ------------------------------------------
Deno.test("upsertClients: a missing/blank name → skip invalid, NO POST + surfaced error [CLI-15]", async () => {
  const { f, calls } = invoiceFetcher();
  const { sync, errs } = await runUpsertClients([cli({ name: "" })], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "invalid");
  assertEquals(postCount(calls), 0);
  const eRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(eRows[0].error, "invalid");
});

// (13) real create -----------------------------------------------------------
Deno.test("upsertClient: real create POSTs /clients with mandatory headers, returns id, no balances [CLI-16]", async () => {
  const { f, calls } = invoiceFetcher({ createdId: "cl-777" });
  const r = await upsertClient(CFG, cli(), false, f);
  assertEquals(r.action, "created");
  assertEquals(r.clientId, "cl-777");
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.url.includes("/clients"), true);
  assertEquals(post.headers?.["X-API-TOKEN"], "SEKRIT");
  assertEquals(post.headers?.["X-Requested-With"], "XMLHttpRequest");
  assertEquals(post.headers?.["Content-Type"], "application/json");
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assertEquals(body.number, "CUST-001");
  assertEquals("balance" in body, false);
  assertEquals("paid_to_date" in body, false);
});

// (14) always-flush shape ----------------------------------------------------
Deno.test("upsertClients: flushes clientSync shape + clientSyncErrors even with 0 errors [CLI-17]", async () => {
  const { f } = invoiceFetcher({ createdId: "cl-1" });
  const { sync, errs } = await runUpsertClients([cli()], f, false);
  assertEquals(sync.spec, "clientSync");
  assertEquals(sync.data.dryRun, false);
  assertEquals(typeof sync.data.retrievedAt, "string");
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].dedupKey, "CUST-001");
  assertEquals(rows[0].clientId, "cl-1");
  // PII-free audit — the client name is NEVER carried on the sync row.
  assertEquals("name" in rows[0], false);
  assertEquals(errs.spec, "clientSyncErrors");
  assertEquals((errs.data.rows as unknown[]).length, 0);
  assertEquals(typeof errs.data.retrievedAt, "string");
});

// (15) syncScope names the per-scope resources -------------------------------
Deno.test("upsertClients: syncScope names the per-scope resources [CLI-18]", async () => {
  const { f } = invoiceFetcher({ createdId: "cl-1" });
  const { context, writes } = stubContext();
  await model.methods.upsertClients.execute(
    // deno-lint-ignore no-explicit-any
    {
      clients: [cli()],
      dryRun: false,
      syncScope: "backfill",
      _fetch: f,
    } as any,
    context,
  );
  assertEquals(
    writes.find((w) => w.spec === "clientSync")!.name,
    "clientSync--backfill",
  );
  assertEquals(
    writes.find((w) => w.spec === "clientSyncErrors")!.name,
    "clientSyncErrors--backfill",
  );
});

// ---------------------------------------------------------------------------
// Projects surface (design/invoiceninja-entity-crud.md §2) — injected fetch.
// Fixtures are generic/depersonalized: PRJ-* numbers, alphanumeric client ids,
// fakecorp-style names.
// ---------------------------------------------------------------------------

/**
 * A fake {@link FetchLike} that serves BOTH the paginated dedup GET (on
 * `/projects`) and the create POST. `existingByPage[i]` is the `data[]` for
 * `?page=i+1`; a POST returns `{data:{id}}` unless `throwPostWhenNumber` matches
 * the body's `number` (then HTTP 500 → inFetch throws).
 */
function projectFetcher(
  opts: {
    existingByPage?: Array<Array<Record<string, unknown>>>;
    createdId?: string;
    throwPostWhenNumber?: string;
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
        opts.throwPostWhenNumber && body.number === opts.throwPostWhenNumber
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
          Promise.resolve({ data: { id: opts.createdId ?? "prj-new" } }),
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

/** A canonical project input, overridable. */
function proj(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: "PRJ-1001",
    name: "Website Rebuild",
    clientId: "client1",
    ...over,
  };
}

/** Run the fan-out method and return the persisted projectSync/errors writes. */
async function runUpsertProjects(
  projects: Array<Record<string, unknown>>,
  f: FetchLike,
  dryRun: boolean,
  syncScope?: string,
) {
  const { context, writes } = stubContext();
  await model.methods.upsertProjects.execute(
    // deno-lint-ignore no-explicit-any
    { projects, dryRun, ...(syncScope ? { syncScope } : {}), _fetch: f } as any,
    context,
  );
  const sync = writes.find((w) => w.spec === "projectSync")!;
  const errs = writes.find((w) => w.spec === "projectSyncErrors")!;
  return { sync, errs, writes };
}

// (1) normalizeProject pure helper --------------------------------------------
Deno.test("normalizeProject: snake→camel, coerces stringy numbers, archived_at 0→null [PRJ-01]", () => {
  assertEquals(
    normalizeProject({
      id: "prj-1",
      number: "PRJ-9",
      name: "Migration",
      client_id: "cli-3",
      task_rate: "125.00",
      budgeted_hours: "40",
      due_date: "2026-12-31",
      is_deleted: 0,
      archived_at: 0,
    }),
    {
      id: "prj-1",
      number: "PRJ-9",
      name: "Migration",
      clientId: "cli-3",
      taskRate: 125,
      budgetedHours: 40,
      dueDate: "2026-12-31",
      isDeleted: false,
      archivedAt: null,
    },
  );
});

Deno.test("normalizeProject: absent optionals → null, positive archived_at kept [PRJ-01b]", () => {
  const row = normalizeProject({ id: "prj-2", archived_at: 1735689600 });
  assertEquals(row.number, null);
  assertEquals(row.name, null);
  assertEquals(row.clientId, null);
  assertEquals(row.taskRate, null);
  assertEquals(row.budgetedHours, null);
  assertEquals(row.dueDate, null);
  assertEquals(row.isDeleted, null);
  assertEquals(row.archivedAt, 1735689600);
});

// (2) mapProjectToBody pure helper --------------------------------------------
Deno.test("mapProjectToBody: carries number/name/client_id, maps optionals [PRJ-02]", () => {
  const body = mapProjectToBody(proj({
    taskRate: 150,
    budgetedHours: 20,
    dueDate: "2026-06-30",
    publicNotes: "kickoff",
    privateNotes: "internal",
  }));
  assertEquals(body.number, "PRJ-1001");
  assertEquals(body.name, "Website Rebuild");
  assertEquals(body.client_id, "client1");
  assertEquals(body.task_rate, 150);
  assertEquals(body.budgeted_hours, 20);
  assertEquals(body.due_date, "2026-06-30");
  assertEquals(body.public_notes, "kickoff");
  assertEquals(body.private_notes, "internal");
});

Deno.test("mapProjectToBody: omits blank/absent optionals and non-finite numerics [PRJ-02b]", () => {
  const body = mapProjectToBody(proj({
    taskRate: "not-a-number",
    budgetedHours: "",
    publicNotes: "",
  }));
  assertEquals("task_rate" in body, false);
  assertEquals("budgeted_hours" in body, false);
  assertEquals("due_date" in body, false);
  assertEquals("public_notes" in body, false);
  assertEquals("private_notes" in body, false);
});

// (3) listProjects read -------------------------------------------------------
Deno.test("listProjects: snapshots normalized projects [PRJ-03]", async () => {
  const { f } = pagedFetcher([[
    {
      id: "prj-1",
      number: "PRJ-1",
      name: "Alpha",
      client_id: "cli-1",
      task_rate: "90.00",
      budgeted_hours: "10",
    },
  ]]);
  const { context, writes } = stubContext();
  await model.methods.listProjects.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "projects");
  assertEquals(writes[0].name, "projects");
  const items = writes[0].data.items as Array<Record<string, unknown>>;
  assertEquals(items[0].id, "prj-1");
  assertEquals(items[0].clientId, "cli-1");
  assertEquals(items[0].taskRate, 90);
});

Deno.test("listProjects: scope arg suffixes the snapshot instance name [SCOPE-PRJ]", async () => {
  const { f } = pagedFetcher([[]]);
  const { context, writes } = stubContext();
  await model.methods.listProjects.execute(
    // deno-lint-ignore no-explicit-any
    { scope: "snapshot-apply", _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].spec, "projects");
  assertEquals(writes[0].name, "projects--snapshot-apply");
});

Deno.test("listProjects: accumulates multi-page result [PRJ-03b]", async () => {
  const { f, calls } = pagedFetcher([
    [{ id: "prj-1", number: "PRJ-1" }],
    [{ id: "prj-2", number: "PRJ-2" }],
  ]);
  const { context, writes } = stubContext();
  await model.methods.listProjects.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  const items = writes[0].data.items as Array<Record<string, unknown>>;
  assertEquals(items.map((i) => i.id), ["prj-1", "prj-2"]);
  assertEquals(calls.length, 2);
});

Deno.test("listProjects: clientId filter lands in scope name + query [PRJ-04]", async () => {
  const { f, calls } = pagedFetcher([[]]);
  const { context, writes } = stubContext();
  await model.methods.listProjects.execute(
    // deno-lint-ignore no-explicit-any
    { clientId: "cli-7", _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].name, "projects:client=cli-7");
  assertEquals(calls[0].url.includes("client_id=cli-7"), true);
  assertEquals(calls[0].url.includes("include=client"), true);
});

// (4) getProject validation + read --------------------------------------------
Deno.test("getProject: rejects a path-traversal id at the schema boundary [PRJ-05]", () => {
  const schema = model.methods.getProject.arguments;
  assertEquals(schema.safeParse({ id: "Abc123" }).success, true);
  assertEquals(schema.safeParse({ id: "../../users/5" }).success, false);
  assertEquals(schema.safeParse({ id: "a/b" }).success, false);
  assertEquals(schema.safeParse({ id: "" }).success, false);
});

Deno.test("getProject: single record, non-paginated, keeps raw, include=client [PRJ-06]", async () => {
  const { f, calls } = fetcher({ data: { id: "prj-5", number: "PRJ-5" } });
  const { context, writes } = stubContext();
  await model.methods.getProject.execute(
    // deno-lint-ignore no-explicit-any
    { id: "prj5", _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].spec, "project");
  assertEquals(writes[0].name, "project:prj5");
  assertEquals((writes[0].data.raw as Record<string, unknown>).number, "PRJ-5");
  assertEquals(calls[0].url.includes("include=client"), true);
});

// (5) dry-run -----------------------------------------------------------------
Deno.test("upsertProjects: dry-run yields would-create and NO POST [PRJ-07]", async () => {
  const { f, calls } = projectFetcher();
  const { sync } = await runUpsertProjects([proj()], f, true);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(sync.data.dryRun, true);
  assertEquals(postCount(calls), 0);
});

// (6) live create -------------------------------------------------------------
Deno.test("upsertProject: real create POSTs /projects with mandatory headers, returns id [PRJ-08]", async () => {
  const { f, calls } = projectFetcher({ createdId: "prj-new" });
  const r = await upsertProject(CFG, proj(), false, f);
  assertEquals(r.action, "created");
  assertEquals(r.projectId, "prj-new");
  const post = calls.find((c) => (c.method ?? "GET") === "POST")!;
  assertEquals(post.url.includes("/projects"), true);
  assertEquals(post.headers?.["X-API-TOKEN"], "SEKRIT");
  assertEquals(post.headers?.["X-Requested-With"], "XMLHttpRequest");
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assertEquals(body.number, "PRJ-1001");
  assertEquals(body.client_id, "client1");
});

// (7) idempotency: re-run over existing ---------------------------------------
Deno.test("upsertProjects: re-run over existing yields skip already-exists, NO POST [PRJ-09]", async () => {
  const { f, calls } = projectFetcher({
    existingByPage: [[{ id: "prj-x", number: "PRJ-1001" }]],
  });
  const { sync } = await runUpsertProjects([proj()], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "already-exists");
  assertEquals(rows[0].projectId, "prj-x");
  assertEquals(postCount(calls), 0);
});

// (8) substring false-positive guard ------------------------------------------
Deno.test("upsertProject: a substring-only number match is NOT treated as existing [PRJ-10]", async () => {
  const { f, calls } = projectFetcher({
    existingByPage: [[{ id: "prj-x", number: "PRJ-10010" }]],
    createdId: "prj-new",
  });
  const r = await upsertProject(CFG, proj(), false, f);
  assertEquals(r.action, "created");
  assertEquals(postCount(calls), 1);
});

// (9) paginated dedup ---------------------------------------------------------
Deno.test("upsertProject: an exact number match on page 2 IS found [PRJ-11]", async () => {
  const { f, calls } = projectFetcher({
    existingByPage: [
      [{ id: "other", number: "PRJ-2002" }],
      [{ id: "prj-hit", number: "PRJ-1001" }],
    ],
  });
  const r = await upsertProject(CFG, proj(), false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "already-exists");
  assertEquals(r.projectId, "prj-hit");
  assertEquals(postCount(calls), 0);
  assertEquals(calls.length, 2);
});

// (9b) REGRESSION: IN's /projects?filter= does NOT search `number` — the dedup
// GET must scan the FULL trash-inclusive list, never a filter=<number> query, or
// every existing project comes back would-create and a live apply DUPLICATES it.
Deno.test("upsertProject: dedup scans full list, issues NO filter=number query [PRJ-18]", async () => {
  const { f, calls } = projectFetcher({
    existingByPage: [[{ id: "prj-hit", number: "PRJ-1001" }]],
  });
  const r = await upsertProject(CFG, proj(), false, f);
  assertEquals(r.action, "skip"); // found via full-list scan
  assertEquals(r.reason, "already-exists");
  assertEquals(r.projectId, "prj-hit");
  assertEquals(postCount(calls), 0); // never created a duplicate
  const dedupGet = calls.find((c) => (c.method ?? "GET") === "GET")!;
  assertEquals(dedupGet.url.includes("filter="), false); // the fix: no number filter
  assertEquals(dedupGet.url.includes("with_trashed=true"), true); // still trash-inclusive
});

// (9c) PRJ-1: the batch prefetches the project list ONCE, not per-project. A
// 3-project batch must issue exactly ONE GET /projects (the shared trash-inclusive
// scan), with dedup still correct — an existing-by-number project skips, new ones
// create — proving the fan-out no longer does N full-table scans.
Deno.test("upsertProjects: batch prefetches the project list once (single GET) [PRJ-19]", async () => {
  const { f, calls } = projectFetcher({
    existingByPage: [[{ id: "prj-x", number: "PRJ-1001" }]],
    createdId: "prj-new",
  });
  const { sync } = await runUpsertProjects(
    [
      proj({ number: "PRJ-1001" }), // exists → skip already-exists
      proj({ number: "PRJ-2002" }), // new → create
      proj({ number: "PRJ-3003" }), // new → create
    ],
    f,
    false,
  );
  const getCount = calls.filter((c) => (c.method ?? "GET") === "GET").length;
  assertEquals(getCount, 1); // ONE shared scan for the whole batch, not 3
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "already-exists");
  assertEquals(rows[0].projectId, "prj-x");
  assertEquals(rows[1].action, "created");
  assertEquals(rows[2].action, "created");
  assertEquals(postCount(calls), 2); // only the two new projects POST
});

// (10) in-batch duplicate -----------------------------------------------------
Deno.test("upsertProjects: a duplicate number in the batch creates ONCE, marks the second [PRJ-12]", async () => {
  const { f, calls } = projectFetcher({ createdId: "prj-new" });
  const { sync } = await runUpsertProjects([proj(), proj()], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "created");
  assertEquals(rows[1].action, "skip");
  assertEquals(rows[1].reason, "in-batch-duplicate");
  assertEquals(postCount(calls), 1);
});

// (11) invalid clientId rejection ---------------------------------------------
Deno.test("upsertProjects: a path-traversal clientId → skip invalid + surfaced error, NO POST/filter [PRJ-13]", async () => {
  const { f, calls } = projectFetcher();
  const { sync, errs } = await runUpsertProjects(
    [proj({ clientId: "../../users/5" })],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "invalid");
  const eRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(eRows[0].error, "invalid");
  assertEquals(calls.length, 0); // never hit the wire
});

Deno.test("upsertProjects: a missing name → skip invalid, NO POST [PRJ-13b]", async () => {
  const { f, calls } = projectFetcher();
  const { sync } = await runUpsertProjects(
    [proj({ name: "" })],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "invalid");
  assertEquals(postCount(calls), 0);
});

// (12) blank number -----------------------------------------------------------
Deno.test("upsertProjects: a blank number is a skip + surfaced error, NO ?filter= call [PRJ-14]", async () => {
  const { f, calls } = projectFetcher();
  const { sync, errs } = await runUpsertProjects(
    [proj({ number: "  " })],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "blank-dedup-key");
  const eRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(eRows[0].error, "blank-dedup-key");
  assertEquals(calls.length, 0);
});

// (13) mid-batch failure ------------------------------------------------------
Deno.test("upsertProjects: a mid-batch POST failure still flushes both resources [PRJ-15]", async () => {
  const { f } = projectFetcher({
    throwPostWhenNumber: "PRJ-B",
    createdId: "prj-ok",
  });
  const { sync, errs } = await runUpsertProjects(
    [
      proj({ number: "PRJ-A" }),
      proj({ number: "PRJ-B" }),
      proj({
        number: "PRJ-C",
      }),
    ],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // A and C created; B threw → no sync row, only an error row.
  assertEquals(rows.map((r) => r.dedupKey), ["PRJ-A", "PRJ-C"]);
  assertEquals(rows[0].action, "created");
  const eRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(eRows.length, 1);
  assertEquals(eRows[0].dedupKey, "PRJ-B");
  assertEquals(String(eRows[0].error).includes("HTTP 500"), true);
});

// (14) errors flushed even when empty -----------------------------------------
Deno.test("upsertProjects: flushes projectSync shape + projectSyncErrors even with 0 errors [PRJ-16]", async () => {
  const { f } = projectFetcher({ createdId: "prj-new" });
  const { sync, errs } = await runUpsertProjects([proj()], f, false);
  assertEquals(sync.name, "projectSync");
  assertEquals(errs.name, "projectSyncErrors");
  assertEquals((errs.data.rows as unknown[]).length, 0);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].clientId, "client1");
  assertEquals(rows[0].name, "Website Rebuild");
  assertEquals(rows[0].reason, null);
});

// (15) syncScope names per-scope resources ------------------------------------
Deno.test("upsertProjects: syncScope names the per-scope resources [PRJ-17]", async () => {
  const { f } = projectFetcher({ createdId: "prj-new" });
  const { sync, errs } = await runUpsertProjects([proj()], f, true, "clientA");
  assertEquals(sync.name, "projectSync--clientA");
  assertEquals(errs.name, "projectSyncErrors--clientA");
  assertEquals(sync.data.scope, "clientA");
});

// ===========================================================================
// Task CRUD (design/invoiceninja-entity-crud.md §3) — pure helpers + reads +
// the gated write. Reuses the invoice-write fetch/stub harness idioms.
// ===========================================================================

// --- Pure: parseTimeLog + isRunning truth table -----------------------------
Deno.test("parseTimeLog: JSON string, array, absent-stop → 0, malformed → [] [TASK-01]", () => {
  // Wire form: a JSON STRING of pairs.
  assertEquals(parseTimeLog("[[100,200],[300,0]]"), [[100, 200], [300, 0]]);
  // Already an array.
  assertEquals(parseTimeLog([[1, 2]]), [[1, 2]]);
  // Stringy numbers coerce; an absent stop (one-element pair) → 0 (OPEN).
  assertEquals(parseTimeLog('[["10","20"],[30]]'), [[10, 20], [30, 0]]);
  // Empty / blank / null / non-array → [].
  assertEquals(parseTimeLog(""), []);
  assertEquals(parseTimeLog("[]"), []);
  assertEquals(parseTimeLog(null), []);
  assertEquals(parseTimeLog(42), []);
  // Malformed JSON → [] (no throw).
  assertEquals(parseTimeLog("not json"), []);
  // A flat (non-pair) array drops its scalar entries.
  assertEquals(parseTimeLog("[1,2,3]"), []);
});

Deno.test("isRunning: open pair, closed pairs, empty, malformed [TASK-02]", () => {
  // Open pair (stop == 0) anywhere → running.
  assertEquals(isRunning("[[100,0]]"), true);
  assertEquals(isRunning("[[1,2],[3,0]]"), true);
  // Absent stop reads as open → running.
  assertEquals(isRunning("[[100]]"), true);
  // All pairs closed → not running.
  assertEquals(isRunning("[[1,2],[3,4]]"), false);
  // Empty log → not running.
  assertEquals(isRunning("[]"), false);
  assertEquals(isRunning(""), false);
  assertEquals(isRunning(null), false);
  // Malformed → not running (robust, no throw).
  assertEquals(isRunning("not json"), false);
  assertEquals(isRunning(42), false);
});

Deno.test("normalizeTask: lifts fields, parses timeLog, derives isRunning, keeps id string [TASK-03]", () => {
  const t = normalizeTask({
    id: "task-1",
    number: "0001",
    custom_value1: "T-0001",
    description: "Design work",
    client_id: "client9",
    project_id: "proj9",
    status_id: "status9",
    rate: "125.50",
    time_log: "[[1609459200,1609462800],[1609466400,0]]",
    is_deleted: false,
    archived_at: 0,
  });
  assertEquals(t.id, "task-1");
  assertEquals(t.number, "0001"); // IN's auto-managed number
  // TDEDUP-2: the caller-stable dedup key is exposed via customValue1.
  assertEquals(t.customValue1, "T-0001");
  assertEquals(t.description, "Design work");
  assertEquals(t.clientId, "client9");
  assertEquals(t.projectId, "proj9");
  assertEquals(t.statusId, "status9"); // hashid kept as string
  assertEquals(t.rate, 125.5);
  assertEquals(t.timeLog, [[1609459200, 1609462800], [1609466400, 0]]);
  assertEquals(t.isRunning, true); // last pair is open
  assertEquals(t.isDeleted, false);
  assertEquals(t.archivedAt, null); // 0 → null
});

Deno.test("normalizeTask: a fully closed log is not running; archived_at>0 kept [TASK-03b]", () => {
  const t = normalizeTask({
    id: "task-2",
    number: "T-2",
    time_log: "[[1,2]]",
    archived_at: 1700000000,
  });
  assertEquals(t.isRunning, false);
  assertEquals(t.timeLog, [[1, 2]]);
  assertEquals(t.archivedAt, 1700000000);
  assertEquals(t.clientId, null);
  assertEquals(t.rate, null);
});

// --- Reads: listTasks + getTask ---------------------------------------------
Deno.test("listTasks: snapshots normalized tasks; include=client,project,status [TASK-04]", async () => {
  const { f, calls } = pagedFetcher([[
    {
      id: "task-1",
      number: "T-1",
      time_log: "[[100,0]]",
      client_id: "c1",
    },
  ]]);
  const { context, writes } = stubContext();
  await model.methods.listTasks.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].spec, "tasks");
  const items = writes[0].data.items as Array<Record<string, unknown>>;
  assertEquals(items[0].id, "task-1");
  assertEquals(items[0].isRunning, true);
  assertEquals(
    calls[0].url.includes("include=client%2Cproject%2Cstatus"),
    true,
  );
});

Deno.test("listTasks: client/project filters land in the scope name + query [TASK-05]", async () => {
  const { f, calls } = pagedFetcher([[]]);
  const { context, writes } = stubContext();
  await model.methods.listTasks.execute(
    // deno-lint-ignore no-explicit-any
    { clientId: "c7", projectId: "p3", _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].name, "tasks:client=c7:project=p3");
  assertEquals(calls[0].url.includes("client_id=c7"), true);
  assertEquals(calls[0].url.includes("project_id=p3"), true);
});

Deno.test("listTasks: accumulates a multi-page result through the method [TASK-06]", async () => {
  const { f, calls } = pagedFetcher([
    [{ id: "t-a", number: "A" }],
    [{ id: "t-b", number: "B" }],
  ]);
  const { context, writes } = stubContext();
  await model.methods.listTasks.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  const items = writes[0].data.items as Array<Record<string, unknown>>;
  assertEquals(items.map((i) => i.id), ["t-a", "t-b"]);
  assertEquals(calls.length, 2);
});

Deno.test("getTask: single normalized row (same shape as the list) [TASK-07]", async () => {
  const { f, calls } = fetcher({
    data: { id: "task-5", number: "T-5", time_log: "[[1,2]]" },
  });
  const { context, writes } = stubContext();
  await model.methods.getTask.execute(
    // deno-lint-ignore no-explicit-any
    { id: "task5", _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].spec, "task");
  assertEquals(writes[0].name, "task:task5");
  assertEquals(writes[0].data.id, "task-5");
  assertEquals(writes[0].data.isRunning, false);
  assertEquals(
    calls[0].url.includes("include=client%2Cproject%2Cstatus"),
    true,
  );
});

Deno.test("getTask: rejects a path-traversal id at the schema boundary [TASK-08]", () => {
  const schema = model.methods.getTask.arguments;
  assertEquals(schema.safeParse({ id: "Wpmbk5ezJn" }).success, true);
  assertEquals(schema.safeParse({ id: "../../users/5" }).success, false);
  assertEquals(schema.safeParse({ id: "1/2" }).success, false);
  assertEquals(schema.safeParse({ id: "" }).success, false);
});

// --- Write: upsertTasks ------------------------------------------------------
/**
 * A fake {@link FetchLike} serving BOTH the paginated dedup GET and the create
 * POST for /tasks. `existingByPage[i]` is the `data[]` for `?page=i+1`; a POST
 * returns `{data:{id}}` unless `throwPostWhenNumber` matches the body's `number`
 * (then HTTP 500 → inFetch throws).
 */
function taskFetcher(
  opts: {
    existingByPage?: Array<Array<Record<string, unknown>>>;
    createdId?: string;
    throwPostWhenNumber?: string;
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
      // Task dedup key lives in custom_value1 (IN auto-manages `number`).
      if (
        opts.throwPostWhenNumber &&
        body.custom_value1 === opts.throwPostWhenNumber
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
          Promise.resolve({ data: { id: opts.createdId ?? "task-new" } }),
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

/** A canonical task input, overridable. */
function taskInput(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: "T-1001",
    description: "Consulting",
    clientId: "client1",
    projectId: "proj1",
    rate: 125,
    ...over,
  };
}

/** Run the fan-out method and return the persisted taskSync/errors writes. */
async function runUpsertTasks(
  tasks: Array<Record<string, unknown>>,
  f: FetchLike,
  dryRun: boolean,
) {
  const { context, writes } = stubContext();
  await model.methods.upsertTasks.execute(
    // deno-lint-ignore no-explicit-any
    { tasks, dryRun, _fetch: f } as any,
    context,
  );
  const sync = writes.find((w) => w.spec === "taskSync")!;
  const errs = writes.find((w) => w.spec === "taskSyncErrors")!;
  return { sync, errs };
}

Deno.test("mapTaskToBody: carries number/description/ids/rate, NEVER time_log [TASK-09]", () => {
  const body = mapTaskToBody(taskInput());
  assertEquals(body.custom_value1, "T-1001");
  assertEquals(body.description, "Consulting");
  assertEquals(body.client_id, "client1");
  assertEquals(body.project_id, "proj1");
  assertEquals(body.rate, 125);
  assertEquals("time_log" in body, false); // orthogonal to timing
});

Deno.test("mapTaskToBody: optional ids/rate omitted when absent; blank description → '' [TASK-09b]", () => {
  const body = mapTaskToBody({ number: "T-2" });
  assertEquals(body.custom_value1, "T-2");
  assertEquals("number" in body, false); // IN auto-manages number; not sent
  assertEquals(body.description, "");
  assertEquals("client_id" in body, false);
  assertEquals("project_id" in body, false);
  assertEquals("rate" in body, false);
});

Deno.test("upsertTasks: dry-run yields would-create and NO POST [TASK-10]", async () => {
  const { f, calls } = taskFetcher();
  const { sync } = await runUpsertTasks([taskInput()], f, true);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(sync.data.dryRun, true);
  assertEquals(postCount(calls), 0);
});

Deno.test("upsertTask: real create POSTs /tasks with mandatory headers, returns id, no time_log [TASK-11]", async () => {
  const { f, calls } = taskFetcher({ createdId: "task-777" });
  const r = await upsertTask(CFG, taskInput(), false, f);
  assertEquals(r.action, "created");
  assertEquals(r.taskId, "task-777");
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.url.includes("/tasks"), true);
  assertEquals(post.headers?.["X-API-TOKEN"], "SEKRIT");
  assertEquals(post.headers?.["X-Requested-With"], "XMLHttpRequest");
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assertEquals(body.custom_value1, "T-1001");
  assertEquals("time_log" in body, false);
});

Deno.test("upsertTasks: re-run over an existing task yields skip already-exists, NO POST [TASK-12]", async () => {
  const { f, calls } = taskFetcher({
    existingByPage: [[{ id: "task-x", custom_value1: "T-1001" }]],
  });
  const { sync } = await runUpsertTasks([taskInput()], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "already-exists");
  assertEquals(rows[0].taskId, "task-x");
  assertEquals(postCount(calls), 0);
});

Deno.test("upsertTask: a substring-only number match is NOT treated as existing [TASK-13]", async () => {
  const { f, calls } = taskFetcher({
    existingByPage: [[{ id: "task-x", custom_value1: "T-10010" }]],
    createdId: "task-new",
  });
  const r = await upsertTask(CFG, taskInput(), false, f);
  assertEquals(r.action, "created");
  assertEquals(postCount(calls), 1);
});

Deno.test("upsertTask: an exact number match on page 2 IS found [TASK-14]", async () => {
  const { f, calls } = taskFetcher({
    existingByPage: [
      [{ id: "other", custom_value1: "T-2002" }],
      [{ id: "task-hit", custom_value1: "T-1001" }],
    ],
  });
  const r = await upsertTask(CFG, taskInput(), false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "already-exists");
  assertEquals(r.taskId, "task-hit");
  assertEquals(calls.length, 2); // scanned both pages
});

Deno.test("upsertTasks: a duplicate number in the batch creates ONCE, marks the second [TASK-15]", async () => {
  const { f, calls } = taskFetcher({ createdId: "task-new" });
  const { sync } = await runUpsertTasks([taskInput(), taskInput()], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "created");
  assertEquals(rows[1].action, "skip");
  assertEquals(rows[1].reason, "in-batch-duplicate");
  assertEquals(postCount(calls), 1);
});

Deno.test("upsertTasks: a blank number is a skip + surfaced error, NO ?filter= call [TASK-16]", async () => {
  const { f, calls } = taskFetcher();
  const { sync, errs } = await runUpsertTasks(
    [taskInput({ number: "" })],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "blank-dedup-key");
  const eRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(eRows[0].error, "blank-dedup-key");
  assertEquals(calls.length, 0); // never hit the wire with an empty filter
});

Deno.test("upsertTasks: a whitespace-only number is treated as blank, NO ?filter= call [TASK-16b]", async () => {
  const { f, calls } = taskFetcher();
  const { sync } = await runUpsertTasks(
    [taskInput({ number: "   " })],
    f,
    false,
  );
  assertEquals(
    (sync.data.rows as Array<Record<string, unknown>>)[0].reason,
    "blank-dedup-key",
  );
  assertEquals(calls.length, 0);
});

Deno.test("upsertTasks: a malformed clientId/projectId is skip invalid, NO POST [TASK-17]", async () => {
  for (const bad of [{ clientId: "../../users/5" }, { projectId: "1/2" }]) {
    const { f, calls } = taskFetcher();
    const { sync, errs } = await runUpsertTasks(
      [taskInput(bad)],
      f,
      false,
    );
    assertEquals(
      (sync.data.rows as Array<Record<string, unknown>>)[0].reason,
      "invalid",
    );
    // invalid input is also a surfaced error row.
    assertEquals(
      (errs.data.rows as Array<Record<string, unknown>>)[0].error,
      "invalid",
    );
    assertEquals(postCount(calls), 0);
  }
});

Deno.test("upsertTasks: a non-finite rate is skip invalid, NO POST [TASK-17b]", async () => {
  const { f, calls } = taskFetcher();
  const { sync } = await runUpsertTasks(
    [taskInput({ rate: "not-a-number" })],
    f,
    false,
  );
  assertEquals(
    (sync.data.rows as Array<Record<string, unknown>>)[0].reason,
    "invalid",
  );
  assertEquals(postCount(calls), 0);
});

Deno.test("upsertTask: dedup is trash-inclusive — a soft-deleted match still skips [TASK-18]", async () => {
  const { f, calls } = taskFetcher({
    existingByPage: [[{
      id: "task-del",
      custom_value1: "T-1001",
      is_deleted: true,
    }]],
  });
  const r = await upsertTask(CFG, taskInput(), false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "already-exists");
  assertEquals(r.taskId, "task-del");
  // with_trashed=true is on the dedup GET.
  assertEquals(calls[0].url.includes("with_trashed=true"), true);
  assertEquals(postCount(calls), 0);
});

Deno.test("upsertTasks: a mid-batch POST failure keeps created rows AND an error row [TASK-19]", async () => {
  const a = taskInput({ number: "T-A" });
  const b = taskInput({ number: "T-B" });
  const c = taskInput({ number: "T-C" });
  const { f } = taskFetcher({
    throwPostWhenNumber: "T-B",
    createdId: "task-ok",
  });
  const { sync, errs } = await runUpsertTasks([a, b, c], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // A and C created; B threw → no sync row, only an error row.
  assertEquals(rows.map((r) => r.dedupKey), ["T-A", "T-C"]);
  assertEquals(rows[0].action, "created");
  const eRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(eRows.length, 1);
  assertEquals(eRows[0].dedupKey, "T-B");
  assertEquals(String(eRows[0].error).includes("HTTP 500"), true);
});

Deno.test("upsertTasks: flushes taskSync shape + taskSyncErrors even with 0 errors [TASK-20]", async () => {
  const { f } = taskFetcher({ createdId: "task-1" });
  const { sync, errs } = await runUpsertTasks([taskInput()], f, false);
  assertEquals(sync.spec, "taskSync");
  assertEquals(sync.data.dryRun, false);
  assertEquals(typeof sync.data.retrievedAt, "string");
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].dedupKey, "T-1001");
  assertEquals(rows[0].clientId, "client1");
  assertEquals(rows[0].projectId, "proj1");
  assertEquals(errs.spec, "taskSyncErrors");
  assertEquals((errs.data.rows as unknown[]).length, 0);
  assertEquals(typeof errs.data.retrievedAt, "string");
});

Deno.test("upsertTasks: syncScope names the per-scope resources [TASK-20b]", async () => {
  const { f } = taskFetcher({ createdId: "task-1" });
  const { context, writes } = stubContext();
  await model.methods.upsertTasks.execute(
    // deno-lint-ignore no-explicit-any
    {
      tasks: [taskInput()],
      dryRun: false,
      syncScope: "backfill",
      _fetch: f,
    } as any,
    context,
  );
  assertEquals(
    writes.find((w) => w.spec === "taskSync")!.name,
    "taskSync--backfill",
  );
  assertEquals(
    writes.find((w) => w.spec === "taskSyncErrors")!.name,
    "taskSyncErrors--backfill",
  );
});

Deno.test("upsertTasks: in-batch duplicate holds in dry-run (no POST) [TASK-21]", async () => {
  const { f, calls } = taskFetcher();
  const { sync } = await runUpsertTasks([taskInput(), taskInput()], f, true);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(rows[1].action, "skip");
  assertEquals(rows[1].reason, "in-batch-duplicate");
  assertEquals(postCount(calls), 0);
});

// ---------------------------------------------------------------------------
// Task timer (§4) — pure time_log helpers + startTask/stopTask methods.
// STEP-0: no dedicated start/stop endpoints; timer = PUT /tasks/{id} rewriting
// `time_log` (UNIX SECONDS; stop==0/absent ⇒ open). Verified vs v5 source.
// ---------------------------------------------------------------------------

/**
 * A fake {@link FetchLike} for the timer: a GET /tasks/{id} returns
 * `{data:{id, time_log}}` with the given `timeLog` (verbatim — pass a JSON
 * string OR an array to exercise parseTimeLogEntries); a PUT echoes `{data:{id}}`.
 * Records method + body so a test can assert whether (and what) a PUT was sent.
 */
function timerTaskFetcher(
  opts: { id?: string; timeLog?: unknown } = {},
): { f: FetchLike; calls: WFetchRec[] } {
  const calls: WFetchRec[] = [];
  const id = opts.id ?? "task1";
  const f: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ data: { id } }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ data: { id, time_log: opts.timeLog } }),
    });
  };
  return { f, calls };
}

/** Count PUT calls in a recorded call list. */
function putCount(calls: WFetchRec[]): number {
  return calls.filter((c) => c.method === "PUT").length;
}

/** The time_log string parsed out of the single recorded PUT body. */
function putTimeLog(calls: WFetchRec[]): unknown[] {
  const put = calls.find((c) => c.method === "PUT");
  if (!put || !put.body) throw new Error("no PUT body recorded");
  const body = JSON.parse(put.body) as Record<string, unknown>;
  return JSON.parse(body.time_log as string) as unknown[];
}

// --- Pure helpers -----------------------------------------------------------

Deno.test("parseTimeLogEntries: JSON string, array passthrough, blank/malformed → []", () => {
  assertEquals(parseTimeLogEntries("[[100,0]]"), [[100, 0]]);
  assertEquals(parseTimeLogEntries([[100, 200]]), [[100, 200]]);
  assertEquals(parseTimeLogEntries(""), []);
  assertEquals(parseTimeLogEntries("   "), []);
  assertEquals(parseTimeLogEntries(null), []);
  assertEquals(parseTimeLogEntries(undefined), []);
  assertEquals(parseTimeLogEntries("not json"), []);
  assertEquals(parseTimeLogEntries("{}"), []); // non-array parse
  // TMR-SEC-2: non-array entries are PRESERVED verbatim (not dropped) so a
  // later PUT round-trips the whole log and never silently deletes data.
  assertEquals(parseTimeLogEntries([[1, 2], "x", 5, [3, 0]]), [
    [1, 2],
    "x",
    5,
    [3, 0],
  ]);
});

Deno.test("isOpenEntry: stop 0/absent/non-positive is open; positive is closed", () => {
  assertEquals(isOpenEntry([100, 0]), true);
  assertEquals(isOpenEntry([100]), true); // stop absent
  assertEquals(isOpenEntry([100, "0"]), true); // stringy 0
  assertEquals(isOpenEntry([100, 200]), false);
  assertEquals(isOpenEntry([100, "200"]), false); // stringy number
});

Deno.test("latestOpenPairIndex / hasOpenTimeLogPair: picks the LATEST open entry", () => {
  assertEquals(latestOpenPairIndex([]), -1);
  assertEquals(latestOpenPairIndex([[1, 2], [3, 4]]), -1);
  assertEquals(hasOpenTimeLogPair([[1, 2], [3, 4]]), false);
  // Multiple entries, one trailing open pair → its index, not an earlier one.
  assertEquals(latestOpenPairIndex([[1, 2], [3, 4], [5, 0]]), 2);
  // Two open pairs → the LATEST (highest index).
  assertEquals(latestOpenPairIndex([[1, 0], [3, 4], [5, 0]]), 2);
  assertEquals(hasOpenTimeLogPair([[1, 2], [3, 0]]), true);
});

Deno.test("appendOpenPair / closeOpenPair: pure, preserve trailing elements", () => {
  const log = [[1, 2, "desc", true]];
  const started = appendOpenPair(log, 500);
  assertEquals(started, [[1, 2, "desc", true], [500, 0]]);
  assertEquals(log, [[1, 2, "desc", true]]); // input untouched

  const open = [[1, 2], [5, 0, "work", false]];
  const closed = closeOpenPair(open, 1, 900);
  assertEquals(closed, [[1, 2], [5, 900, "work", false]]); // desc/billable kept
  assertEquals(open, [[1, 2], [5, 0, "work", false]]); // input untouched
});

Deno.test("decideStart: not-running → started (+append); already-open → no-op", () => {
  const idle = decideStart([[1, 2]], 1000);
  assertEquals(idle.action, "started");
  assertEquals(idle.running, true);
  assertEquals(idle.changed, true);
  assertEquals(idle.newLog, [[1, 2], [1000, 0]]);

  const running = decideStart([[1, 0]], 1000);
  assertEquals(running.action, "already-running");
  assertEquals(running.running, true);
  assertEquals(running.changed, false);
  assertEquals(running.newLog, [[1, 0]]); // unchanged
});

Deno.test("decideStop: running → stopped (closes LATEST); not-running → no-op", () => {
  const running = decideStop([[1, 2], [5, 0]], 1000);
  assertEquals(running.action, "stopped");
  assertEquals(running.running, false);
  assertEquals(running.changed, true);
  assertEquals(running.newLog, [[1, 2], [5, 1000]]);

  const idle = decideStop([[1, 2]], 1000);
  assertEquals(idle.action, "not-running");
  assertEquals(idle.running, false);
  assertEquals(idle.changed, false);
  assertEquals(idle.newLog, [[1, 2]]); // unchanged
});

// --- Method paths (injected fetch + clock) ----------------------------------

Deno.test("startTask: not-running → PUTs appended [now,0], writes taskTimer 'started'", async () => {
  const { f, calls } = timerTaskFetcher({
    id: "abc123",
    timeLog: "[[100,200]]",
  });
  const { context, writes } = stubContext();
  await model.methods.startTask.execute(
    // deno-lint-ignore no-explicit-any
    {
      id: "abc123",
      dryRun: false,
      _fetch: f,
      _nowMs: () => 1_710_000_000_000,
    } as any,
    context,
  );
  assertEquals(putCount(calls), 1);
  // nowMs → seconds (floor(ms/1000)); appended as a new open pair.
  assertEquals(putTimeLog(calls), [[100, 200], [1_710_000_000, 0]]);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "taskTimer");
  assertEquals(writes[0].name, "taskTimer:abc123");
  assertEquals(writes[0].data.action, "started");
  assertEquals(writes[0].data.running, true);
  assertEquals(writes[0].data.dryRun, false);
});

Deno.test("startTask: already-running → idempotent no-op, NO PUT", async () => {
  const { f, calls } = timerTaskFetcher({ id: "abc123", timeLog: "[[100,0]]" });
  const { context, writes } = stubContext();
  await model.methods.startTask.execute(
    // deno-lint-ignore no-explicit-any
    {
      id: "abc123",
      dryRun: false,
      _fetch: f,
      _nowMs: () => 2_000_000_000_000,
    } as any,
    context,
  );
  assertEquals(putCount(calls), 0); // never PUT
  assertEquals(writes[0].data.action, "already-running");
  assertEquals(writes[0].data.running, true);
});

Deno.test("stopTask: running → PUTs latest open pair closed at now, 'stopped'", async () => {
  // Two closed pairs + one trailing open pair carrying a description/billable.
  const { f, calls } = timerTaskFetcher({
    id: "abc123",
    timeLog: '[[100,200],[300,400],[500,0,"work",true]]',
  });
  const { context, writes } = stubContext();
  await model.methods.stopTask.execute(
    // deno-lint-ignore no-explicit-any
    {
      id: "abc123",
      dryRun: false,
      _fetch: f,
      _nowMs: () => 1_710_000_000_000,
    } as any,
    context,
  );
  assertEquals(putCount(calls), 1);
  // Only the LATEST open pair is closed; its trailing elements are preserved.
  assertEquals(putTimeLog(calls), [
    [100, 200],
    [300, 400],
    [500, 1_710_000_000, "work", true],
  ]);
  assertEquals(writes[0].data.action, "stopped");
  assertEquals(writes[0].data.running, false);
});

Deno.test("stopTask: not-running → idempotent no-op, NO PUT", async () => {
  const { f, calls } = timerTaskFetcher({
    id: "abc123",
    timeLog: "[[100,200]]",
  });
  const { context, writes } = stubContext();
  await model.methods.stopTask.execute(
    // deno-lint-ignore no-explicit-any
    { id: "abc123", dryRun: false, _fetch: f } as any,
    context,
  );
  assertEquals(putCount(calls), 0);
  assertEquals(writes[0].data.action, "not-running");
  assertEquals(writes[0].data.running, false);
});

Deno.test("startTask: dryRun (default) returns would-be state and NEVER PUTs", async () => {
  const { f, calls } = timerTaskFetcher({
    id: "abc123",
    timeLog: "[[100,200]]",
  });
  const { context, writes } = stubContext(); // CFG.dryRun === true
  await model.methods.startTask.execute(
    // deno-lint-ignore no-explicit-any
    { id: "abc123", _fetch: f, _nowMs: () => 1_710_000_000_000 } as any,
    context,
  );
  assertEquals(putCount(calls), 0); // dry run: no PUT
  // GET happened (to read current state), but no write to IN.
  assertEquals(calls.filter((c) => (c.method ?? "GET") === "GET").length, 1);
  assertEquals(writes[0].data.action, "started"); // would-be state
  assertEquals(writes[0].data.running, true);
  assertEquals(writes[0].data.dryRun, true);
  // The would-be time_log is recorded even though nothing was PUT.
  assertEquals(writes[0].data.timeLog, [[100, 200], [1_710_000_000, 0]]);
});

Deno.test("stopTask: dryRun returns would-be 'stopped' and NEVER PUTs", async () => {
  const { f, calls } = timerTaskFetcher({ id: "abc123", timeLog: "[[500,0]]" });
  const { context, writes } = stubContext();
  await model.methods.stopTask.execute(
    // deno-lint-ignore no-explicit-any
    {
      id: "abc123",
      dryRun: true,
      _fetch: f,
      _nowMs: () => 1_710_000_000_000,
    } as any,
    context,
  );
  assertEquals(putCount(calls), 0);
  assertEquals(writes[0].data.action, "stopped");
  assertEquals(writes[0].data.timeLog, [[500, 1_710_000_000]]);
});

Deno.test("startTask/stopTask: a path-traversal id is rejected before any fetch", async () => {
  const { f, calls } = timerTaskFetcher({ timeLog: "[]" });
  const { context } = stubContext();
  await assertRejects(
    () =>
      model.methods.startTask.execute(
        // deno-lint-ignore no-explicit-any
        { id: "../../users/5", _fetch: f } as any,
        context,
      ),
    Error,
    "alphanumeric",
  );
  await assertRejects(
    () =>
      model.methods.stopTask.execute(
        // deno-lint-ignore no-explicit-any
        { id: "a/b", _fetch: f } as any,
        context,
      ),
    Error,
    "alphanumeric",
  );
  assertEquals(calls.length, 0); // never reached the network seam
});

Deno.test("startTask: tolerates an empty/absent time_log (fresh task) → started", async () => {
  const { f, calls } = timerTaskFetcher({ id: "abc123", timeLog: undefined });
  const { context, writes } = stubContext();
  await model.methods.startTask.execute(
    // deno-lint-ignore no-explicit-any
    {
      id: "abc123",
      dryRun: false,
      _fetch: f,
      _nowMs: () => 1_710_000_000_000,
    } as any,
    context,
  );
  assertEquals(putCount(calls), 1);
  assertEquals(putTimeLog(calls), [[1_710_000_000, 0]]);
  assertEquals(writes[0].data.action, "started");
});

// ===========================================================================
// Regression tests for the adversarial code-review findings (review gate).
// ===========================================================================

Deno.test("numOrNull: a whitespace-only string is null, not 0 [PRJ-COR-2]", () => {
  assertEquals(numOrNull("   "), null);
  assertEquals(numOrNull("\t\n"), null);
  assertEquals(numOrNull(""), null);
  // Real numbers still coerce.
  assertEquals(numOrNull("90.00"), 90);
  assertEquals(numOrNull(0), 0);
});

Deno.test("clientSnapshotLifetime: rejects malformed TTLs, accepts durations + infinite [CLI-SEC-2]", () => {
  const schema = model.globalArguments;
  // Vary ONLY the lifetime against an otherwise-complete valid config so the
  // parse result reflects the field's own regex, not missing siblings.
  for (const bad of ["1hr", "0", "", "abc", "1 h", "-5m"]) {
    assertEquals(
      schema.safeParse({ ...CFG, clientSnapshotLifetime: bad }).success,
      false,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
  for (const ok of ["1h", "24h", "7d", "30m", "60s", "2w", "infinite"]) {
    assertEquals(
      schema.safeParse({ ...CFG, clientSnapshotLifetime: ok }).success,
      true,
      `expected ${JSON.stringify(ok)} to be accepted`,
    );
  }
});

Deno.test("upsertProject: a whitespace-only name is invalid — skip, NO POST [PRJ-COR-1]", async () => {
  const { f, calls } = projectFetcher({ createdId: "prj-x" });
  const r = await upsertProject(CFG, proj({ name: "   " }), false, f);
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "invalid");
  assertEquals(r.projectId, null);
  assertEquals(calls.length, 0); // rejected before any wire call
});

Deno.test("decideStop: multiple open pairs → closes LATEST, running reflects remainder, junk preserved [TMR-COR-1/TMR-SEC-2]", () => {
  // Malformed pre-existing log: a legacy non-array entry + TWO open pairs.
  const d = decideStop([[100, 200], "legacy", [300, 0], [500, 0]], 900);
  assertEquals(d.action, "stopped");
  // TMR-SEC-2: the non-array entry AND the earlier still-open pair are preserved
  // verbatim; only the LATEST open pair is closed.
  assertEquals(d.newLog, [[100, 200], "legacy", [300, 0], [500, 900]]);
  // TMR-COR-1: an earlier pair is still open, so running must be TRUE, not a
  // hardcoded false that would contradict the persisted timeLog.
  assertEquals(d.running, true);
});

// ===========================================================================
// Payment-apply path (design/specs/invoiceninja-payment-apply.spec.md).
// Injected FetchLike, bugzilla pattern. Covers the 12-point test contract.
// ===========================================================================

/** Build an InvoiceIndex directly (number → {id, balance} | "ambiguous"). */
function idx(
  entries: Record<
    string,
    { id: string; balance: number; clientId?: string } | "ambiguous"
  >,
): InvoiceIndex {
  const m: InvoiceIndex = new Map();
  for (const [number, v] of Object.entries(entries)) m.set(number, v);
  return m;
}

/** A raw PaymentInput; override any field. */
function pay(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: "cli1",
    date: "2026-07-14",
    transactionReference: "BT-001",
    applications: [{ invoiceNumber: "Ja-002", amount: 100 }],
    ...over,
  };
}

/**
 * A fake {@link FetchLike} serving the /payments dedup GET (paginated) + the
 * POST /payments create. `existingByPage[i]` is the dedup `data[]` for
 * `?page=i+1`; a POST returns `{data:{id}}` unless `throwPost` (HTTP 500 →
 * inFetch throws). It NEVER serves /invoices — the standalone applyPayment tests
 * pass an explicit invoiceIndex, so the invoice prefetch is never hit.
 */
function payFetcher(
  opts: {
    existingByPage?: Array<Array<Record<string, unknown>>>;
    createdId?: string;
    throwPost?: boolean;
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
      if (opts.throwPost) {
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
          Promise.resolve({ data: { id: opts.createdId ?? "pay-new" } }),
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

/**
 * A fake {@link FetchLike} for the fan-out: serves the /invoices index GET, the
 * /payments dedup GET (paginated), and the POST /payments create. `invoices` is
 * the live invoice list; `paymentsByPage[i]` is the dedup `data[]` for
 * `?page=i+1`; a POST throws (HTTP 500) when its body's transaction_reference is
 * in `throwRefs`.
 */
function applyFetcher(
  opts: {
    invoices?: Array<Record<string, unknown>>;
    paymentsByPage?: Array<Array<Record<string, unknown>>>;
    createdId?: string;
    throwRefs?: string[];
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
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST") {
      const body = init?.body
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};
      if (
        (opts.throwRefs ?? []).includes(body.transaction_reference as string)
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
          Promise.resolve({ data: { id: opts.createdId ?? "pay-new" } }),
      });
    }
    if (u.pathname.endsWith("/invoices")) {
      const data = opts.invoices ?? [];
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
    }
    // /payments dedup GET.
    const pages = opts.paymentsByPage ?? [[]];
    const page = Number(u.searchParams.get("page") ?? "1");
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

/** Run the fan-out and return the persisted paymentSync/paymentSyncErrors writes. */
async function runApplyPayments(
  payments: Array<Record<string, unknown>>,
  f: FetchLike,
  dryRun: boolean,
  syncScope?: string,
) {
  const { context, writes } = stubContext();
  await model.methods.applyPayments.execute(
    // deno-lint-ignore no-explicit-any
    { payments, dryRun, ...(syncScope ? { syncScope } : {}), _fetch: f } as any,
    context,
  );
  const sync = writes.find((w) => w.spec === "paymentSync")!;
  const errs = writes.find((w) => w.spec === "paymentSyncErrors")!;
  return { sync, errs, writes };
}

// (1) mapPaymentToBody shape -------------------------------------------------
Deno.test("mapPaymentToBody: no top-level amount, resolved invoices[], ref mirror [PAY-1]", () => {
  const body = mapPaymentToBody(
    pay({
      typeId: 1,
      privateNotes: "bt settle",
      applications: [
        { invoiceNumber: "Ja-002", amount: 100 },
        { invoiceId: "inv-3", amount: 50 },
      ],
    }),
    (a) => (a.invoiceNumber === "Ja-002" ? "inv-2" : "inv-3"),
  );
  assertEquals("amount" in body, false); // IN sums invoices[].amount
  assertEquals(body.client_id, "cli1");
  assertEquals(body.date, "2026-07-14");
  assertEquals(body.transaction_reference, "BT-001"); // DEDUP mirror
  assertEquals(body.type_id, 1);
  assertEquals(body.private_notes, "bt settle");
  assertEquals(body.invoices, [
    { invoice_id: "inv-2", amount: 100 },
    { invoice_id: "inv-3", amount: 50 },
  ]);
  assertEquals("send_email" in body, false); // NEVER any email/notify field
});

Deno.test("mapPaymentToBody: omits type_id/private_notes when absent [PAY-1]", () => {
  const body = mapPaymentToBody(pay(), (_a) => "inv-2");
  assertEquals("type_id" in body, false);
  assertEquals("private_notes" in body, false);
});

// (1) validation gate --------------------------------------------------------
Deno.test("applyPayment: a malformed clientId / empty applications / non-positive amount is invalid [PAY-1]", async () => {
  const index = idx({ "Ja-002": { id: "inv-2", balance: 100 } });
  const { f } = payFetcher();
  assertEquals(
    (await applyPayment(
      CFG,
      pay({ clientId: "bad id!" }),
      false,
      f,
      new Set(),
      index,
    )).reason,
    "invalid",
  );
  assertEquals(
    (await applyPayment(
      CFG,
      pay({ applications: [] }),
      false,
      f,
      new Set(),
      index,
    )).reason,
    "invalid",
  );
  assertEquals(
    (await applyPayment(
      CFG,
      pay({ applications: [{ invoiceNumber: "Ja-002", amount: 0 }] }),
      false,
      f,
      new Set(),
      index,
    )).reason,
    "invalid",
  );
  assertEquals(
    (await applyPayment(
      CFG,
      pay({ applications: [{ invoiceNumber: "Ja-002", amount: -5 }] }),
      false,
      f,
      new Set(),
      index,
    )).reason,
    "invalid",
  );
});

// (2) idempotency ------------------------------------------------------------
Deno.test("applyPayment: an existing transaction_reference skips already-exists, NO POST [PAY-2]", async () => {
  const { f, calls } = payFetcher({
    existingByPage: [[{ id: "pay-9", transaction_reference: "BT-001" }]],
  });
  const r = await applyPayment(
    CFG,
    pay(),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" } }),
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "already-exists");
  assertEquals(r.paymentId, "pay-9");
  assertEquals(postCount(calls), 0);
});

// (3) dry-run ----------------------------------------------------------------
Deno.test("applyPayment: dry-run yields would-create and NEVER POSTs [PAY-3]", async () => {
  const { f, calls } = payFetcher();
  const r = await applyPayment(
    CFG,
    pay(),
    true,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" } }),
  );
  assertEquals(r.action, "would-create");
  assertEquals(r.paymentId, null);
  assertEquals(r.appliedInvoiceIds, ["inv-2"]);
  assertEquals(postCount(calls), 0);
});

// (4) substring false-positive guard -----------------------------------------
Deno.test("applyPayment: a substring-only transaction_reference match is NOT existing [PAY-4]", async () => {
  // `?filter=BT-001` returns a row whose ref merely CONTAINS the key.
  const { f, calls } = payFetcher({
    existingByPage: [[{ id: "pay-x", transaction_reference: "BT-0012" }]],
    createdId: "pay-new",
  });
  const r = await applyPayment(
    CFG,
    pay(),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" } }),
  );
  assertEquals(r.action, "created");
  assertEquals(r.paymentId, "pay-new");
  assertEquals(postCount(calls), 1); // not deduped away by the substring row
});

// (5) paginated dedup --------------------------------------------------------
Deno.test("applyPayment: an exact ref match on page 2 is found, no duplicate POST [PAY-5]", async () => {
  const { f, calls } = payFetcher({
    existingByPage: [
      [{ id: "p1", transaction_reference: "OTHER" }],
      [{ id: "p2", transaction_reference: "BT-001" }],
    ],
  });
  const r = await applyPayment(
    CFG,
    pay(),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" } }),
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "already-exists");
  assertEquals(r.paymentId, "p2");
  assertEquals(postCount(calls), 0);
});

// (6) in-batch duplicate -----------------------------------------------------
Deno.test("applyPayments: a duplicate ref → one create + a second in-batch-duplicate row [PAY-6]", async () => {
  const { f, calls } = applyFetcher({
    invoices: [{
      id: "inv-2",
      number: "Ja-002",
      balance: 100,
      client_id: "cli1",
    }],
    createdId: "pay-1",
  });
  const { sync } = await runApplyPayments([pay(), pay()], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.length, 2);
  assertEquals(rows[0].action, "created");
  assertEquals(rows[1].action, "skip");
  assertEquals(rows[1].reason, "in-batch-duplicate");
  assertEquals(postCount(calls), 1); // exactly ONE create
});

Deno.test("applyPayments: in-batch-duplicate holds in dry-run (one would-create) [PAY-6]", async () => {
  const { f, calls } = applyFetcher({
    invoices: [{
      id: "inv-2",
      number: "Ja-002",
      balance: 100,
      client_id: "cli1",
    }],
  });
  const { sync } = await runApplyPayments([pay(), pay()], f, true);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(rows[1].reason, "in-batch-duplicate");
  assertEquals(postCount(calls), 0);
});

// (7) mid-batch failure ------------------------------------------------------
Deno.test("applyPayments: a mid-batch POST failure still flushes both audits, batch not aborted [PAY-7]", async () => {
  const { f } = applyFetcher({
    invoices: [
      { id: "inv-2", number: "Ja-002", balance: 100, client_id: "cli1" },
      { id: "inv-3", number: "Ja-003", balance: 200, client_id: "cli1" },
      { id: "inv-4", number: "Ja-004", balance: 300, client_id: "cli1" },
    ],
    throwRefs: ["BT-002"],
  });
  const { sync, errs } = await runApplyPayments(
    [
      pay({
        transactionReference: "BT-001",
        applications: [{ invoiceNumber: "Ja-002", amount: 100 }],
      }),
      pay({
        transactionReference: "BT-002",
        applications: [{ invoiceNumber: "Ja-003", amount: 200 }],
      }),
      pay({
        transactionReference: "BT-003",
        applications: [{ invoiceNumber: "Ja-004", amount: 300 }],
      }),
    ],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // Payment 1 kept its created row; payment 3 still ran (batch not aborted).
  assertEquals(rows.length, 2);
  assertEquals(rows[0].dedupKey, "BT-001");
  assertEquals(rows[0].action, "created");
  assertEquals(rows[1].dedupKey, "BT-003");
  assertEquals(rows[1].action, "created");
  // Payment 2's failure is a durable, queryable error row.
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(erows[0].dedupKey, "BT-002");
  assertEquals(erows[0].amount, 200);
});

// (8) invoice resolution by number / id --------------------------------------
Deno.test("applyPayment: resolves invoiceNumber to the hashid on the POST body [PAY-8]", async () => {
  const { f, calls } = payFetcher({ createdId: "pay-new" });
  const r = await applyPayment(
    CFG,
    pay({ applications: [{ invoiceNumber: "Ja-002", amount: 100 }] }),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" } }),
  );
  assertEquals(r.action, "created");
  assertEquals(r.appliedInvoiceIds, ["inv-2"]);
  const post = calls.find((c) => c.method === "POST")!;
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assertEquals(body.invoices, [{ invoice_id: "inv-2", amount: 100 }]);
});

Deno.test("applyPayment: resolves an explicit invoiceId (balance via index) [PAY-8]", async () => {
  const { f } = payFetcher({ createdId: "pay-new" });
  const r = await applyPayment(
    CFG,
    pay({ applications: [{ invoiceId: "inv-2", amount: 100 }] }),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" } }),
  );
  assertEquals(r.action, "created");
  assertEquals(r.appliedInvoiceIds, ["inv-2"]);
});

Deno.test("applyPayment: an unresolved invoiceNumber skips invoice-unresolved, NO POST [PAY-8]", async () => {
  const { f, calls } = payFetcher();
  const r = await applyPayment(
    CFG,
    pay({ applications: [{ invoiceNumber: "NOPE", amount: 100 }] }),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100 } }),
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "invoice-unresolved");
  assertEquals(postCount(calls), 0);
});

Deno.test("applyPayment: an unknown invoiceId fails closed (invoice-unresolved) [PAY-8]", async () => {
  const { f, calls } = payFetcher();
  const r = await applyPayment(
    CFG,
    pay({ applications: [{ invoiceId: "inv-nope", amount: 100 }] }),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100 } }),
  );
  assertEquals(r.reason, "invoice-unresolved");
  assertEquals(postCount(calls), 0);
});

Deno.test("applyPayment: an ambiguous invoiceNumber fails closed (invoice-unresolved) [PAY-8]", async () => {
  const { f, calls } = payFetcher();
  const r = await applyPayment(
    CFG,
    pay(),
    false,
    f,
    new Set(),
    idx({ "Ja-002": "ambiguous" }),
  );
  assertEquals(r.reason, "invoice-unresolved");
  assertEquals(postCount(calls), 0);
});

// (9) balance guard ----------------------------------------------------------
Deno.test("applyPayment: an amount over the balance skips over-apply, NO POST [PAY-9]", async () => {
  const { f, calls } = payFetcher();
  const r = await applyPayment(
    CFG,
    pay({ applications: [{ invoiceNumber: "Ja-002", amount: 150 }] }),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" } }),
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "over-apply");
  assertEquals(postCount(calls), 0);
});

Deno.test("applyPayment: a within-tolerance overpay (<=0.01) is allowed [PAY-9]", async () => {
  const { f } = payFetcher({ createdId: "pay-new" });
  const r = await applyPayment(
    CFG,
    pay({ applications: [{ invoiceNumber: "Ja-002", amount: 100.01 }] }),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" } }),
  );
  assertEquals(r.action, "created");
});

Deno.test("applyPayment: an already-paid target (balance 0) skips already-paid, NO POST [PAY-9]", async () => {
  const { f, calls } = payFetcher();
  const r = await applyPayment(
    CFG,
    pay(),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 0, clientId: "cli1" } }),
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "already-paid");
  assertEquals(postCount(calls), 0);
});

// (10) blank dedup key -------------------------------------------------------
Deno.test("applyPayment: a blank transactionReference skips + never calls ?filter= with '' [PAY-10]", async () => {
  const { f, calls } = payFetcher();
  const r = await applyPayment(
    CFG,
    pay({ transactionReference: "   " }),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100 } }),
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "blank-dedup-key");
  assertEquals(calls.length, 0); // no dedup GET, no POST — never ?filter= with ''
});

Deno.test("applyPayments: a blank ref becomes a durable error row [PAY-10]", async () => {
  const { f } = applyFetcher({
    invoices: [{ id: "inv-2", number: "Ja-002", balance: 100 }],
  });
  const { errs } = await runApplyPayments(
    [pay({ transactionReference: "" })],
    f,
    false,
  );
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(erows[0].error, "blank-dedup-key");
});

// (11) real create -----------------------------------------------------------
Deno.test("applyPayment: a real create sends mandatory headers + Content-Type, returns the id, target reads Paid after [PAY-11]", async () => {
  let paid = false;
  const calls: WFetchRec[] = [];
  const f: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST") {
      paid = true; // IN derives Paid once the payment covers the balance
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ data: { id: "pay-77" } }),
      });
    }
    if (u.pathname.endsWith("/invoices/inv-2")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          Promise.resolve({
            data: {
              id: "inv-2",
              balance: paid ? 0 : 100,
              status_id: paid ? 4 : 2,
            },
          }),
      });
    }
    // /payments dedup GET → empty.
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve({
          data: [],
          meta: { pagination: { current_page: 1, total_pages: 1 } },
        }),
    });
  };
  const r = await applyPayment(
    CFG,
    pay(),
    false,
    f,
    new Set(),
    idx({ "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" } }),
  );
  assertEquals(r.action, "created");
  assertEquals(r.paymentId, "pay-77");
  const post = calls.find((c) => c.method === "POST")!;
  const h = post.headers as Record<string, string>;
  assertEquals(h["X-API-TOKEN"], "SEKRIT");
  assertEquals(h["X-Requested-With"], "XMLHttpRequest");
  assertEquals(h["Accept"], "application/json");
  assertEquals(h["Content-Type"], "application/json");
  assertEquals(new URL(post.url).pathname.endsWith("/payments"), true);
  // Integration-style: the target invoice now reads balance 0 / status Paid.
  const after = await inFetch(CFG, "GET", "invoices/inv-2", {}, f);
  const inv = after.data as Record<string, unknown>;
  assertEquals(inv.balance, 0);
  assertEquals(inv.status_id, 4);
});

// (12) snapshot shapes + errors flushed at zero -------------------------------
Deno.test("applyPayments: persists paymentSync (rows + dryRun) AND flushes paymentSyncErrors even at zero errors [PAY-12]", async () => {
  const { f } = applyFetcher({
    invoices: [{
      id: "inv-2",
      number: "Ja-002",
      balance: 100,
      client_id: "cli1",
    }],
  });
  const { sync, errs } = await runApplyPayments([pay()], f, true);
  assertEquals(Array.isArray(sync.data.rows), true);
  assertEquals(typeof sync.data.dryRun, "boolean");
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-create");
  assertEquals(rows[0].appliedInvoiceIds, ["inv-2"]);
  assertEquals(rows[0].amount, 100);
  // paymentSyncErrors is flushed ALWAYS (even with zero errors).
  assertEquals(Array.isArray(errs.data.rows), true);
  assertEquals((errs.data.rows as unknown[]).length, 0);
});

Deno.test("applyPayments: syncScope names per-scope resources and self-describes scope [PAY-12]", async () => {
  const { f } = applyFetcher({
    invoices: [{
      id: "inv-2",
      number: "Ja-002",
      balance: 100,
      client_id: "cli1",
    }],
  });
  const { sync, errs } = await runApplyPayments([pay()], f, true, "bt-jul");
  assertEquals(sync.name, "paymentSync--bt-jul");
  assertEquals(errs.name, "paymentSyncErrors--bt-jul");
  assertEquals(sync.data.scope, "bt-jul");
});

// buildInvoiceIndex ----------------------------------------------------------
Deno.test("buildInvoiceIndex: indexes live invoices by number, collapses duplicates to ambiguous [PAY-idx]", async () => {
  const { f } = applyFetcher({
    invoices: [
      { id: "inv-2", number: "Ja-002", balance: 100 },
      { id: "inv-3", number: "Ja-003", balance: 200 },
      { id: "inv-9", number: "Ja-003", balance: 5 }, // duplicate live number
    ],
  });
  const index = await buildInvoiceIndex(CFG, f);
  assertEquals(index.get("Ja-002"), { id: "inv-2", balance: 100 });
  assertEquals(index.get("Ja-003"), "ambiguous");
});

// ===========================================================================
// Review-round fixes on the payment-apply path (PAY-REV-1..6).
// ===========================================================================

// PAY-REV-1 / PAY-REV-4 — the payments dedup GET must be TRASH-INCLUSIVE so a
// soft-deleted payment with the same transaction_reference is still found (no
// duplicate POST), mirroring upsertExpense's trash-inclusive dedup. CFG has
// withTrashed:false, so this fails against the pre-fix (trash-exclusive) code.
Deno.test("applyPayment: dedup GET is trash-inclusive regardless of cfg.withTrashed [PAY-REV-1]", async () => {
  const index = idx({
    "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" },
  });
  const { f, calls } = payFetcher();
  await applyPayment(CFG, pay(), false, f, new Set(), index);
  const get = calls.find((c) => (c.method ?? "GET") === "GET")!;
  assertEquals(get.url.includes("with_trashed=true"), true);
});

Deno.test("applyPayment: a SOFT-DELETED payment with the same ref still skips already-exists, NO POST [PAY-REV-1]", async () => {
  const index = idx({
    "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" },
  });
  // The dedup page returns a trashed row (archived_at set) — only visible
  // because with_trashed=true was forced onto the query.
  const { f, calls } = payFetcher({
    existingByPage: [[{
      id: "pay-old",
      transaction_reference: "BT-001",
      archived_at: "2026-07-10",
    }]],
  });
  const r = await applyPayment(CFG, pay(), false, f, new Set(), index);
  assertEquals(r.reason, "already-exists");
  assertEquals(r.paymentId, "pay-old");
  assertEquals(postCount(calls), 0);
});

// PAY-REV-2 — the balance guard must be CUMULATIVE within the batch.
// (a) Intra-payment: two applications to ONE invoice in a single PaymentInput.
Deno.test("applyPayment: two applications to ONE invoice can't sum past its balance — over-apply, NO POST [PAY-REV-2]", async () => {
  const index = idx({
    "Ja-002": { id: "inv-2", balance: 100, clientId: "cli1" },
  });
  const { f, calls } = payFetcher();
  const r = await applyPayment(
    CFG,
    pay({
      applications: [
        { invoiceNumber: "Ja-002", amount: 60 },
        { invoiceNumber: "Ja-002", amount: 60 }, // 60+60 > 100 → over-apply
      ],
    }),
    false,
    f,
    new Set(),
    index,
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "over-apply");
  assertEquals(postCount(calls), 0);
});

// (b) Inter-payment: two payments (different refs) against ONE invoice. The
// first fully consumes the balance; the second must over-apply — the shared
// index balance is updated after the first create. Pre-fix (once-prefetched,
// never-updated balance) the second passes and issues a SECOND POST.
Deno.test("applyPayments: two payments (different refs) to ONE invoice — second over-applies, ONE POST [PAY-REV-2]", async () => {
  const { f, calls } = applyFetcher({
    invoices: [{
      id: "inv-2",
      number: "Ja-002",
      balance: 100,
      client_id: "cli1",
    }],
  });
  const { sync, errs } = await runApplyPayments(
    [
      pay({
        transactionReference: "BT-1",
        applications: [{ invoiceNumber: "Ja-002", amount: 100 }],
      }),
      pay({
        transactionReference: "BT-2",
        applications: [{ invoiceNumber: "Ja-002", amount: 100 }],
      }),
    ],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "created");
  assertEquals(rows[1].action, "skip");
  assertEquals(rows[1].reason, "over-apply");
  assertEquals(postCount(calls), 1); // exactly ONE create
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(erows[0].error, "over-apply");
});

// PAY-REV-6 — a payment must never settle an invoice owned by a DIFFERENT
// client. The resolved invoice carries client_id "cliB"; the payment is for
// "cli1" → skip invoice-client-mismatch, NO POST. Pre-fix (no client on the
// index entry) it would resolve and POST.
Deno.test("applyPayment: an invoice owned by another client fails closed (invoice-client-mismatch), NO POST [PAY-REV-6]", async () => {
  const index = idx({ "Ja-002": { id: "inv-2", balance: 100 } });
  // Give the entry a foreign clientId (idx() helper omits it by default).
  (index.get("Ja-002") as { clientId?: string }).clientId = "cliB";
  const { f, calls } = payFetcher();
  const r = await applyPayment(
    CFG,
    pay({
      clientId: "cli1",
      applications: [{ invoiceNumber: "Ja-002", amount: 100 }],
    }),
    false,
    f,
    new Set(),
    index,
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "invoice-client-mismatch");
  assertEquals(postCount(calls), 0);
});

Deno.test("applyPayments: a cross-client application becomes a durable error row [PAY-REV-6]", async () => {
  const { f, calls } = applyFetcher({
    invoices: [{
      id: "inv-2",
      number: "Ja-002",
      balance: 100,
      client_id: "cliB",
    }],
  });
  const { sync, errs } = await runApplyPayments(
    [
      pay({
        clientId: "cli1",
        applications: [{ invoiceNumber: "Ja-002", amount: 100 }],
      }),
    ],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].reason, "invoice-client-mismatch");
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(erows[0].error, "invoice-client-mismatch");
  assertEquals(postCount(calls), 0);
});

// PAY-REV-7 — the client cross-check must FAIL CLOSED when the resolved invoice's
// owning client cannot be confirmed (the index entry carries no clientId). A
// distinct reason `invoice-client-unverified` separates "couldn't verify" from
// the "wrong client" mismatch. Pre-fix (guard skipped when clientId was null)
// this resolved and POSTed a payment against an unattributable invoice.
Deno.test("applyPayment: an invoice with no known client fails closed (invoice-client-unverified), NO POST [PAY-REV-7]", async () => {
  // idx() omits clientId by default → the entry's owning client is unverifiable.
  const index = idx({ "Ja-002": { id: "inv-2", balance: 100 } });
  const { f, calls } = payFetcher();
  const r = await applyPayment(
    CFG,
    pay({
      clientId: "cli1",
      applications: [{ invoiceNumber: "Ja-002", amount: 100 }],
    }),
    false,
    f,
    new Set(),
    index,
  );
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "invoice-client-unverified");
  assertEquals(r.paymentId, null);
  assertEquals(r.appliedInvoiceIds, []);
  assertEquals(postCount(calls), 0);
});

Deno.test("applyPayments: an unverifiable-client application becomes a durable error row [PAY-REV-7]", async () => {
  // Live invoice row carries NO client_id → the index entry has no clientId.
  const { f, calls } = applyFetcher({
    invoices: [{ id: "inv-2", number: "Ja-002", balance: 100 }],
  });
  const { sync, errs } = await runApplyPayments(
    [
      pay({
        clientId: "cli1",
        applications: [{ invoiceNumber: "Ja-002", amount: 100 }],
      }),
    ],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].reason, "invoice-client-unverified");
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(erows[0].error, "invoice-client-unverified");
  assertEquals(postCount(calls), 0);
});

// PAY-REV-5 — the invoice prefetch must exclude trashed invoices INDEPENDENT of
// cfg.withTrashed. Even with the shared cfg globally enabling trashed rows, the
// GET must not request them. Pre-fix (shared cfg) it appends with_trashed=true.
Deno.test("buildInvoiceIndex: trash-exclusion is independent of cfg.withTrashed [PAY-REV-5]", async () => {
  const trashedCfg = { ...CFG, withTrashed: true } as unknown as Cfg;
  const { f, calls } = applyFetcher({
    invoices: [{
      id: "inv-2",
      number: "Ja-002",
      balance: 100,
      client_id: "cli1",
    }],
  });
  const index = await buildInvoiceIndex(trashedCfg, f);
  const get = calls.find((c) => (c.method ?? "GET") === "GET")!;
  assertEquals(get.url.includes("with_trashed=true"), false);
  assertEquals(index.get("Ja-002"), {
    id: "inv-2",
    balance: 100,
    clientId: "cli1",
  });
});

// PAY-REV-3 — a prefetch failure must still flush BOTH audits (with a durable
// prefetch-failure error row) and write NO money. Pre-fix the prefetch ran
// outside the try/finally, so a throw wrote neither resource.
Deno.test("applyPayments: a prefetch failure still flushes both audits + prefetch error, NO POST [PAY-REV-3]", async () => {
  const calls: WFetchRec[] = [];
  const f: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    // The invoice prefetch GET fails (HTTP 500 → inFetch throws).
    return Promise.resolve({
      ok: false,
      status: 500,
      statusText: "Server Error",
      json: () => Promise.resolve({}),
    });
  };
  const { context, writes } = stubContext();
  await assertRejects(() =>
    model.methods.applyPayments.execute(
      // deno-lint-ignore no-explicit-any
      { payments: [pay()], dryRun: false, _fetch: f } as any,
      context,
    )
  );
  const sync = writes.find((w) => w.spec === "paymentSync");
  const errs = writes.find((w) => w.spec === "paymentSyncErrors");
  assertEquals(sync !== undefined, true); // paymentSync flushed
  assertEquals(errs !== undefined, true); // paymentSyncErrors flushed
  const erows = errs!.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(
    (erows[0].error as string).startsWith("invoice-prefetch-failed"),
    true,
  );
  assertEquals(postCount(calls), 0); // no money written
});

// ===========================================================================
// Mark-sent path (design/specs/invoiceninja-mark-sent.spec.md).
// Injected FetchLike, bugzilla pattern. Covers the 8-point test contract.
// ===========================================================================

/**
 * A fake {@link FetchLike} for the mark-sent fan-out: serves the /invoices index
 * GET (used for BOTH the prefetch and the read-back), and the POST /invoices/bulk
 * `mark_sent`. `invoices` is the initial live list; on a successful bulk POST the
 * posted ids flip to `flipToOnSend` (default 2 = Sent) so the read-back GET
 * reflects the transition (mirrors PAY-11's `paid` flag). `throwBulk` makes the
 * bulk POST fail (HTTP 500 -> inFetch throws).
 */
function markSentFetcher(
  opts: {
    invoices?: Array<Record<string, unknown>>;
    flipToOnSend?: number;
    throwBulk?: boolean;
  } = {},
): { f: FetchLike; calls: WFetchRec[] } {
  const calls: WFetchRec[] = [];
  let sentIds: string[] = [];
  const f: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    if ((init?.method ?? "GET") === "POST") {
      if (opts.throwBulk) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Server Error",
          json: () => Promise.resolve({}),
        });
      }
      const body = init?.body
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};
      sentIds = Array.isArray(body.ids) ? body.ids as string[] : [];
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ data: sentIds.map((id) => ({ id })) }),
      });
    }
    // GET /invoices — reflect any ids already marked sent this run.
    const flip = opts.flipToOnSend ?? 2;
    const data = (opts.invoices ?? []).map((r) =>
      sentIds.includes(r.id as string) ? { ...r, status_id: flip } : r
    );
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

/** Run the fan-out and return the persisted markSentSync/markSentSyncErrors writes. */
async function runMarkSent(
  invoices: Array<Record<string, unknown>>,
  f: FetchLike,
  dryRun: boolean,
  syncScope?: string,
) {
  const { context, writes } = stubContext();
  await model.methods.markSent.execute(
    // deno-lint-ignore no-explicit-any
    { invoices, dryRun, ...(syncScope ? { syncScope } : {}), _fetch: f } as any,
    context,
  );
  const sync = writes.find((w) => w.spec === "markSentSync")!;
  const errs = writes.find((w) => w.spec === "markSentSyncErrors")!;
  return { sync, errs, writes };
}

// (1) body shape = {action:'mark_sent', ids}, no email/notify field ------------
Deno.test("mapMarkSentBody: {action:'mark_sent', ids} only, no email/notify field [MS-1]", () => {
  const body = mapMarkSentBody(["inv-1", "inv-2"]);
  assertEquals(body, { action: "mark_sent", ids: ["inv-1", "inv-2"] });
  assertEquals(Object.keys(body).sort(), ["action", "ids"]);
  assertEquals("send_email" in body, false);
  assertEquals("email_invoice" in body, false);
  assertEquals("email" in body, false);
});

Deno.test("markSent: the live bulk POST body is mark_sent + ids only, no email/notify [MS-1]", async () => {
  const { f, calls } = markSentFetcher({
    invoices: [{ id: "inv-1", number: "INV-1", status_id: 1 }],
  });
  await runMarkSent([{ invoiceNumber: "INV-1" }], f, false);
  const post = calls.find((c) => c.method === "POST")!;
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assertEquals(body.action, "mark_sent");
  assertEquals(body.ids, ["inv-1"]);
  assertEquals(Object.keys(body).sort(), ["action", "ids"]);
  assertEquals("send_email" in body, false);
  assertEquals("email_invoice" in body, false);
});

// (2) dry-run -> would-send, NO POST ------------------------------------------
Deno.test("markSent: dry-run yields would-send and NEVER POSTs [MS-2]", async () => {
  const { f, calls } = markSentFetcher({
    invoices: [{ id: "inv-1", number: "INV-1", status_id: 1 }],
  });
  const { sync } = await runMarkSent([{ invoiceNumber: "INV-1" }], f, true);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "would-send");
  assertEquals(rows[0].invoiceId, "inv-1");
  assertEquals(rows[0].statusId, 1);
  assertEquals(postCount(calls), 0); // never POSTs in dry-run
});

// (3) idempotency: a re-run of Sent invoices -> all already-sent, no POST ------
Deno.test("markSent: a re-run of already-Sent invoices is all already-sent, NO POST [MS-3]", async () => {
  const { f, calls } = markSentFetcher({
    invoices: [
      { id: "inv-1", number: "INV-1", status_id: 2 },
      { id: "inv-2", number: "INV-2", status_id: 2 },
    ],
  });
  const { sync } = await runMarkSent(
    [{ invoiceNumber: "INV-1" }, { invoiceNumber: "INV-2" }],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.every((r) => r.action === "skip"), true);
  assertEquals(rows.every((r) => r.reason === "already-sent"), true);
  assertEquals(postCount(calls), 0); // idempotent: nothing eligible, no POST
});

// (4) classify Draft/Sent/Partial/Paid/other ---------------------------------
Deno.test("markSent: classifies Draft->eligible, Sent/Partial->already-sent, Paid->already-paid, other->not-draft [MS-4]", async () => {
  const { f, calls } = markSentFetcher({
    invoices: [
      { id: "d", number: "D", status_id: 1 },
      { id: "s", number: "S", status_id: 2 },
      { id: "p", number: "P", status_id: 3 },
      { id: "pd", number: "PD", status_id: 4 },
      { id: "c", number: "C", status_id: 5 },
    ],
  });
  const { sync } = await runMarkSent(
    [
      { invoiceNumber: "D" },
      { invoiceNumber: "S" },
      { invoiceNumber: "P" },
      { invoiceNumber: "PD" },
      { invoiceNumber: "C" },
    ],
    f,
    true, // dryRun: classification is visible without a write
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  const byKey = Object.fromEntries(rows.map((r) => [r.dedupKey, r]));
  assertEquals(byKey["D"].action, "would-send");
  assertEquals(byKey["S"].reason, "already-sent");
  assertEquals(byKey["P"].reason, "already-sent");
  assertEquals(byKey["PD"].reason, "already-paid");
  assertEquals(byKey["C"].reason, "not-draft");
  assertEquals(postCount(calls), 0);
});

// (5) resolve by invoiceNumber -> hashid; unresolved -> skip unresolved -------
Deno.test("markSent: resolves invoiceNumber to hashid; an unresolved number skips unresolved, NO POST [MS-5]", async () => {
  const { f, calls } = markSentFetcher({
    invoices: [{ id: "inv-1", number: "INV-1", status_id: 1 }],
  });
  const { sync, errs } = await runMarkSent(
    [{ invoiceNumber: "NOPE" }],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "skip");
  assertEquals(rows[0].reason, "unresolved");
  assertEquals(rows[0].invoiceId, null);
  assertEquals(rows[0].statusId, null);
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(erows[0].error, "unresolved");
  assertEquals(postCount(calls), 0); // nothing resolved, no POST
});

Deno.test("markSent: resolves an explicit invoiceId to the bulk POST ids [MS-5]", async () => {
  const { f, calls } = markSentFetcher({
    invoices: [{ id: "inv-1", number: "INV-1", status_id: 1 }],
  });
  const { sync } = await runMarkSent([{ invoiceId: "inv-1" }], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "sent");
  assertEquals(rows[0].invoiceId, "inv-1");
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals((JSON.parse(post.body!) as { ids: string[] }).ids, ["inv-1"]);
});

Deno.test("markSent: an ambiguous invoiceNumber fails closed (skip unresolved), NO POST [MS-5]", async () => {
  const { f, calls } = markSentFetcher({
    invoices: [
      { id: "inv-1", number: "DUP", status_id: 1 },
      { id: "inv-2", number: "DUP", status_id: 1 }, // duplicate live number
    ],
  });
  const { sync } = await runMarkSent([{ invoiceNumber: "DUP" }], f, false);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].reason, "unresolved");
  assertEquals(postCount(calls), 0);
});

// (6) real write: POST /invoices/bulk headers; read-back status_id 2; sent ----
Deno.test("markSent: a real write POSTs /invoices/bulk with mandatory headers + Content-Type; read-back shows status_id 2; emits sent [MS-6]", async () => {
  const { f, calls } = markSentFetcher({
    invoices: [{ id: "inv-1", number: "INV-1", status_id: 1 }],
  });
  const { sync } = await runMarkSent([{ invoiceNumber: "INV-1" }], f, false);
  const post = calls.find((c) => c.method === "POST")!;
  const h = post.headers as Record<string, string>;
  assertEquals(h["X-API-TOKEN"], "SEKRIT");
  assertEquals(h["X-Requested-With"], "XMLHttpRequest");
  assertEquals(h["Accept"], "application/json");
  assertEquals(h["Content-Type"], "application/json");
  assertEquals(new URL(post.url).pathname.endsWith("/invoices/bulk"), true);
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].action, "sent");
  assertEquals(rows[0].invoiceId, "inv-1");
  assertEquals(rows[0].statusId, 2); // read-back confirmed Sent
  // Exactly one bulk POST for the fan-out (no per-id calls).
  assertEquals(postCount(calls), 1);
});

// (7) a mid-batch resolve failure never aborts the batch ----------------------
Deno.test("markSent: a mid-batch unresolved target flushes both audits + errors[]; the batch is not aborted [MS-7]", async () => {
  const { f, calls } = markSentFetcher({
    invoices: [
      { id: "inv-1", number: "INV-1", status_id: 1 },
      { id: "inv-2", number: "INV-2", status_id: 1 },
    ],
  });
  const { sync, errs } = await runMarkSent(
    [
      { invoiceNumber: "NOPE" }, // unresolved (mid-batch failure)
      { invoiceNumber: "INV-1" }, // eligible
      { invoiceNumber: "INV-2" }, // eligible
    ],
    f,
    false,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  const byKey = Object.fromEntries(rows.map((r) => [r.dedupKey, r]));
  assertEquals(byKey["NOPE"].reason, "unresolved");
  // The batch continued past the failure — both eligibles were sent.
  assertEquals(byKey["INV-1"].action, "sent");
  assertEquals(byKey["INV-2"].action, "sent");
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(erows[0].error, "unresolved");
  // Only the two resolved eligibles went into the single bulk POST.
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(
    (JSON.parse(post.body!) as { ids: string[] }).ids,
    ["inv-1", "inv-2"],
  );
  assertEquals(postCount(calls), 1);
});

Deno.test("markSent: a bulk POST failure flushes both audits + a durable error row per eligible id, NO abort [MS-7]", async () => {
  const { f } = markSentFetcher({
    invoices: [
      { id: "inv-1", number: "INV-1", status_id: 1 },
      { id: "inv-2", number: "INV-2", status_id: 1 },
    ],
    throwBulk: true,
  });
  const { sync, errs } = await runMarkSent(
    [{ invoiceNumber: "INV-1" }, { invoiceNumber: "INV-2" }],
    f,
    false,
  );
  // Both audits are flushed even though the write threw.
  assertEquals(sync !== undefined, true);
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 2); // one per eligible id
  assertEquals(
    erows.every((r) => (r.error as string).includes("HTTP 500")),
    true,
  );
});

// (8) snapshot shapes + errors flushed at zero -------------------------------
Deno.test("markSent: persists markSentSync (rows + dryRun) AND flushes markSentSyncErrors even at zero errors [MS-8]", async () => {
  const { f } = markSentFetcher({
    invoices: [{ id: "inv-1", number: "INV-1", status_id: 1 }],
  });
  const { sync, errs } = await runMarkSent(
    [{ invoiceNumber: "INV-1" }],
    f,
    true,
  );
  assertEquals(Array.isArray(sync.data.rows), true);
  assertEquals(typeof sync.data.dryRun, "boolean");
  assertEquals(sync.data.dryRun, true);
  assertEquals(typeof sync.data.retrievedAt, "string");
  // markSentSyncErrors is flushed ALWAYS (even with zero errors).
  assertEquals(Array.isArray(errs.data.rows), true);
  assertEquals((errs.data.rows as unknown[]).length, 0);
});

Deno.test("markSent: syncScope names per-scope resources and self-describes scope [MS-8]", async () => {
  const { f } = markSentFetcher({
    invoices: [{ id: "inv-1", number: "INV-1", status_id: 1 }],
  });
  const { sync, errs } = await runMarkSent(
    [{ invoiceNumber: "INV-1" }],
    f,
    true,
    "jul-backfill",
  );
  assertEquals(sync.name, "markSentSync--jul-backfill");
  assertEquals(errs.name, "markSentSyncErrors--jul-backfill");
  assertEquals(sync.data.scope, "jul-backfill");
});

// buildMarkSentIndex ---------------------------------------------------------
Deno.test("buildMarkSentIndex: indexes live invoices by number with statusId, collapses duplicates to ambiguous [MS-idx]", async () => {
  const { f } = markSentFetcher({
    invoices: [
      { id: "inv-2", number: "Ja-002", status_id: 1 },
      { id: "inv-3", number: "Ja-003", status_id: 2 },
      { id: "inv-9", number: "Ja-003", status_id: 4 }, // duplicate live number
    ],
  });
  const index = await buildMarkSentIndex(CFG, f);
  assertEquals(index.get("Ja-002"), { id: "inv-2", statusId: 1 });
  assertEquals(index.get("Ja-003"), "ambiguous");
});

Deno.test("buildMarkSentIndex: trash-exclusion is independent of cfg.withTrashed [MS-idx]", async () => {
  const trashedCfg = { ...CFG, withTrashed: true } as unknown as Cfg;
  const { f, calls } = markSentFetcher({
    invoices: [{ id: "inv-1", number: "INV-1", status_id: 1 }],
  });
  await buildMarkSentIndex(trashedCfg, f);
  // The prefetch clones cfg with withTrashed:false, so no with_trashed pair is
  // ever sent — a soft-deleted invoice can never be a mark-sent target.
  const get = calls.find((c) => (c.method ?? "GET") === "GET")!;
  assertEquals(get.url.includes("with_trashed"), false);
});

// prefetch failure (mirrors PAY-REV-3) ---------------------------------------
Deno.test("markSent: a prefetch failure still flushes both audits + a prefetch error, NO POST [MS-prefetch]", async () => {
  const calls: WFetchRec[] = [];
  const f: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    // The invoice prefetch GET fails (HTTP 500 -> inFetch throws).
    return Promise.resolve({
      ok: false,
      status: 500,
      statusText: "Server Error",
      json: () => Promise.resolve({}),
    });
  };
  const { context, writes } = stubContext();
  await assertRejects(() =>
    model.methods.markSent.execute(
      // deno-lint-ignore no-explicit-any
      {
        invoices: [{ invoiceNumber: "INV-1" }],
        dryRun: false,
        _fetch: f,
      } as any,
      context,
    )
  );
  const sync = writes.find((w) => w.spec === "markSentSync");
  const errs = writes.find((w) => w.spec === "markSentSyncErrors");
  assertEquals(sync !== undefined, true); // markSentSync flushed
  assertEquals(errs !== undefined, true); // markSentSyncErrors flushed
  const erows = errs!.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(
    (erows[0].error as string).startsWith("invoice-prefetch-failed"),
    true,
  );
  assertEquals(postCount(calls), 0); // no status written
});

// ---------------------------------------------------------------------------
// Company settings surface (invoiceninja-company-settings.spec sec 7)
//
// LIVE-ONLY items (validated by the sandbox probe on your-instance.example, NOT by
// these stubbed tests): the real custom_fields/settings field names + the
// "Label|type" encoding (CONFIRMED task1..4/invoice1.. etc, e.g.
// "estimated|single_line_text"); the update verb (CONFIRMED PUT - no PATCH);
// merge-vs-replace (CONFIRMED IN REPLACES custom_fields/settings wholesale - a
// partial PUT wiped an unmanaged sibling slot, so the full round-trip below is
// mandatory); and the slot backing task custom_value1 (CONFIRMED custom_fields.
// task1, relabeled "estimated" on the real company).
// ---------------------------------------------------------------------------

/**
 * A fake {@link FetchLike} for the company-settings surface: serves GET
 * /companies (auto-resolve list), GET /companies/{id} (single record), and PUT
 * /companies/{id} (records the body; HTTP 500 when `throwPut`).
 */
function companyFetcher(
  opts: {
    companies?: Array<Record<string, unknown>>;
    company?: Record<string, unknown>;
    throwPut?: boolean;
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
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      if (opts.throwPut) {
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
        json: () => Promise.resolve({ data: opts.company ?? {} }),
      });
    }
    const isById = /\/companies\/[^/]+$/.test(new URL(url).pathname);
    // The membership list (GET /companies) defaults to the single `company`'s id
    // so the CS-REV-1 ownership check passes without every test spelling it out.
    const companyId = opts.company?.id;
    const list = opts.companies ??
      (typeof companyId === "string" ? [{ id: companyId }] : []);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve(
          isById ? { data: opts.company ?? {} } : { data: list },
        ),
    });
  };
  return { f, calls };
}

/** Drive reconcileCompanySettings and pull the two flushed resources. */
async function runReconcile(
  args: Record<string, unknown>,
  f: FetchLike,
) {
  const { context, writes } = stubContext();
  await model.methods.reconcileCompanySettings.execute(
    // deno-lint-ignore no-explicit-any
    { ...args, _fetch: f } as any,
    context,
  );
  const sync = writes.find((w) => w.spec === "companySettingsSync")!;
  const errs = writes.find((w) => w.spec === "companySettingsSyncErrors")!;
  return { sync, errs, writes };
}

// --- normalizer (3 cases) ----------------------------------------------------
Deno.test("normalizeCompanySettings: lifts custom_fields task1..4 labels + strips the |type suffix [CS-01]", () => {
  const n = normalizeCompanySettings({
    id: "co1",
    custom_fields: {
      task1: "Estimated|single_line_text",
      task2: "external_id|single_line_text",
      invoice1: "Upwork ID|switch",
    },
    settings: { currency_id: "1", date_format_id: "2" },
  });
  assertEquals(n.companyId, "co1");
  assertEquals(n.customFields.task[0], {
    label: "Estimated",
    type: "single_line_text",
  });
  assertEquals(n.customFields.task[1], {
    label: "external_id",
    type: "single_line_text",
  });
  assertEquals(n.customFields.task[2], { label: null, type: null });
  assertEquals(n.customFields.task[3], { label: null, type: null });
  assertEquals(n.customFields.invoice[0], {
    label: "Upwork ID",
    type: "switch",
  });
});

Deno.test("normalizeCompanySettings: surfaces currencyId/dateFormatId, nulls absent; numberFormat is NOT surfaced (CS-REV-3) [CS-02]", () => {
  const present = normalizeCompanySettings({
    id: "co1",
    settings: { currency_id: "3", date_format_id: "4", number_format: "x" },
  });
  assertEquals(present.currencyId, "3");
  assertEquals(present.dateFormatId, "4");
  // CS-REV-3: number_format is dropped from the surface (inert on this IN build).
  assertEquals("numberFormat" in present, false);
  const absent = normalizeCompanySettings({ id: "co1", settings: {} });
  assertEquals(absent.currencyId, null);
  assertEquals(absent.dateFormatId, null);
  // CS-REV-4: the pure normalizer no longer returns the raw response.
  assertEquals("raw" in present, false);
  // A wholly absent settings/custom_fields object is tolerated (-> nulls/[]).
  const bare = normalizeCompanySettings({ id: "co1" });
  assertEquals(bare.currencyId, null);
  assertEquals(bare.customFields.task[0], { label: null, type: null });
});

Deno.test("splitCustomField/encodeCustomField: a plain Label (no pipe) yields label with null type; encode round-trips [CS-03]", () => {
  assertEquals(splitCustomField("PlainLabel"), {
    label: "PlainLabel",
    type: null,
  });
  assertEquals(splitCustomField("L|switch"), { label: "L", type: "switch" });
  assertEquals(splitCustomField(""), { label: null, type: null });
  assertEquals(splitCustomField(undefined), { label: null, type: null });
  // A dropdown option list uses commas (no extra pipe) - the type is preserved.
  assertEquals(splitCustomField("Priority|Low,Med,High"), {
    label: "Priority",
    type: "Low,Med,High",
  });
  assertEquals(
    encodeCustomField("New", "single_line_text"),
    "New|single_line_text",
  );
  assertEquals(encodeCustomField("New", null), "New");
});

// --- getCompanySettings ------------------------------------------------------
Deno.test("getCompanySettings: GET /companies/{id}, snapshots normalized labels + currency [CS-04]", async () => {
  const { f, calls } = companyFetcher({
    company: {
      id: "Wpmbk5ezJn",
      custom_fields: { task1: "Estimated|single_line_text" },
      settings: { currency_id: "1", date_format_id: "1" },
    },
  });
  const { context, writes } = stubContext();
  await model.methods.getCompanySettings.execute(
    // deno-lint-ignore no-explicit-any
    { companyId: "Wpmbk5ezJn", _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].spec, "companySettings");
  assertEquals(writes[0].name, "companySettings");
  const data = writes[0].data;
  assertEquals(
    (data.customFields as { task: Array<{ label: string | null }> }).task[0]
      .label,
    "Estimated",
  );
  assertEquals(data.currencyId, "1");
  // CS-REV-4: the persisted snapshot carries only normalized fields, never raw.
  assertEquals("raw" in data, false);
  // CS-REV-1: membership is always confirmed - GET /companies (list) then the
  // by-id GET.
  assertEquals(calls.length, 2);
  assertEquals(calls[0].url.endsWith("/companies"), true);
  assertEquals(calls[1].url.includes("/companies/Wpmbk5ezJn"), true);
});

Deno.test("getCompanySettings: scope arg writes companySettings--<scope> [CS-05]", async () => {
  const { f } = companyFetcher({ company: { id: "co1", settings: {} } });
  const { context, writes } = stubContext();
  await model.methods.getCompanySettings.execute(
    // deno-lint-ignore no-explicit-any
    { companyId: "co1", scope: "q3", _fetch: f } as any,
    context,
  );
  assertEquals(writes[0].name, "companySettings--q3");
});

Deno.test("getCompanySettings: rejects a path-traversal companyId at the charset boundary [CS-06]", () => {
  const schema = model.methods.getCompanySettings.arguments;
  assertEquals(schema.safeParse({ companyId: "Abc123" }).success, true);
  assertEquals(schema.safeParse({}).success, true); // optional -> auto-resolve
  assertEquals(schema.safeParse({ companyId: "../../users/5" }).success, false);
  assertEquals(schema.safeParse({ companyId: "a/b" }).success, false);
  assertEquals(schema.safeParse({ companyId: "" }).success, false);
});

Deno.test("getCompanySettings: auto-resolves companyId from GET /companies when absent [CS-07]", async () => {
  const { f, calls } = companyFetcher({
    companies: [{ id: "only1" }],
    company: { id: "only1", settings: { currency_id: "1" } },
  });
  const { context, writes } = stubContext();
  await model.methods.getCompanySettings.execute(
    // deno-lint-ignore no-explicit-any
    { _fetch: f } as any,
    context,
  );
  assertEquals(calls[0].url.endsWith("/companies"), true); // the resolve list
  assertEquals(calls[1].url.includes("/companies/only1"), true); // then by-id
  assertEquals(writes[0].data.companyId, "only1");
});

Deno.test("resolveCompanyId: fails loudly on a multi-company token, zero companies, or an invalid explicit id [CS-08]", async () => {
  await assertRejects(
    () =>
      resolveCompanyId(
        CFG,
        undefined,
        companyFetcher({ companies: [{ id: "a" }, { id: "b" }] }).f,
      ),
    Error,
    "owns 2 companies",
  );
  await assertRejects(
    () => resolveCompanyId(CFG, undefined, companyFetcher({ companies: [] }).f),
    Error,
    "no company",
  );
  // Charset gate throws BEFORE any fetch (undefined doFetch never used).
  await assertRejects(
    () => resolveCompanyId(CFG, "../../users/5", undefined),
    Error,
    "not a valid IN hashid",
  );
  // CS-REV-1: a valid-charset explicit id is confirmed present in the token's
  // company list before it is accepted.
  assertEquals(
    await resolveCompanyId(
      CFG,
      "Abc123",
      companyFetcher({ companies: [{ id: "Abc123" }] }).f,
    ),
    "Abc123",
  );
});

Deno.test("resolveCompanyId: rejects a valid-charset explicit id the token does not own (CS-REV-1) [CS-08b]", async () => {
  await assertRejects(
    () =>
      resolveCompanyId(
        CFG,
        "Zzz999",
        companyFetcher({ companies: [{ id: "Abc123" }] }).f,
      ),
    Error,
    "is not owned by this token",
  );
});

// --- reconcileCompanySettings ------------------------------------------------
Deno.test("reconcileCompanySettings: dry-run yields would-update rows and NO PUT hits the wire [CS-09]", async () => {
  const { f, calls } = companyFetcher({
    company: { id: "co1", custom_fields: { task1: "Old|single_line_text" } },
  });
  const { sync } = await runReconcile(
    {
      companyId: "co1",
      dryRun: true,
      desired: { customFields: { task: ["New"] } },
    },
    f,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].path, "custom_fields.task1");
  assertEquals(rows[0].current, "Old");
  assertEquals(rows[0].desired, "New");
  assertEquals(rows[0].changed, true);
  assertEquals(rows[0].action, "would-update");
  assertEquals(sync.data.applied, false);
  assertEquals(putCount(calls), 0);
});

Deno.test("reconcileCompanySettings: apply=false is the default (cfg.dryRun) - no PUT [CS-10]", async () => {
  const { f, calls } = companyFetcher({
    company: { id: "co1", custom_fields: { task1: "Old|single_line_text" } },
  });
  // dryRun omitted -> CFG.dryRun (true).
  const { sync } = await runReconcile(
    { companyId: "co1", desired: { customFields: { task: ["New"] } } },
    f,
  );
  assertEquals(sync.data.dryRun, true);
  assertEquals(
    (sync.data.rows as Array<Record<string, unknown>>)[0].action,
    "would-update",
  );
  assertEquals(putCount(calls), 0);
});

Deno.test("reconcileCompanySettings: an unchanged desired set is an in-sync no-op, never PUTs [CS-11]", async () => {
  const { f, calls } = companyFetcher({
    company: { id: "co1", custom_fields: { task1: "Same|single_line_text" } },
  });
  const { sync, errs } = await runReconcile(
    {
      companyId: "co1",
      dryRun: false,
      desired: { customFields: { task: ["Same"] } },
    },
    f,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows[0].changed, false);
  assertEquals(rows[0].action, "in-sync");
  assertEquals(sync.data.applied, false);
  assertEquals(putCount(calls), 0);
  // errors resource is flushed even when empty.
  assertEquals((errs.data.rows as unknown[]).length, 0);
});

Deno.test("reconcileCompanySettings: apply round-trips the FULL settings/custom_fields, mutating only target keys [CS-12]", async () => {
  const { f, calls } = companyFetcher({
    company: {
      id: "co1",
      custom_fields: {
        task1: "Old|single_line_text",
        task2: "Keep|switch",
        invoice1: "KeepInv",
      },
      settings: { currency_id: "1", date_format_id: "1", timezone_id: "15" },
    },
  });
  const { sync } = await runReconcile(
    {
      companyId: "co1",
      dryRun: false,
      desired: { customFields: { task: ["New"] } },
    },
    f,
  );
  const put = calls.find((c) => c.method === "PUT")!;
  const body = JSON.parse(put.body!) as {
    custom_fields: Record<string, unknown>;
    settings: Record<string, unknown>;
  };
  // The changed slot is relabeled and its type is PRESERVED from the live slot.
  assertEquals(body.custom_fields.task1, "New|single_line_text");
  // Unmanaged sibling slots survive verbatim (the partial-merge guard -
  // IN REPLACES the object wholesale, so a partial body would wipe these).
  assertEquals(body.custom_fields.task2, "Keep|switch");
  assertEquals(body.custom_fields.invoice1, "KeepInv");
  // settings round-trip the whole object (unmanaged timezone_id preserved).
  assertEquals(body.settings.timezone_id, "15");
  assertEquals(body.settings.currency_id, "1");
  assertEquals(sync.data.applied, true);
  assertEquals(
    (sync.data.rows as Array<Record<string, unknown>>)[0].action,
    "updated",
  );
  assertEquals(putCount(calls), 1);
});

Deno.test("reconcileCompanySettings: absent desired keys are never diffed or written [CS-13]", async () => {
  const { f, calls } = companyFetcher({
    company: {
      id: "co1",
      custom_fields: { task1: "Old" },
      settings: { currency_id: "1", date_format_id: "1" },
    },
  });
  // Only currencyId is desired (and already matches) - custom fields + date
  // format are absent, so they never appear as rows and never write.
  const { sync } = await runReconcile(
    { companyId: "co1", dryRun: false, desired: { currencyId: "1" } },
    f,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].path, "settings.currency_id");
  assertEquals(
    rows.some((r) => (r.path as string).startsWith("custom_fields")),
    false,
  );
  assertEquals(rows.some((r) => r.path === "settings.date_format_id"), false);
  assertEquals(putCount(calls), 0); // in-sync
});

Deno.test("reconcileCompanySettings: a null custom-field slot is left unmanaged [CS-14]", async () => {
  const { f } = companyFetcher({
    company: { id: "co1", custom_fields: { task1: "Old1", task2: "Old2" } },
  });
  const { sync } = await runReconcile(
    {
      companyId: "co1",
      dryRun: true,
      desired: { customFields: { task: [null, "New2"] } },
    },
    f,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  // Only slot 2 is diffed; slot 1 (null) is skipped entirely.
  assertEquals(rows.length, 1);
  assertEquals(rows[0].path, "custom_fields.task2");
  assertEquals(rows[0].desired, "New2");
});

Deno.test("reconcileCompanySettings: a PUT that throws is captured in companySettingsSyncErrors and both resources flush [CS-15]", async () => {
  const { f, calls } = companyFetcher({
    company: { id: "co1", custom_fields: { task1: "Old" } },
    throwPut: true,
  });
  const { sync, errs } = await runReconcile(
    {
      companyId: "co1",
      dryRun: false,
      desired: { customFields: { task: ["New"] } },
    },
    f,
  );
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals((erows[0].error as string).includes("HTTP 500"), true);
  assertEquals(erows[0].dryRun, false);
  // A failed PUT did NOT commit - applied false, and the row action reverts to
  // would-update (nothing was actually written).
  assertEquals(sync.data.applied, false);
  assertEquals(
    (sync.data.rows as Array<Record<string, unknown>>)[0].action,
    "would-update",
  );
  assertEquals(putCount(calls), 1); // the single attempt
  // Both resources were flushed (finally).
  assertEquals(sync.spec, "companySettingsSync");
  assertEquals(errs.spec, "companySettingsSyncErrors");
});

Deno.test("reconcileCompanySettings: syncScope names the per-scope resources; absent keeps bare names [CS-16]", async () => {
  const scoped = companyFetcher({ company: { id: "co1", settings: {} } });
  {
    const { context, writes } = stubContext();
    await model.methods.reconcileCompanySettings.execute(
      // deno-lint-ignore no-explicit-any
      {
        companyId: "co1",
        syncScope: "quarterly",
        desired: {},
        _fetch: scoped.f,
      } as any,
      context,
    );
    const names = writes.map((w) => w.name);
    assertEquals(names.includes("companySettingsSync--quarterly"), true);
    assertEquals(names.includes("companySettingsSyncErrors--quarterly"), true);
  }
  const bare = companyFetcher({ company: { id: "co1", settings: {} } });
  {
    const { context, writes } = stubContext();
    await model.methods.reconcileCompanySettings.execute(
      // deno-lint-ignore no-explicit-any
      { companyId: "co1", desired: {}, _fetch: bare.f } as any,
      context,
    );
    const names = writes.map((w) => w.name);
    assertEquals(names.includes("companySettingsSync"), true);
    assertEquals(names.includes("companySettingsSyncErrors"), true);
  }
});

// --- adversarial-review fixes (CS-REV-1..6) ----------------------------------

Deno.test("getCompanySettings: throws when GET /companies/{id} returns a different company id (CS-REV-1) [CS-17]", async () => {
  // Ownership check passes (co1 is owned) but IN acts on the token-bound company
  // and returns a DIFFERENT id - refuse to snapshot the wrong company.
  const { f } = companyFetcher({
    companies: [{ id: "co1" }],
    company: { id: "OTHER", settings: { currency_id: "1" } },
  });
  const { context } = stubContext();
  await assertRejects(
    () =>
      model.methods.getCompanySettings.execute(
        // deno-lint-ignore no-explicit-any
        { companyId: "co1", _fetch: f } as any,
        context,
      ),
    Error,
    "company id mismatch",
  );
});

Deno.test("reconcileCompanySettings: id mismatch is captured in companySettingsSyncErrors, no PUT (CS-REV-1) [CS-17b]", async () => {
  const { f, calls } = companyFetcher({
    companies: [{ id: "co1" }],
    company: { id: "OTHER", custom_fields: { task1: "Old" } },
  });
  const { sync, errs } = await runReconcile(
    {
      companyId: "co1",
      dryRun: false,
      desired: { customFields: { task: ["New"] } },
    },
    f,
  );
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(
    (erows[0].error as string).includes("company id mismatch"),
    true,
  );
  assertEquals(sync.data.applied, false);
  assertEquals(putCount(calls), 0);
});

Deno.test("reconcileCompanySettings: the PUT body omits top-level company columns (CS-REV-2: IN MERGES top-level) [CS-18]", async () => {
  // Live-verified (FakeCorp Wpmbk5ezJn, 2026-09-21): a settings-only PUT left
  // is_large/size_id/etc untouched, so top-level columns are omitted from the
  // body. This pins that omit - the body is EXACTLY {settings, custom_fields}.
  const { f, calls } = companyFetcher({
    company: {
      id: "co1",
      custom_fields: { task1: "Old|single_line_text" },
      settings: { currency_id: "1" },
      size_id: "5",
      industry_id: "3",
      is_large: true,
      subdomain: "acme",
    },
  });
  await runReconcile(
    {
      companyId: "co1",
      dryRun: false,
      desired: { customFields: { task: ["New"] } },
    },
    f,
  );
  const put = calls.find((c) => c.method === "PUT")!;
  const body = JSON.parse(put.body!) as Record<string, unknown>;
  assertEquals(Object.keys(body).sort(), ["custom_fields", "settings"]);
  // Top-level columns are NOT round-tripped (IN merges them - Laravel fill()).
  assertEquals("size_id" in body, false);
  assertEquals("is_large" in body, false);
  assertEquals("subdomain" in body, false);
});

Deno.test("reconcileCompanySettings: numberFormat is no longer accepted or diffed (CS-REV-3) [CS-19]", async () => {
  // The desired schema strips numberFormat (dropped from the surface) and no
  // settings.number_format row is ever produced.
  const schema = model.methods.reconcileCompanySettings.arguments;
  const parsed = schema.parse({
    desired: { numberFormat: "x", currencyId: "1" },
  }) as {
    desired: Record<string, unknown>;
  };
  assertEquals("numberFormat" in parsed.desired, false);
  const { f } = companyFetcher({
    company: { id: "co1", settings: { currency_id: "1" } },
  });
  const { sync } = await runReconcile(
    // deno-lint-ignore no-explicit-any
    { companyId: "co1", dryRun: true, desired: { numberFormat: "x" } as any },
    f,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.some((r) => r.path === "settings.number_format"), false);
  assertEquals(rows.length, 0);
});

Deno.test("reconcileCompanySettings: a literal | in a desired label is rejected (CS-REV-5) [CS-20]", async () => {
  const { f, calls } = companyFetcher({
    company: { id: "co1", custom_fields: { task1: "Old|single_line_text" } },
  });
  const { sync, errs } = await runReconcile(
    {
      companyId: "co1",
      dryRun: false,
      desired: { customFields: { task: ["Bad|Label"] } },
    },
    f,
  );
  const erows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(erows.length, 1);
  assertEquals(
    (erows[0].error as string).includes("reserves as the label|type"),
    true,
  );
  // Fail-closed: nothing written, no diff rows committed.
  assertEquals(putCount(calls), 0);
  assertEquals((sync.data.rows as unknown[]).length, 0);
});

Deno.test("reconcileCompanySettings: an empty live slot is skipped, never populated (CS-REV-6: relabel-only) [CS-21]", async () => {
  // Empty custom_fields -> every slot is disabled; a desired label must NOT
  // create a field. It is recorded as a skipped row and no PUT is issued.
  const mk = () =>
    companyFetcher({ company: { id: "co1", custom_fields: {}, settings: {} } });
  const dry = mk();
  const { sync } = await runReconcile(
    {
      companyId: "co1",
      dryRun: true,
      desired: { customFields: { task: ["Estimated"] } },
    },
    dry.f,
  );
  const rows = sync.data.rows as Array<Record<string, unknown>>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].path, "custom_fields.task1");
  assertEquals(rows[0].action, "skipped");
  assertEquals(rows[0].changed, false);
  assertEquals((rows[0].reason as string).includes("relabel-only"), true);
  assertEquals(putCount(dry.calls), 0);
  // Even on an apply (dryRun=false) the empty slot is left untouched.
  const live = mk();
  const applied = await runReconcile(
    {
      companyId: "co1",
      dryRun: false,
      desired: { customFields: { task: ["Estimated"] } },
    },
    live.f,
  );
  assertEquals(
    (applied.sync.data.rows as Array<Record<string, unknown>>)[0].action,
    "skipped",
  );
  assertEquals(applied.sync.data.applied, false);
  assertEquals(putCount(live.calls), 0);
});

// ===========================================================================
// Invoice-from-tasks path (design/specs/invoiceninja-invoice-tasks.spec.md).
// buildTaskLineItem (pure) + invoiceTasks fan-out. Injected FetchLike; fully
// synthetic fixtures (no counterparty data). Test-plan items 1-10.
// ===========================================================================

/** A raw `/tasks/{id}` row (wire shape: time_log is a JSON string). */
function rawTask(
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    client_id: "cli1",
    rate: 150,
    description: `Bucket ${id}`,
    time_log: "[[0,3600]]", // one closed 1h pair
    ...over,
  };
}

/**
 * A fake {@link FetchLike} for invoiceTasks. Serves GET /tasks/{id} (classify +
 * post-write read-back), GET /invoices?filter= (paginated dedup), and
 * POST /invoices (create). After a POST, task read-backs reflect the flipped
 * invoice_id (unless the id is in `noFlip`).
 */
function invoiceTasksFetcher(
  opts: {
    tasks?: Record<string, Record<string, unknown>>;
    notFound?: string[];
    serverError?: string[];
    existingInvoicesByPage?: Array<Array<Record<string, unknown>>>;
    createdId?: string;
    throwPost?: boolean;
    noFlip?: string[];
  } = {},
): { f: FetchLike; calls: WFetchRec[] } {
  const calls: WFetchRec[] = [];
  let posted = false;
  const createdId = opts.createdId ?? "invnew";
  const f: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST") {
      if (opts.throwPost) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Server Error",
          json: () => Promise.resolve({}),
        });
      }
      posted = true;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ data: { id: createdId } }),
      });
    }
    if (u.pathname.includes("/tasks/")) {
      const id = u.pathname.split("/tasks/")[1];
      if ((opts.serverError ?? []).includes(id)) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Server Error",
          json: () => Promise.resolve({}),
        });
      }
      if ((opts.notFound ?? []).includes(id)) {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: () => Promise.resolve({}),
        });
      }
      const base = (opts.tasks ?? {})[id] ?? rawTask(id);
      const data = posted
        ? {
          ...base,
          invoice_id: (opts.noFlip ?? []).includes(id)
            ? (base.invoice_id ?? null)
            : createdId,
        }
        : base;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ data }),
      });
    }
    // GET /invoices — paginated dedup lookup.
    const pages = opts.existingInvoicesByPage ?? [[]];
    const page = Number(u.searchParams.get("page") ?? "1");
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

/** Run invoiceTasks and return the persisted sync/errors writes. */
async function runInvoiceTasks(
  input: Record<string, unknown>,
  f: FetchLike,
) {
  const { context, writes } = stubContext();
  await model.methods.invoiceTasks.execute(
    // deno-lint-ignore no-explicit-any
    { ...input, _fetch: f } as any,
    context,
  );
  const sync = writes.find((w) => w.spec === "invoiceTasksSync")!;
  const errs = writes.find((w) => w.spec === "invoiceTasksSyncErrors")!;
  return { sync, errs, writes };
}

// (1) buildTaskLineItem: hours / format / eligibility -------------------------
Deno.test("buildTaskLineItem: 3-dp hours from CLOSED pairs [IT-1]", () => {
  // 36932s / 3600 = 10.25888… → 10.259 (matches the spec's 0072 precision).
  const line = buildTaskLineItem({
    id: "taskA",
    description: "Dev Env",
    rate: 150,
    timeLog: [[0, 36932]],
  })!;
  assertEquals(line.quantity, 10.259);
  assertEquals(line.cost, 150);
  assertEquals(line.type_id, "2");
  assertEquals(line.unit_code, "C62");
  assertEquals(line.task_id, "taskA");
});

Deno.test("buildTaskLineItem: notes div format is frozen vs 0072 [IT-1]", () => {
  // Epochs chosen so their UTC render is 0072's exact wall-clock.
  const start = Date.UTC(2026, 7, 18, 15, 56, 37) / 1000;
  const stop = Date.UTC(2026, 7, 18, 18, 25, 6) / 1000;
  const line = buildTaskLineItem({
    id: "taskA",
    description: "Dev Env Aug 16-31",
    rate: 150,
    timeLog: [[start, stop]],
  })!;
  assertEquals(
    line.notes,
    'Dev Env Aug 16-31 <div class="task-time-details"> ' +
      "18/Aug/2026 15:56:37 -  18:25:06 \n </div>",
  );
});

Deno.test("buildTaskLineItem: an OPEN pair makes the task ineligible (null) [IT-1]", () => {
  assertEquals(
    buildTaskLineItem({
      id: "taskA",
      description: "x",
      rate: 150,
      timeLog: [[100, 3700], [3700, 0]],
    }),
    null,
  );
});

Deno.test("buildTaskLineItem: zero-hours returns null [IT-1]", () => {
  assertEquals(
    buildTaskLineItem({
      id: "taskA",
      description: "x",
      rate: 150,
      timeLog: [],
    }),
    null,
  );
  assertEquals(
    buildTaskLineItem({
      id: "taskA",
      description: "x",
      rate: 150,
      timeLog: [[500, 500]],
    }),
    null,
  );
});

Deno.test("buildTaskLineItem: rateOverride wins over task.rate [IT-1]", () => {
  const line = buildTaskLineItem(
    { id: "taskA", description: "x", rate: 150, timeLog: [[0, 3600]] },
    200,
  )!;
  assertEquals(line.cost, 200);
  const own = buildTaskLineItem({
    id: "taskA",
    description: "x",
    rate: 150,
    timeLog: [[0, 3600]],
  })!;
  assertEquals(own.cost, 150);
});

// (2) dry-run -> would-create, lines + total, NO POST -------------------------
Deno.test("invoiceTasks: dry-run yields would-create with lines + total, NO POST [IT-2]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA"), taskB: rawTask("taskB") },
  });
  const { sync } = await runInvoiceTasks(
    {
      number: "0073",
      clientId: "cli1",
      taskIds: ["taskA", "taskB"],
      dryRun: true,
    },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "would-create");
  assertEquals(row.total, 300); // 2 × (1h × 150)
  assertEquals((row.taskRows as unknown[]).length, 2);
  assertEquals(postCount(calls), 0);
});

// (3) number dedup: exact / substring / paginated ----------------------------
Deno.test("invoiceTasks: exact number match -> already-exists, NO POST [IT-3]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
    existingInvoicesByPage: [[{ id: "invx", number: "0073", amount: 150 }]],
  });
  const { sync } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["taskA"], dryRun: false },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "skip");
  assertEquals(row.reason, "already-exists");
  assertEquals(row.invoiceId, "invx");
  assertEquals(postCount(calls), 0);
});

Deno.test("invoiceTasks: a substring-only number is NOT treated as existing [IT-3]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
    existingInvoicesByPage: [[{ id: "invx", number: "00731", amount: 150 }]],
  });
  const { sync } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["taskA"], dryRun: true },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "would-create");
  assertEquals(postCount(calls), 0);
});

Deno.test("invoiceTasks: an exact match on page 2 is found [IT-3]", async () => {
  const { f } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
    existingInvoicesByPage: [
      [{ id: "inv9", number: "9999", amount: 10 }],
      [{ id: "invx", number: "0073", amount: 150 }],
    ],
  });
  const { sync } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["taskA"], dryRun: false },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "skip");
  assertEquals(row.reason, "already-exists");
  assertEquals(row.invoiceId, "invx");
});

// (4) task classify: wrong-client / not-found / already-invoiced /
//     task-running / zero-hours; a mix keeps only the eligible lines ----------
Deno.test("invoiceTasks: task classify skips + a mix yields only eligible lines [IT-4]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: {
      good: rawTask("good"),
      wrong: rawTask("wrong", { client_id: "other" }),
      invd: rawTask("invd", { invoice_id: "invPrev" }),
      run: rawTask("run", { time_log: "[[100,0]]" }),
      zero: rawTask("zero", { time_log: "[[500,500]]" }),
    },
    notFound: ["gone"],
  });
  const { sync, errs } = await runInvoiceTasks(
    {
      number: "0073",
      clientId: "cli1",
      taskIds: ["good", "wrong", "gone", "invd", "run", "zero"],
      dryRun: true,
    },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  const trById = new Map(
    (row.taskRows as Array<Record<string, unknown>>).map((t) => [t.taskId, t]),
  );
  assertEquals(trById.get("good")!.action, "line");
  assertEquals(trById.get("wrong")!.reason, "wrong-client");
  assertEquals(trById.get("gone")!.reason, "not-found");
  assertEquals(trById.get("invd")!.reason, "already-invoiced");
  assertEquals(trById.get("run")!.reason, "task-running");
  assertEquals(trById.get("zero")!.reason, "zero-hours");
  // Only the one eligible task produces a line.
  assertEquals(row.action, "would-create");
  assertEquals(row.total, 150);
  // wrong-client / not-found / task-running surface an error row; already-
  // invoiced + zero-hours are silent skips.
  const errReasons = (errs.data.rows as Array<Record<string, unknown>>)
    .map((r) => r.error).sort();
  assertEquals(errReasons, ["not-found", "task-running", "wrong-client"]);
  assertEquals(postCount(calls), 0);
});

// (5) no eligible tasks -> invoice skip, NO POST -----------------------------
Deno.test("invoiceTasks: no eligible tasks -> skip no-eligible-tasks, NO POST [IT-5]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { zero: rawTask("zero", { time_log: "[[500,500]]" }) },
  });
  const { sync } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["zero"], dryRun: false },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "skip");
  assertEquals(row.reason, "no-eligible-tasks");
  assertEquals(postCount(calls), 0);
});

// (6) real create: headers + task_id in body; read-back confirms flip ---------
Deno.test("invoiceTasks: real create POSTs with mandatory headers + task_id, read-back flips -> created [IT-6]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
    createdId: "invnew",
  });
  const { sync, errs } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["taskA"], dryRun: false },
    f,
  );
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.headers?.["X-Requested-With"], "XMLHttpRequest");
  assertEquals(post.headers?.["Content-Type"], "application/json");
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  const lines = body.line_items as Array<Record<string, unknown>>;
  assertEquals(lines[0].task_id, "taskA");
  assertEquals("amount" in body, false); // IN derives; never sent
  assertEquals("balance" in body, false);
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "created");
  assertEquals(row.invoiceId, "invnew");
  assertEquals((errs.data.rows as unknown[]).length, 0); // clean flip, no errors
});

Deno.test("invoiceTasks: a task whose invoice_id does NOT flip is surfaced as a linkage error [IT-6]", async () => {
  const { f } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
    createdId: "invnew",
    noFlip: ["taskA"],
  });
  const { sync, errs } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["taskA"], dryRun: false },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "created"); // invoice still recorded
  const errRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(errRows.length, 1);
  assertEquals(errRows[0].taskId, "taskA");
  assertEquals(
    (errRows[0].error as string).startsWith("linkage-unconfirmed"),
    true,
  );
});

// (7) status:'sent' -> status_id 2, NO email endpoint ------------------------
Deno.test("invoiceTasks: status 'sent' -> status_id 2 but NO email endpoint hit [IT-7]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
  });
  await runInvoiceTasks(
    {
      number: "0073",
      clientId: "cli1",
      taskIds: ["taskA"],
      status: "sent",
      dryRun: false,
    },
    f,
  );
  const post = calls.find((c) => c.method === "POST")!;
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assertEquals(body.status_id, 2);
  assertEquals("send_email" in body, false);
  assertEquals("email_invoice" in body, false);
  // No request path ever touches an email/send/bulk action endpoint.
  assertEquals(
    calls.some((c) => /email|send|bulk/.test(new URL(c.url).pathname)),
    false,
  );
});

// (8) already-exists dedup runs BEFORE any task fetch (COR-3/COR-5) -----------
// exists-amount-mismatch was removed (COR-2/COR-3): dedup now runs before the
// classify loop, so no computed line total is available to compare — an existing
// number is always a plain `already-exists`, and NO task is even fetched.
Deno.test("invoiceTasks: an existing number -> already-exists WITHOUT fetching tasks, NO POST [IT-8]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
    existingInvoicesByPage: [[{ id: "invx", number: "0073", amount: 999 }]],
  });
  const { sync } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["taskA"], dryRun: false },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "skip");
  assertEquals(row.reason, "already-exists");
  assertEquals(row.invoiceId, "invx");
  assertEquals(postCount(calls), 0);
  // No /tasks/ GET on the already-exists path (a re-run never re-GETs tasks).
  assertEquals(
    calls.some((c) => new URL(c.url).pathname.includes("/tasks/")),
    false,
  );
});

// (9) transient (non-404) task-fetch failure -> invoice skip task-fetch-failed,
//     a sync row IS recorded (COR-5), no partial POST -------------------------
Deno.test("invoiceTasks: a non-404 task-fetch failure -> skip task-fetch-failed, sync row recorded, NO POST [IT-9]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
    serverError: ["taskA"],
  });
  const { sync, errs } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["taskA"], dryRun: false },
    f,
  );
  // COR-5: invoiceTasksForOne RETURNS a result (never throws), so a sync row is
  // recorded for the attempted invoice.
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "skip");
  assertEquals(row.reason, "task-fetch-failed");
  // Both audits are flushed.
  assertEquals(typeof sync.data.retrievedAt, "string");
  assertEquals(typeof errs.data.retrievedAt, "string");
  const errRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(errRows.length >= 1, true);
  assertEquals(errRows[0].number, "0073");
  assertEquals(errRows[0].taskId, "taskA");
  // Never POST a partial invoice when a task could not be read.
  assertEquals(postCount(calls), 0);
});

// (10) both audits flushed at zero errors ------------------------------------
Deno.test("invoiceTasks: both audit snapshots flush even at zero errors [IT-10]", async () => {
  const { f } = invoiceTasksFetcher({ tasks: { taskA: rawTask("taskA") } });
  const { sync, errs } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["taskA"], dryRun: true },
    f,
  );
  assertEquals(typeof sync.data.retrievedAt, "string");
  assertEquals(typeof errs.data.retrievedAt, "string");
  assertEquals((errs.data.rows as unknown[]).length, 0);
});

// Blank / invalid input gates -------------------------------------------------
Deno.test("invoiceTasks: a blank number skips blank-dedup-key + errors[], never filters [IT-0]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
  });
  const { sync, errs } = await runInvoiceTasks(
    { number: "  ", clientId: "cli1", taskIds: ["taskA"], dryRun: true },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "skip");
  assertEquals(row.reason, "blank-dedup-key");
  assertEquals(
    (errs.data.rows as Array<Record<string, unknown>>)[0].error,
    "blank-dedup-key",
  );
  assertEquals(calls.length, 0); // never hit the wire
});

Deno.test("invoiceTasks: a malformed clientId/taskId charset skips invalid, NO wire [IT-0]", async () => {
  const { f, calls } = invoiceTasksFetcher({});
  const bad = await runInvoiceTasks(
    {
      number: "0073",
      clientId: "../../users/5",
      taskIds: ["taskA"],
      dryRun: true,
    },
    f,
  );
  assertEquals(
    (bad.sync.data.rows as Array<Record<string, unknown>>)[0].reason,
    "invalid",
  );
  const badTask = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["1/2"], dryRun: true },
    f,
  );
  assertEquals(
    (badTask.sync.data.rows as Array<Record<string, unknown>>)[0].reason,
    "invalid",
  );
  const empty = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: [], dryRun: true },
    f,
  );
  assertEquals(
    (empty.sync.data.rows as Array<Record<string, unknown>>)[0].reason,
    "invalid",
  );
  assertEquals(calls.length, 0);
});

// invoiceTasksForOne direct: number dedup uses trash-inclusive exact match ----
Deno.test("invoiceTasksForOne: returns computed lines + total on a clean dry-run [IT-DIRECT]", async () => {
  const { f } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA"), taskB: rawTask("taskB", { rate: 100 }) },
  });
  const r = await invoiceTasksForOne(
    // deno-lint-ignore no-explicit-any
    CFG as any,
    { number: "0073", clientId: "cli1", taskIds: ["taskA", "taskB"] },
    true,
    f,
  );
  assertEquals(r.action, "would-create");
  assertEquals(r.lines.length, 2);
  assertEquals(r.total, 250); // 150 + 100
});

// ===========================================================================
// Rework: adversarial-review fixes SEC-1 / COR-1 / COR-2 / COR-3 / COR-4 / COR-5.
// ===========================================================================

// SEC-1 / notes: buildTaskLineItem sums MULTIPLE closed pairs + multiple divs ---
Deno.test("buildTaskLineItem: sums MULTIPLE closed pairs and renders one div each [IT-REW-multi-pair]", () => {
  const s1 = Date.UTC(2026, 7, 18, 15, 56, 37) / 1000;
  const e1 = Date.UTC(2026, 7, 18, 18, 25, 6) / 1000;
  const s2 = Date.UTC(2026, 7, 19, 9, 0, 0) / 1000;
  const e2 = Date.UTC(2026, 7, 19, 10, 30, 0) / 1000;
  const line = buildTaskLineItem({
    id: "taskA",
    description: "Dev Env",
    rate: 100,
    timeLog: [[s1, e1], [s2, e2]],
  })!;
  // (e1-s1) + (e2-s2) = 8909 + 5400 = 14309s / 3600 = 3.97472… -> 3.975.
  assertEquals(line.quantity, 3.975);
  assertEquals(
    line.notes,
    'Dev Env <div class="task-time-details"> 18/Aug/2026 15:56:37 -  ' +
      '18:25:06 \n </div> <div class="task-time-details"> 19/Aug/2026 ' +
      "09:00:00 -  10:30:00 \n </div>",
  );
});

// COR-1: a CLOSED pair with stop < start (negative) is ineligible -------------
Deno.test("buildTaskLineItem: a CLOSED pair with stop < start (negative) -> null [IT-REW-negative-closed]", () => {
  assertEquals(
    buildTaskLineItem({
      id: "taskA",
      description: "garbage",
      rate: 150,
      timeLog: [[3700, 100]],
    }),
    null,
  );
});

// COR-1: null / zero rate with no rateOverride -> skip zero-cost, NO line ------
Deno.test("buildTaskLineItem: a null or zero rate (no override) -> null [IT-REW-zero-cost-pure]", () => {
  assertEquals(
    buildTaskLineItem({
      id: "t",
      description: "x",
      rate: null,
      timeLog: [[0, 3600]],
    }),
    null,
  );
  assertEquals(
    buildTaskLineItem({
      id: "t",
      description: "x",
      rate: 0,
      timeLog: [[0, 3600]],
    }),
    null,
  );
  // A rateOverride rescues a null-rate task.
  const rescued = buildTaskLineItem(
    { id: "t", description: "x", rate: null, timeLog: [[0, 3600]] },
    150,
  )!;
  assertEquals(rescued.cost, 150);
});

Deno.test("invoiceTasks: a null/zero-rate task -> skip zero-cost, NO line, NO POST [IT-REW-zero-cost]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA", { rate: 0 }) },
  });
  const { sync } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["taskA"], dryRun: false },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "skip");
  assertEquals(row.reason, "no-eligible-tasks"); // the only task was skipped
  const tr = (row.taskRows as Array<Record<string, unknown>>)[0];
  assertEquals(tr.action, "skip");
  assertEquals(tr.reason, "zero-cost");
  assertEquals(postCount(calls), 0);
});

// SEC-1: duplicate taskId -> exactly ONE line + total once + a skip row --------
Deno.test("invoiceTasks: a duplicate taskId bills once + records a duplicate-task-id skip [IT-REW-dedup]", async () => {
  const { f } = invoiceTasksFetcher({ tasks: { taskA: rawTask("taskA") } });
  const { sync } = await runInvoiceTasks(
    {
      number: "0073",
      clientId: "cli1",
      taskIds: ["taskA", "taskA"],
      dryRun: true,
    },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "would-create");
  assertEquals(row.total, 150); // counted ONCE, not 300
  const trs = row.taskRows as Array<Record<string, unknown>>;
  const lines = trs.filter((t) => t.action === "line");
  assertEquals(lines.length, 1); // exactly one line for taskA
  const dups = trs.filter((t) => t.reason === "duplicate-task-id");
  assertEquals(dups.length, 1);
  assertEquals(dups[0].taskId, "taskA");
});

// COR-4: a padded " 0073 " dedups against "0073" and creates "0073" -----------
Deno.test("invoiceTasks: a padded number dedups against the trimmed value [IT-REW-trim-dedup]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
    existingInvoicesByPage: [[{ id: "invx", number: "0073", amount: 150 }]],
  });
  const { sync } = await runInvoiceTasks(
    { number: "  0073  ", clientId: "cli1", taskIds: ["taskA"], dryRun: false },
    f,
  );
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "skip");
  assertEquals(row.reason, "already-exists"); // " 0073 " matched "0073"
  assertEquals(postCount(calls), 0);
  // The ?filter= query carried the TRIMMED value, not the padded one.
  const filterCall = calls.find((c) =>
    new URL(c.url).pathname.endsWith("/invoices")
  )!;
  assertEquals(new URL(filterCall.url).searchParams.get("filter"), "0073");
});

Deno.test("invoiceTasks: a padded number POSTs the trimmed number on create [IT-REW-trim-create]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
  });
  await runInvoiceTasks(
    { number: " 0073 ", clientId: "cli1", taskIds: ["taskA"], dryRun: false },
    f,
  );
  const post = calls.find((c) => c.method === "POST")!;
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assertEquals(body.number, "0073"); // trimmed
});

// COR-5: a POST that throws -> sync row recorded, error row present, no partial -
Deno.test("invoiceTasks: a POST that throws -> skip post-failed, sync row + error row, no partial state [IT-REW-post-throw]", async () => {
  const { f, calls } = invoiceTasksFetcher({
    tasks: { taskA: rawTask("taskA") },
    throwPost: true,
  });
  const { sync, errs } = await runInvoiceTasks(
    { number: "0073", clientId: "cli1", taskIds: ["taskA"], dryRun: false },
    f,
  );
  // The invoice's sync row IS recorded (COR-5).
  const row = (sync.data.rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.action, "skip");
  assertEquals(row.reason, "post-failed");
  assertEquals(row.invoiceId, null); // no partial invoice state leaks
  // An error row is present.
  const errRows = errs.data.rows as Array<Record<string, unknown>>;
  assertEquals(errRows.length >= 1, true);
  assertEquals(errRows[0].number, "0073");
  assertEquals(
    (errRows[0].error as string).startsWith("post-failed"),
    true,
  );
  // Exactly one POST attempt; NO read-back GET /tasks after the failed POST.
  assertEquals(postCount(calls), 1);
  assertEquals(
    calls.filter((c) => new URL(c.url).pathname.includes("/tasks/")).length,
    1, // only the pre-POST classify fetch; no post-write read-back
  );
});
