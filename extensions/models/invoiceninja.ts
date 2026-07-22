/**
 * @shrug/invoiceninja — Invoice Ninja v5 (`/api/v1`) model.
 *
 * PHASE 1a (reads) + PHASE 2 (gated write) + PHASE 6 (mapping-write). The config
 * schema (§4.1) and the single network seam `inFetch` (§4.2) are the FROZEN
 * contracts from the `contracts` work item and are unchanged. Phase 1a implements
 * the six read methods (§4.3) and tightens their resource schemas (§4.5). Phase 2
 * adds the gated write path (§4.4/§7): the pure `mapTxnToExpense` (§7.3), the
 * idempotent per-txn `upsertExpense` (check-then-create on `custom_value1`, §7.2),
 * and the single-writer fan-out `upsertExpenses` → `expenseSync` (+
 * `expenseSyncErrors`). Phase 6 (§7.4) adds the ADDITIVE mapping-write path:
 * `upsertVendors` / `upsertExpenseCategories` auto-create reference data (dedup on
 * normalized name) and `buildMapping` derives the frozen Mapping (§7.3) so the
 * sync drops its manual `mapping` input. Every write is gated behind `dryRun`
 * (default true); Phase 6 touches none of the frozen read/write bodies or seams.
 *
 * Structural template: @kneel/bugzilla (read-only REST, vaulted bearer, single
 * fetch seam, versioned snapshot resources); this model adds the gated write.
 *
 * Auth (verified, §4.2): every request sends
 *   X-API-TOKEN: <apiToken>
 *   X-Requested-With: XMLHttpRequest   ← mandatory; omitting it is the #1 4xx cause
 *   Accept: application/json           (+ Content-Type on POST)
 * Token is full-account — read-only-ness is enforced by which methods exist.
 *
 * Normalization is done INSIDE the read methods (§4.3) so downstream reports stay
 * pure CEL: hashed-string ids (never coerced to int), status-label maps, the
 * `computedStatus` overdue derivation (status_id never stores overdue), and the
 * `paymentables` → `appliedInvoices` flattening.
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Config (§4.1) — FROZEN
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .describe("https://<host>/api/v1 (no trailing slash)"),
  apiToken: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      'Full-account IN API token; CEL ref → vault.get("invoiceninja","API_TOKEN"). ' +
        "Mint under a restricted IN user for least privilege.",
    ),
  perPage: z
    .number()
    .int()
    .positive()
    .default(100)
    .describe("Page size; API default is 20 — override to 100."),
  withTrashed: z
    .boolean()
    .default(false)
    .describe("Include archived/soft-deleted records."),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      "Write methods: when true (default), upsertExpense returns would-create " +
        "and NEVER POSTs. A real write requires an explicit dryRun=false.",
    ),
  vendorOverlay: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Curated vendor translation (mapping-overlay): RAW counterparty name → " +
        "TARGET IN vendor name. upsertVendors ensures the TARGET (not the raw), " +
        "and buildMapping emits an alias so mapTxnToExpense (which keys by the " +
        "RAW counterparty, §7.3) resolves the raw name to the target vendor id " +
        "(e.g. {'Nimbus AI':'Nimbus'}). Empty (default) ⇒ names pass through " +
        "unchanged. Instance config at go-live, not committed code.",
    ),
  categoryOverlay: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Curated category translation (mapping-overlay): RAW rawCategory → TARGET " +
        "IN expense-category name (e.g. {'Software':'Software & Subscriptions'}). " +
        "Same mechanism as vendorOverlay. Empty (default) ⇒ pass through.",
    ),
  vendorCategoryOverlay: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Curated VENDOR→category assignment (vendor-category-override, §7.5): RAW " +
        "counterparty name → TARGET IN expense-category name (e.g. " +
        "{'ACME INSURANCE CO':'Insurance'}). HARD-OVERRIDE precedence: a matched " +
        "vendor's category ALWAYS wins over Mercury's rawCategory — mapTxnToExpense " +
        "consults vendorCategories[counterparty] BEFORE categories[rawCategory]. " +
        "Use it to force a vendor into one category even when Mercury tags its rows " +
        "inconsistently. buildMapping resolves each TARGET over the (deleted-" +
        "filtered) expenseCategories snapshot and emits it into the SEPARATE " +
        "mapping.vendorCategories[rawCounterparty]=id(target) namespace (disjoint " +
        "from categories, so a counterparty key coinciding with a real category " +
        "name can never clobber a rawCategory binding); upsertExpenseCategories " +
        "ensures the TARGET exists for ALL candidate debits whose counterparty " +
        "matches a key (not only uncategorized ones). Key matching is CASE-" +
        "INSENSITIVE via normName (trim + NFC + case-fold): a config key " +
        "'ACME INSURANCE CO' matches a bank counterparty 'Acme Insurance Co'. " +
        "Exact byte-match is tried first (fast path); on a miss the lookup falls " +
        "back to case-insensitive comparison over the mapping entries. A case-" +
        "variant match is logged at upsert time for auditability (same contract " +
        "as vendorOverlay/categoryOverlay). Empty (default) ⇒ inert (bit-for-bit " +
        "back-compat). Instance config at go-live, not committed code.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Normalization helpers (§4.3) — exported for tests. Kept pure and side-effect
// free; every read method funnels raw API rows through these.
// ---------------------------------------------------------------------------

/** Coerce to a non-empty string, or null (empty string → null). */
export function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "string" ? v : String(v);
}

/** Coerce to a finite number, or null. IN often returns numbers as strings. */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce IN's 0/1/"0"/"1"/bool truthiness to a boolean, or null. */
export function boolOrNull(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
}

/** Invoice `status_id` → label (§4.3, verified from source). Overdue/Unpaid are computed, not stored. */
export const INVOICE_STATUS: Record<number, string> = {
  1: "Draft",
  2: "Sent",
  3: "Partial",
  4: "Paid",
  5: "Cancelled",
  6: "Reversed",
};

/** Payment `status_id` → label (§4.3, verified from source). */
export const PAYMENT_STATUS: Record<number, string> = {
  1: "Pending",
  2: "Cancelled",
  3: "Failed",
  4: "Completed",
  5: "Partially refunded",
  6: "Refunded",
};

/**
 * Derive an invoice's effective status. `status_id` NEVER reflects overdue, so
 * overdue is computed from a positive balance and an elapsed due date; a
 * draft/cancelled/reversed invoice is never overdue. Falls back to the stored
 * status label otherwise.
 *
 * @param statusId Normalized `status_id`.
 * @param balance Normalized `balance`.
 * @param dueDate `YYYY-MM-DD` due date, or null.
 * @param today `YYYY-MM-DD` reference date (injected for testability).
 */
export function computedInvoiceStatus(
  statusId: number | null,
  balance: number | null,
  dueDate: string | null,
  today: string,
): string | null {
  const label = statusId !== null ? INVOICE_STATUS[statusId] ?? null : null;
  // Only a Sent (2) or Partial (3) invoice can be overdue — those are the
  // statuses that carry an open balance. An unknown/null status is never
  // asserted as Overdue (we don't actually know its status).
  const settleable = statusId === 2 || statusId === 3;
  if (
    settleable &&
    balance !== null && balance > 0 &&
    dueDate && dueDate < today
  ) {
    return "Overdue";
  }
  return label;
}

/** A normalized invoice row (§4.3). */
const InvoiceSchema = z.object({
  id: z.string().describe("Hashed IN id — never coerced to int"),
  number: z.string().nullable(),
  clientId: z.string().nullable(),
  statusId: z.number().int().nullable(),
  statusLabel: z.string().nullable(),
  computedStatus: z.string().nullable().describe(
    "Overdue derived from balance+dueDate",
  ),
  amount: z.number().nullable(),
  balance: z.number().nullable(),
  paidToDate: z.number().nullable(),
  date: z.string().nullable(),
  dueDate: z.string().nullable(),
  isDeleted: z.boolean().nullable(),
  archivedAt: z.number().nullable().describe("Unix ts; 0/absent → null"),
});

/** Normalize a raw `/invoices` row. `today` is `YYYY-MM-DD` for overdue derivation. */
export function normalizeInvoice(
  raw: Record<string, unknown>,
  today: string,
): z.infer<typeof InvoiceSchema> {
  const statusId = numOrNull(raw.status_id);
  const balance = numOrNull(raw.balance);
  const dueDate = strOrNull(raw.due_date);
  const archivedAt = numOrNull(raw.archived_at);
  return {
    id: strOrNull(raw.id) ?? "",
    number: strOrNull(raw.number),
    clientId: strOrNull(raw.client_id),
    statusId,
    statusLabel: statusId !== null ? INVOICE_STATUS[statusId] ?? null : null,
    computedStatus: computedInvoiceStatus(statusId, balance, dueDate, today),
    amount: numOrNull(raw.amount),
    balance,
    paidToDate: numOrNull(raw.paid_to_date),
    date: strOrNull(raw.date),
    dueDate,
    isDeleted: boolOrNull(raw.is_deleted),
    archivedAt: archivedAt && archivedAt > 0 ? archivedAt : null,
  };
}

/** One invoice application lifted out of a payment's `paymentables`. */
const AppliedInvoiceSchema = z.object({
  invoiceId: z.string().nullable(),
  amount: z.number().nullable(),
});

/**
 * Flatten a payment's `paymentables` to the invoice applications only. A
 * paymentable may instead reference a credit (`credit_id`); those are dropped —
 * only entries carrying an `invoice_id` are invoice applications.
 */
export function flattenPaymentables(
  raw: Record<string, unknown>,
): Array<z.infer<typeof AppliedInvoiceSchema>> {
  const p = raw.paymentables;
  if (!Array.isArray(p)) return [];
  return (p as Array<Record<string, unknown>>)
    .map((x) => ({
      invoiceId: strOrNull(x?.invoice_id),
      amount: numOrNull(x?.amount),
    }))
    // Keep only real invoice applications: a credit application (or a blank
    // invoice_id) has no resolvable invoiceId and is dropped.
    .filter((a) => a.invoiceId !== null);
}

/** A normalized payment row (§4.3). */
const PaymentSchema = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  amount: z.number().nullable(),
  refunded: z.number().nullable(),
  applied: z.number().nullable(),
  date: z.string().nullable(),
  typeId: z.number().int().nullable(),
  typeLabel: z.string().nullable(),
  statusId: z.number().int().nullable(),
  statusLabel: z.string().nullable(),
  transactionReference: z.string().nullable(),
  appliedInvoices: z.array(AppliedInvoiceSchema),
});

/** Normalize a raw `/payments` row. */
export function normalizePayment(
  raw: Record<string, unknown>,
): z.infer<typeof PaymentSchema> {
  const statusId = numOrNull(raw.status_id);
  return {
    id: strOrNull(raw.id) ?? "",
    clientId: strOrNull(raw.client_id),
    amount: numOrNull(raw.amount),
    refunded: numOrNull(raw.refunded),
    applied: numOrNull(raw.applied),
    date: strOrNull(raw.date),
    typeId: numOrNull(raw.type_id),
    // Payment-type enum is large and NOT verified in the frozen spec (§4.3 only
    // pins status_id). typeId is preserved; a verified type map is deferred.
    typeLabel: null,
    statusId,
    statusLabel: statusId !== null ? PAYMENT_STATUS[statusId] ?? null : null,
    transactionReference: strOrNull(raw.transaction_reference),
    appliedInvoices: flattenPaymentables(raw),
  };
}

/**
 * Derive an expense's lifecycle status. IN expenses have no stored `status_id`;
 * the status shown in the UI is derived from invoice/payment/should-be-invoiced
 * state. Best-effort, documented derivation (reviewable):
 * invoiced → paid → pending → logged.
 */
export function derivedExpenseStatus(raw: Record<string, unknown>): string {
  if (strOrNull(raw.invoice_id)) return "invoiced";
  if (strOrNull(raw.payment_date)) return "paid";
  if (boolOrNull(raw.should_be_invoiced)) return "pending";
  return "logged";
}

/** A normalized expense row (§4.3; carries the `custom_value1` dedup mirror). */
const ExpenseSchema = z.object({
  id: z.string(),
  amount: z.number().nullable(),
  date: z.string().nullable(),
  paymentDate: z.string().nullable(),
  categoryId: z.string().nullable(),
  vendorId: z.string().nullable(),
  clientId: z.string().nullable(),
  invoiceId: z.string().nullable(),
  currencyId: z.string().nullable(),
  derivedStatus: z.string().nullable(),
  shouldBeInvoiced: z.boolean().nullable(),
  customValue1: z.string().nullable().describe(
    "Dedup key mirror (bank txn id)",
  ),
  // Deletion state (additive, back-compat). IN's `listExpenses` returns
  // soft-deleted/archived expenses in BOTH with_trashed states, so the
  // downstream reports (expense-summary, reconcile) must be able to EXCLUDE a
  // deleted row or its amount is silently counted. Absent ⇒ not deleted (a
  // pre-fix snapshot keeps working — mirrors InvoiceSchema/MapItemSchema).
  isDeleted: z.boolean().nullable(),
  archivedAt: z.number().nullable().describe("Unix ts; 0/absent → null"),
});

/** Normalize a raw `/expenses` row. */
export function normalizeExpense(
  raw: Record<string, unknown>,
): z.infer<typeof ExpenseSchema> {
  const archivedAt = numOrNull(raw.archived_at);
  return {
    id: strOrNull(raw.id) ?? "",
    amount: numOrNull(raw.amount),
    date: strOrNull(raw.date),
    paymentDate: strOrNull(raw.payment_date),
    categoryId: strOrNull(raw.category_id),
    vendorId: strOrNull(raw.vendor_id),
    clientId: strOrNull(raw.client_id),
    invoiceId: strOrNull(raw.invoice_id),
    currencyId: strOrNull(raw.currency_id),
    derivedStatus: derivedExpenseStatus(raw),
    shouldBeInvoiced: boolOrNull(raw.should_be_invoiced),
    customValue1: strOrNull(raw.custom_value1),
    isDeleted: boolOrNull(raw.is_deleted),
    archivedAt: archivedAt && archivedAt > 0 ? archivedAt : null,
  };
}

/** A `{id, name}` mapping row (expense categories, vendors). */
const MapItemSchema = z.object({
  id: z.string().describe("Hashed IN id"),
  name: z.string().nullable(),
  // mapping-overlay (gotcha #2, additive back-compat): IN returns soft-deleted
  // reference rows in BOTH with_trashed states, so the dedup/mapping steps must
  // be able to EXCLUDE them (4 of 5 real "Nimbus" vendors are deleted). Absent
  // ⇒ not deleted (a pre-fix snapshot keeps working — see `notDeleted`).
  isDeleted: z.boolean().nullable(),
  archivedAt: z.number().nullable().describe("Unix ts; 0/absent → null"),
});

/** Normalize a raw mapping row (`/expense_categories`, `/vendors`) to `{id, name}`. */
export function normalizeMapItem(
  raw: Record<string, unknown>,
): z.infer<typeof MapItemSchema> {
  const archivedAt = numOrNull(raw.archived_at);
  return {
    id: strOrNull(raw.id) ?? "",
    name: strOrNull(raw.name),
    isDeleted: boolOrNull(raw.is_deleted),
    archivedAt: archivedAt && archivedAt > 0 ? archivedAt : null,
  };
}

// ---------------------------------------------------------------------------
// Resource schemas (§4.5) — a snapshot envelope per list, plus the single-record
// and (Phase-2) expense-sync shapes.
// ---------------------------------------------------------------------------

/** Build a list-snapshot envelope schema around a row schema. */
function snapshotSchema<T extends z.ZodTypeAny>(items: T) {
  return z.object({
    scope: z.string().describe("Which query produced this snapshot"),
    count: z.number().int().nonnegative(),
    items: z.array(items),
    retrievedAt: z.string(),
  });
}

const InvoiceListSchema = snapshotSchema(InvoiceSchema);
const PaymentListSchema = snapshotSchema(PaymentSchema);
const ExpenseListSchema = snapshotSchema(ExpenseSchema);
const MapListSchema = snapshotSchema(MapItemSchema);

const SingleSchema = z.object({
  id: z.string().describe("Hashed IN id — never coerce to int"),
  raw: z.record(z.string(), z.unknown()),
  retrievedAt: z.string(),
});

// One row per txn processed by upsertExpense (§4.4): dedupKey, action, ids.
const ExpenseSyncSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    action: z.enum(["skip", "would-create", "created"]),
    expenseId: z.string().nullable(),
    amount: z.number().nullable(),
    date: z.string().nullable(),
    unmatchedVendor: z.boolean().default(false),
  })),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

// ADDITIVE (Phase 2, WSPEC-04) — durable audit of failed write attempts. Kept
// SEPARATE from the frozen ExpenseSyncSchema (whose action enum admits no
// "failed"): a mid-batch POST failure keeps a queryable error row here while
// the successful creates keep their rows in expenseSync.
const ExpenseSyncErrorsSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    amount: z.number().nullable(),
    currency: z.string().nullable(),
    error: z.string(),
    attemptedAt: z.string(),
    dryRun: z.boolean(),
  })),
  retrievedAt: z.string(),
});

// ADDITIVE (Phase 6, §7.4) — mapping-write audit + emitted mapping. Mirror the
// expenseSync/expenseSyncErrors shape; kept SEPARATE from the frozen §4.5
// resources. One "*Sync" row per distinct reference entity processed; one
// "*SyncErrors" row per create that threw. `mapping` is the frozen Mapping shape
// (§7.3) emitted by buildMapping for the sync to consume via CEL.
const VendorSyncSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    name: z.string(),
    action: z.enum(["skip", "would-create", "created"]),
    vendorId: z.string().nullable(),
    reason: z.string().optional(),
  })),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

const CategorySyncSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    name: z.string(),
    action: z.enum(["skip", "would-create", "created"]),
    categoryId: z.string().nullable(),
    reason: z.string().optional(),
  })),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

// Shared by vendorSyncErrors + categorySyncErrors (§7.4 — identical shape). A
// create that threw keeps a durable, queryable row here so "0 errors this run"
// (flushed even when empty) is distinguishable from "never ran".
const RefSyncErrorsSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    name: z.string(),
    error: z.string(),
    attemptedAt: z.string(),
    dryRun: z.boolean(),
  })),
  retrievedAt: z.string(),
});

// The emitted Mapping (§7.3, frozen shape) — buildMapping's product. Keys are
// RAW display names (mapTxnToExpense/ownLookup look up by raw counterparty /
// rawCategory string); case-insensitivity lives only in the create/dedup step.
const MappingSchema = z.object({
  scope: z.string(),
  currencyId: z.string(),
  fallbackCategoryId: z.string(),
  vendors: z.record(z.string(), z.string()),
  categories: z.record(z.string(), z.string()),
  // HARD-OVERRIDE tier (vendor-category-override §7.5). Optional + default so an
  // older `mapping` snapshot lacking the field still parses (back-compat).
  vendorCategories: z.record(z.string(), z.string()).optional().default({}),
  retrievedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Network seam `inFetch` (§4.2) — FROZEN. Sole place headers/auth/pagination/
// 429-backoff live.
// ---------------------------------------------------------------------------

/** A `fetch`-compatible function (injected in tests). */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

export interface InFetchOptions {
  query?: Array<[string, string]>;
  body?: Record<string, unknown>;
}

/**
 * The single Invoice Ninja network seam. Applies the mandatory headers, JSON
 * body on writes, and 429 exponential backoff. Read pagination (loop until
 * meta.pagination.current_page == total_pages) is layered by the read methods
 * in Phase 1a; this seam performs one request.
 *
 * @throws On a non-2xx status (after 429 retries are exhausted).
 */
export async function inFetch(
  cfg: GlobalArgs,
  method: "GET" | "POST",
  path: string,
  opts: InFetchOptions = {},
  doFetch: FetchLike = fetch as unknown as FetchLike,
): Promise<Record<string, unknown>> {
  const url = new URL(
    `${cfg.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`,
  );
  for (const [k, v] of opts.query ?? []) url.searchParams.append(k, v);

  const headers: Record<string, string> = {
    "X-API-TOKEN": cfg.apiToken,
    "X-Requested-With": "XMLHttpRequest", // mandatory
    "Accept": "application/json",
  };
  if (method === "POST") headers["Content-Type"] = "application/json";

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await doFetch(url.toString(), {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (resp.status === 429 && attempt < maxAttempts) {
      // TODO(1a): honor Retry-After when present. Exponential backoff for now.
      await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
      continue;
    }
    // Check status BEFORE parsing: a non-JSON error body (proxy HTML on a 5xx,
    // an empty 429) must surface the HTTP status, not an opaque JSON parse error.
    if (!resp.ok) {
      throw new Error(
        `IN ${method} ${path} failed (HTTP ${resp.status}): ${resp.statusText}`,
      );
    }
    return (await resp.json()) as Record<string, unknown>;
  }
  // Unreachable: the final attempt returns or throws above; present only to
  // satisfy the return-type checker.
  throw new Error(`IN ${method} ${path}: unexpected retry-loop fall-through`);
}

/**
 * Paginate a list endpoint to completion. Requests pages by a LOCAL monotonic
 * counter (never the server-echoed `current_page`) and stops once that counter
 * reaches `total_pages`, a page comes back empty, or `meta.pagination` is
 * absent, accumulating the `data[]` rows. Applies `per_page` (from cfg) and,
 * when configured, `with_trashed`. Driving the loop by the local counter — not
 * the response echo — is what makes the `maxPages` cap effective: an API that
 * always echoes `current_page: 1` cannot pin the loop in place.
 *
 * @param cfg Resolved config (per-page size, with-trashed).
 * @param path REST path relative to `baseUrl`, e.g. `invoices`.
 * @param query Endpoint-specific query pairs (filters, `include`).
 * @param doFetch Fetch implementation (defaults to global `fetch`).
 * @returns Every accumulated raw row across all pages.
 */
export async function inFetchAll(
  cfg: GlobalArgs,
  path: string,
  query: Array<[string, string]> = [],
  doFetch: FetchLike = fetch as unknown as FetchLike,
  logger?: MethodLogger,
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  const maxPages = 10000; // safety valve against a misbehaving total_pages
  let page = 1;
  while (page <= maxPages) {
    const pageQuery: Array<[string, string]> = [
      ...query,
      ["per_page", String(cfg.perPage)],
      ["page", String(page)],
    ];
    if (cfg.withTrashed) pageQuery.push(["with_trashed", "true"]);
    const json = await inFetch(cfg, "GET", path, { query: pageQuery }, doFetch);
    const data = Array.isArray(json.data)
      ? json.data as Array<Record<string, unknown>>
      : [];
    for (const row of data) all.push(row);
    const pagination = (json.meta as Record<string, unknown> | undefined)
      ?.pagination as Record<string, unknown> | undefined;
    // Terminate on the LOCAL page counter, not the server's current_page echo,
    // so a stuck/echoing pager can't loop forever (the maxPages cap governs).
    const total = numOrNull(pagination?.total_pages) ?? page;
    if (!pagination || page >= total || data.length === 0) break;
    page += 1;
  }
  // Hitting the cap means the result is TRUNCATED, not complete — surface it
  // loudly so downstream consumers don't read a partial snapshot as whole.
  if (page > maxPages) {
    logger?.warning(
      "IN {path} pagination hit the {maxPages}-page cap ({rows} rows); " +
        "snapshot is TRUNCATED",
      { path, maxPages, rows: all.length },
    );
  }
  return all;
}

// ---------------------------------------------------------------------------
// Execute context (bugzilla idiom)
// ---------------------------------------------------------------------------

interface MethodLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

interface ExecuteContext {
  globalArgs: GlobalArgs;
  logger: MethodLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  // Read back a previously written resource (latest version), JSON-parsed — the
  // sanctioned high-level form of context.dataRepository for JSON snapshots
  // (Phase 6: buildMapping reads the refreshed vendors/expenseCategories
  // snapshots the two upserts just wrote). Optional so read/write methods that
  // never read prior state don't have to stub it.
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

interface ExecuteResult {
  dataHandles: Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// Gated write path (§4.4/§7) — Phase 2. All exported for unit tests.
// ---------------------------------------------------------------------------

/**
 * The mapping data (§7.3) — plain tables built by the caller/workflow from the
 * `vendors` + `expenseCategories` snapshots (method args are JSON, so this is
 * data, not functions). USD-only v1 → a single `currencyId`.
 */
export interface Mapping {
  /** The IN currency hashid for the (single, USD) currency. */
  currencyId: string;
  /** counterparty display name → vendor hashid. Absent = unmatched. */
  vendors?: Record<string, string>;
  /** rawCategory OR counterparty → expense-category hashid. */
  categories?: Record<string, string>;
  /**
   * counterparty → expense-category hashid, HARD-OVERRIDE tier (vendor-category-
   * override §7.5): consulted BEFORE `categories`, so a matched vendor's category
   * wins over the txn's Mercury `rawCategory`. Own namespace (disjoint from
   * `categories`) so a counterparty key coinciding with a real category name can
   * never clobber a rawCategory binding. Absent ⇒ old (pre-override) behavior.
   */
  vendorCategories?: Record<string, string>;
  /** Category hashid used when nothing else matches (§7.3 Uncategorized). */
  fallbackCategoryId: string;
}

/**
 * A candidate expense is a settled USD debit that is NOT an inter-account
 * transfer and NOT an owner draw / ATM withdrawal (§6 + §6.1 + owner-draw-
 * exclusion + §12.3/§12.4). This gate is the last line of defense for the
 * amount-sign (§5.1), currency, transfer, and owner-draw decisions — kept
 * explicit so a credit, a pending row, a non-USD row, a self-transfer, or an
 * owner draw can never reach `mapTxnToExpense`. The transfer/owner-draw clauses
 * are `!== true` (NOT `!txn.isTransfer`) so an absent/undefined field on an
 * older snapshot is treated as non-transfer/non-owner-draw (back-compat), not
 * silently excluded. This single guard cascades: `upsertExpense` skips these
 * rows, and the Phase-6 `upsertVendors`/`upsertExpenseCategories` (which filter
 * on `isCandidate`) never auto-create a vendor/category for a transfer or
 * owner-draw counterparty.
 *
 * @param txn A canonical BankTxn (§6).
 */
export function isCandidate(txn: Record<string, unknown>): boolean {
  return txn.direction === "debit" && txn.status === "posted" &&
    txn.currency === "USD" && txn.isTransfer !== true &&
    txn.isOwnerDraw !== true;
}

/**
 * Case-insensitive fallback lookup in a mapping table. Tries byte-exact match
 * first (fast path — O(1) via `Object.hasOwn`); on a miss, scans entries and
 * compares via {@link normName} (trim + NFC + case-fold). Returns the value for
 * the FIRST entry whose normalized key matches — `Object.entries` iteration
 * order is insertion order, so the result is deterministic for a given mapping
 * object.
 *
 * Use this for mapping tiers where the config key may differ from the runtime
 * key only by case/whitespace (e.g. a hand-authored `vendorCategoryOverlay`
 * with `"ACME INSURANCE CO"` against a bank counterparty `"Acme Insurance
 * Co"`). Prototype-safe — the scan uses `Object.entries` which is
 * own-properties only, and `normName` is compared by value (no prototype
 * surface).
 *
 * Overlays are a handful of entries so the per-call linear scan is trivial.
 */
export function ownLookupNorm(
  table: Record<string, string> | undefined,
  key: string | null,
): string | undefined {
  if (table == null || key === null) return undefined;
  // Fast path: byte-exact match.
  if (Object.hasOwn(table, key)) return table[key];
  // Slow path: case-insensitive scan.
  const normKey = normName(key);
  if (normKey === "") return undefined;
  for (const [k, v] of Object.entries(table)) {
    if (normName(k) === normKey) return v;
  }
  return undefined;
}

/**
 * The vendor hashid for a txn's counterparty, or null when unmatched (§7.3 /
 * §12.2 — v1 flags, never auto-creates). A null/blank counterparty is unmatched.
 */
export function vendorFor(
  counterparty: unknown,
  mapping: Mapping,
): string | null {
  return ownLookupNorm(mapping.vendors, strOrNull(counterparty)) ?? null;
}

/**
 * Build the Invoice Ninja expense POST body from a BankTxn (§7.3). PURE — no
 * I/O. The dedup key goes in `custom_value1` (the only writable + `?filter=`-
 * searchable field) and is mirrored to `transaction_reference` for display
 * only. `number` is omitted so IN auto-assigns. An unmatched vendor yields a
 * null `vendor_id` (allowed) and falls the category back to `fallbackCategoryId`.
 *
 * @param txn A candidate BankTxn (§6).
 * @param mapping The resolved mapping tables (§7.3).
 */
export function mapTxnToExpense(
  txn: Record<string, unknown>,
  mapping: Mapping,
): Record<string, unknown> {
  const rawCategory = strOrNull(txn.rawCategory);
  const counterparty = strOrNull(txn.counterparty);
  // HARD-OVERRIDE tier FIRST (vendor-category-override §7.5): a curated vendor→
  // category assignment wins over Mercury's rawCategory. `ownLookupNorm` null-
  // guards an absent `vendorCategories` and falls back to case-insensitive
  // matching (normName: trim + NFC + case-fold) when byte-exact misses — so a
  // config key "ACME INSURANCE CO" catches a bank counterparty "Acme Insurance
  // Co". Same norm-match for the `categories` and fallback tiers. A pre-override
  // Mapping (no `vendorCategories`) falls straight through to the frozen
  // rawCategory → counterparty → fallback order (back-compat).
  const category = ownLookupNorm(mapping.vendorCategories, counterparty) ??
    ownLookupNorm(mapping.categories, rawCategory) ??
    ownLookupNorm(mapping.categories, counterparty) ??
    mapping.fallbackCategoryId;
  return {
    amount: numOrNull(txn.amount),
    date: strOrNull(txn.postedDate),
    currency_id: mapping.currencyId,
    vendor_id: vendorFor(txn.counterparty, mapping), // null allowed
    category_id: category,
    transaction_reference: strOrNull(txn.id), // display mirror
    custom_value1: strOrNull(txn.id), // DEDUP KEY
    public_notes: strOrNull(txn.description),
    // `number` intentionally omitted → IN auto-assigns.
  };
}

/** The outcome of a single {@link upsertExpense}. */
export interface UpsertResult {
  action: "skip" | "would-create" | "created";
  reason?: string;
  expenseId: string | null;
  unmatchedVendor: boolean;
}

/**
 * Check-then-create ONE expense for a BankTxn, idempotent on `custom_value1`
 * (§7.2). Never mutates. Order matters:
 *   0. blank-key guard — never call `?filter=` with `""` (a blank custom_value1
 *      would exact-match every other blank-id row). `reason:"blank-dedup-key"`.
 *   1. non-candidate gate (credit / pending / non-USD) → skip.
 *   2. in-run dedup via `seen` — IN's `?filter=` is NOT read-your-writes, so a
 *      row created earlier in THIS batch may not be searchable yet.
 *   3. PAGINATED dedup: scan every page of `?filter=id` for a row whose
 *      `custom_value1` EXACTLY equals the key (the filter is a substring/multi-
 *      column search — an exact match can sit on page 2). On a match, also
 *      compare amounts and flag `exists-amount-mismatch` for reconcile.
 *   4/5/6. build body; in dryRun return `would-create` (NO POST); else POST.
 * `seen` is populated on BOTH would-create and created so a repeated candidate
 * id is caught in dry-run and real runs alike.
 *
 * @param cfg Resolved config.
 * @param txn A canonical BankTxn (§6).
 * @param mapping The resolved mapping (§7.3).
 * @param dryRun When true, never POSTs.
 * @param doFetch Fetch implementation (injected in tests).
 * @param seen In-run set of dedup keys already would-created/created this batch.
 * @param logger Optional logger.
 */
export async function upsertExpense(
  cfg: GlobalArgs,
  txn: Record<string, unknown>,
  mapping: Mapping,
  dryRun: boolean,
  doFetch?: FetchLike,
  seen?: Set<string>,
  logger?: MethodLogger,
): Promise<UpsertResult> {
  const key = strOrNull(txn.id);
  // (0) blank-key guard — must precede any `?filter=` call.
  if (key === null) {
    return {
      action: "skip",
      reason: "blank-dedup-key",
      expenseId: null,
      unmatchedVendor: false,
    };
  }
  // (1) non-candidate gate. A self-transfer (§6.1) or an owner draw / ATM
  // withdrawal (owner-draw-exclusion) is a non-candidate; surface a distinct
  // reason so the audit distinguishes each from a credit/pending/non-USD skip.
  // Transfer takes precedence over owner-draw when a row is somehow both.
  if (!isCandidate(txn)) {
    return {
      action: "skip",
      reason: txn.isTransfer === true
        ? "transfer"
        : txn.isOwnerDraw === true
        ? "owner-draw"
        : "non-candidate",
      expenseId: null,
      unmatchedVendor: false,
    };
  }
  // (2) in-run dedup.
  if (seen?.has(key)) {
    return {
      action: "skip",
      reason: "in-batch-duplicate",
      expenseId: null,
      unmatchedVendor: false,
    };
  }
  // (3) paginated exact-match dedup. TRASH-INCLUSIVE regardless of
  // cfg.withTrashed: a soft-deleted/archived expense with this key still means
  // the txn was already created once. Excluding trashed rows would let a human
  // deleting an auto-created expense in the IN UI cause a DUPLICATE create on
  // the next run (WSEC — soft-delete idempotency hole). with_trashed=true forces
  // IN to include them in the match set.
  const existing = await inFetchAll(
    cfg,
    "expenses",
    [["filter", key], ["with_trashed", "true"]],
    doFetch,
    logger,
  );
  const match = existing.find((row) => strOrNull(row.custom_value1) === key);
  if (match) {
    const matchAmount = numOrNull(match.amount);
    const txnAmount = numOrNull(txn.amount);
    const mismatch = matchAmount !== null && txnAmount !== null &&
      Math.abs(matchAmount - txnAmount) > 0.01;
    return {
      action: "skip",
      reason: mismatch ? "exists-amount-mismatch" : "already-exists",
      expenseId: strOrNull(match.id),
      unmatchedVendor: false,
    };
  }
  // (4) build body.
  const body = mapTxnToExpense(txn, mapping);
  const unmatchedVendor = body.vendor_id === null;
  // (5) dry-run projection — no write.
  if (dryRun) {
    seen?.add(key);
    return { action: "would-create", expenseId: null, unmatchedVendor };
  }
  // (6) real create.
  const json = await inFetch(cfg, "POST", "expenses", { body }, doFetch);
  const data = (json.data ?? {}) as Record<string, unknown>;
  seen?.add(key);
  return { action: "created", expenseId: strOrNull(data.id), unmatchedVendor };
}

/** Join a resource scope name from a base and optional `key=value` qualifiers. */
function scopeName(
  base: string,
  quals: Array<string | null | undefined>,
): string {
  return [base, ...quals.filter((q): q is string => !!q)].join(":");
}

/**
 * Write a list-snapshot resource in the shared envelope shape ({@link
 * snapshotSchema}) and return the single-handle {@link ExecuteResult}. The one
 * place every list method's snapshot shape is built, so it cannot drift.
 */
async function writeSnapshot(
  context: ExecuteContext,
  spec: string,
  name: string,
  items: unknown[],
): Promise<ExecuteResult> {
  const handle = await context.writeResource(spec, name, {
    scope: name,
    count: items.length,
    items,
    retrievedAt: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Mapping-write path (§7.4) — Phase 6. Auto-create vendors + expense categories
// and derive the frozen Mapping (§7.3) so the sync drops its manual `mapping`
// input. Additive: reuses inFetch/inFetchAll, isCandidate, normalizeMapItem, and
// the single-writer discipline; touches none of the frozen read/write bodies.
// ---------------------------------------------------------------------------

/**
 * The case-insensitive dedup key for reference-data names (§7.4). IN permits
 * duplicate vendor/category names, so `"Nimbus AI"` vs `"anthropic"` is a real
 * collision — normalize (trim + Unicode NFC + case-fold) before comparing. This
 * key is ONLY ever compared/indexed; the raw display spelling is what gets
 * POSTed and stored, never `normName(...)`.
 */
export function normName(s: string): string {
  return s.trim().normalize("NFC").toLowerCase();
}

/**
 * Reduce a list of raw name strings to the distinct set by {@link normName},
 * preserving the FIRST raw spelling seen for each normalized key (that spelling
 * is what a create POSTs). Null and whitespace-only names are dropped — a
 * nameless vendor/category can't be created.
 */
export function distinctByNorm(
  values: Array<string | null>,
): Array<{ norm: string; raw: string }> {
  const seen = new Map<string, string>(); // norm → first raw spelling
  for (const v of values) {
    if (v === null) continue;
    const norm = normName(v);
    if (norm === "") continue; // whitespace-only → un-createable
    if (!seen.has(norm)) seen.set(norm, v);
  }
  return [...seen.entries()].map(([norm, raw]) => ({ norm, raw }));
}

/**
 * Build a `normName → id` index from an existing `{id, name}` snapshot. On a
 * pre-existing IN duplicate name, bind the lexicographically-LOWEST id so the
 * choice is deterministic across runs (§7.4 locked decision 1).
 */
export function buildNameIndex(
  items: Array<Record<string, unknown>>,
): Map<string, string> {
  const idx = new Map<string, string>();
  for (const it of items) {
    const id = strOrNull(it.id);
    const name = strOrNull(it.name);
    if (id === null || name === null) continue;
    const key = normName(name);
    if (key === "") continue;
    const cur = idx.get(key);
    if (cur === undefined || id < cur) idx.set(key, id);
  }
  return idx;
}

/**
 * Build a `rawName → id` map for the emitted Mapping (§7.3). mapTxnToExpense
 * keys vendors/categories by the RAW counterparty/rawCategory string, so the
 * Mapping stores raw-name keys (the case-insensitivity is confined to the
 * create/dedup step). On a duplicate raw name, keep the lowest id (deterministic).
 */
export function rawNameIndex(
  items: Array<Record<string, unknown>>,
): Record<string, string> {
  // Accumulate in a Map (immune to prototype keys), then materialize via
  // Object.fromEntries — which uses [[DefineOwnProperty]], so a category/vendor
  // literally named "__proto__" becomes a real own data property on EVERY
  // runtime (a plain `out[name] = id` hits the legacy __proto__ accessor under
  // Node and silently drops the entry). mapTxnToExpense reads back with
  // Object.hasOwn (ownLookup), so own-data semantics are what it needs.
  const idx = new Map<string, string>();
  for (const it of items) {
    const id = strOrNull(it.id);
    const name = strOrNull(it.name);
    if (id === null || name === null) continue;
    const cur = idx.get(name);
    if (cur === undefined || id < cur) idx.set(name, id);
  }
  return Object.fromEntries(idx) as Record<string, string>;
}

/**
 * Resolve the id whose normalized name equals `normName(name)` in an `{id,name}`
 * snapshot (lowest id wins on a dup), or null when absent. Used to bind the
 * fallback category id case-insensitively.
 */
export function resolveByNorm(
  items: Array<Record<string, unknown>>,
  name: string,
): string | null {
  const target = normName(name);
  let best: string | null = null;
  for (const it of items) {
    const id = strOrNull(it.id);
    const nm = strOrNull(it.name);
    if (id === null || nm === null) continue;
    if (normName(nm) === target && (best === null || id < best)) best = id;
  }
  return best;
}

/**
 * Whether a reference row is NOT soft-deleted (mapping-overlay, gotcha #2). IN
 * returns deleted vendors/categories in both `with_trashed` states, so the dedup
 * index and the emitted Mapping must EXCLUDE them or a deleted target id gets
 * bound (4 of 5 real "Nimbus" vendors are deleted). `!== true` treats an
 * ABSENT `isDeleted` (a pre-fix snapshot) as NOT deleted — kept, back-compat.
 * Archived-but-not-deleted rows are kept for v1 (IN still allows assignment).
 */
export function notDeleted(row: Record<string, unknown>): boolean {
  return row.isDeleted !== true;
}

/**
 * Translate a raw source name through a curated overlay (mapping-overlay). The
 * key match is CASE/WHITESPACE-INSENSITIVE via {@link normName} — consistent
 * with the create/dedup pipeline (distinctByNorm/buildNameIndex), so a hand-
 * authored config `{"Nimbus AI":"Nimbus"}` still catches a bank counterparty
 * that arrives as `"ANTHROPIC"` or `"Nimbus AI "` (COR-1). Without this the
 * overlay would silently miss and upsertVendors would create a DUPLICATE vendor
 * under the raw spelling — the very sprawl this feature prevents. Returns the
 * overlay's TARGET on a normalized-key match, else the raw name unchanged. Null
 * passes through as null. Iterating `Object.entries` is own-keys only (no
 * prototype surface — a key named `__proto__` is just a string compared by
 * value), and overlays are a handful of entries so the per-call scan is trivial.
 */
export function applyOverlay(
  rawName: string | null,
  overlay: Record<string, string>,
): string | null {
  if (rawName === null) return null;
  const key = normName(rawName);
  for (const [k, target] of Object.entries(overlay)) {
    if (normName(k) === key) return target;
  }
  return rawName;
}

/**
 * The overlay TARGET for a raw name, or `null` when no key matches — unlike
 * {@link applyOverlay}, which returns the raw name unchanged on a miss. Keys
 * match case-insensitively via {@link normName}. Used by
 * `upsertExpenseCategories` to ensure ONLY the genuinely-needed
 * `vendorCategoryOverlay` targets (§7.5) — a counterparty with no overlay entry
 * contributes no category to create.
 */
export function overlayTargetFor(
  rawName: string | null,
  overlay: Record<string, string>,
): string | null {
  if (rawName === null) return null;
  const key = normName(rawName);
  for (const [k, target] of Object.entries(overlay)) {
    if (normName(k) === key) return target;
  }
  return null;
}

/**
 * Build the overlay ALIAS table for the emitted Mapping (§7.3): for each raw name
 * that has an overlay entry, resolve the TARGET's id (case-insensitively, over
 * the DELETED-FILTERED snapshot) and emit `{rawName → targetId}`. mapTxnToExpense
 * keys by the RAW counterparty/rawCategory, so this alias makes a raw name
 * resolve to its curated target's id (e.g. `Nimbus AI → id(Nimbus)`). An
 * overlay whose target is absent from the snapshot is DROPPED with a warning —
 * never a bad/undefined bind, never a throw. Accumulated in a Map + materialized
 * via Object.fromEntries so a raw key named `__proto__` becomes a real own prop
 * (same discipline as {@link rawNameIndex}).
 */
export function overlayAliases(
  rawNames: Array<string | null>,
  overlay: Record<string, string>,
  filteredItems: Array<Record<string, unknown>>,
  logger?: MethodLogger,
): Record<string, string> {
  const idx = new Map<string, string>();
  for (const raw of rawNames) {
    if (raw === null) continue;
    if (!Object.hasOwn(overlay, raw)) continue;
    const target = overlay[raw];
    const id = resolveByNorm(filteredItems, target);
    if (id === null) {
      logger?.warning(
        "overlay target {target} for {raw} not found in the snapshot — alias dropped",
        { target, raw },
      );
      continue;
    }
    if (!idx.has(raw)) idx.set(raw, id);
  }
  return Object.fromEntries(idx) as Record<string, string>;
}

/** The outcome of a {@link syncReferenceEntities} run (before resource shaping). */
export interface RefSyncOutcome {
  rows: Array<{
    name: string;
    action: "skip" | "would-create" | "created";
    id: string | null;
    reason?: string;
  }>;
  errors: Array<
    { name: string; error: string; attemptedAt: string; dryRun: boolean }
  >;
  createdCount: number;
  /**
   * The raw `{id,name}` rows fetched for the dedup index — returned so the
   * caller can refresh the snapshot after a real run WITHOUT a second GET when
   * nothing was created (createdCount === 0). On a run that created rows, the
   * caller re-fetches instead (to pick up the new hashids).
   */
  existingRows: Array<Record<string, unknown>>;
}

/**
 * Check-then-create the distinct reference entities of one kind (vendors OR
 * expense categories), idempotent on {@link normName}. Shared core of
 * upsertVendors/upsertExpenseCategories — the ONLY differences between the two
 * callers are the endpoint path, the distinct-set derivation, and the audit id
 * field, all supplied by the caller. Mirrors the upsertExpenses discipline:
 * SEQUENTIAL single-writer loop, per-item try/catch (one failure never aborts
 * the batch). Never writes resources — the caller flushes the audit in a finally.
 *
 * @param cfg Resolved config.
 * @param path The IN REST path for both the list GET and the create POST
 *   (`vendors` | `expense_categories`).
 * @param distinct Distinct `{norm, raw}` entities to ensure (already deduped).
 * @param dryRun When true, `would-create` and NO POST.
 * @param doFetch Injected fetch.
 * @param logger Optional logger.
 */
export async function syncReferenceEntities(
  cfg: GlobalArgs,
  path: string,
  distinct: Array<{ norm: string; raw: string }>,
  dryRun: boolean,
  doFetch?: FetchLike,
  logger?: MethodLogger,
): Promise<RefSyncOutcome> {
  const existingRows = await inFetchAll(cfg, path, [], doFetch, logger);
  // mapping-overlay (gotcha #2): existingRows are RAW IN rows (snake_case
  // `is_deleted`), and IN returns soft-deleted rows in both with_trashed states.
  // Exclude deleted rows from the dedup index so a soft-deleted vendor/category
  // does NOT suppress a needed create (its normalized name would otherwise be
  // treated as "already-exists" and bind the DEAD id). `!== true` keeps a row
  // whose is_deleted is absent/false.
  const liveRows = existingRows.filter((r) =>
    boolOrNull(r.is_deleted) !== true
  );
  const existing = buildNameIndex(liveRows);
  const seen = new Set<string>();
  const rows: RefSyncOutcome["rows"] = [];
  const errors: RefSyncOutcome["errors"] = [];
  let createdCount = 0;
  for (const { norm, raw } of distinct) {
    try {
      if (existing.has(norm)) {
        rows.push({
          name: raw,
          action: "skip",
          id: existing.get(norm) ?? null,
          reason: "already-exists",
        });
      } else if (seen.has(norm)) {
        // Defensive: distinct already dedups, but guard against a caller passing
        // a non-deduped list.
        rows.push({
          name: raw,
          action: "skip",
          id: null,
          reason: "in-batch-duplicate",
        });
      } else if (dryRun) {
        seen.add(norm);
        rows.push({ name: raw, action: "would-create", id: null });
      } else {
        const json = await inFetch(
          cfg,
          "POST",
          path,
          { body: { name: raw } },
          doFetch,
        );
        const data = (json.data ?? {}) as Record<string, unknown>;
        seen.add(norm);
        createdCount++;
        rows.push({ name: raw, action: "created", id: strOrNull(data.id) });
      }
    } catch (e) {
      // A single failed create MUST NOT abort the batch (mirrors WSPEC-04).
      logger?.warning("reference create failed for {name}", { name: raw });
      errors.push({
        name: raw,
        error: e instanceof Error ? e.message : String(e),
        attemptedAt: new Date().toISOString(),
        dryRun,
      });
    }
  }
  return { rows, errors, createdCount, existingRows };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

export const model = {
  type: "@shrug/invoiceninja",
  version: "2026.07.21.1",
  description:
    "Invoice Ninja v5 (/api/v1): read invoices/payments/expenses + mapping " +
    "lists, an idempotent gated-write upsertExpense (dedup on custom_value1), and " +
    "a mapping-write path (upsertVendors/upsertExpenseCategories/buildMapping) that " +
    "auto-creates reference data and derives the Mapping. All writes gated behind " +
    "dryRun (default true).",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.19.3",
      description:
        "Add deleted-matched cross-check to reconcile report (report-only, no schema change)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.21.1",
      description:
        "Docs + quality-rating cleanup: rewrote README (was stale at Phase-0 skeleton), enriched manifest description, removed unused ownLookup helper (superseded by ownLookupNorm, no callers). No schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "invoices": {
      description: "An invoice list snapshot (§4.3)",
      schema: InvoiceListSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "invoice": {
      description: "A single detailed invoice (`/invoices/{id}`)",
      schema: SingleSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "payments": {
      description: "A payment list snapshot (§4.3)",
      schema: PaymentListSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "expenses": {
      description: "An expense list snapshot (§4.3; carries custom_value1)",
      schema: ExpenseListSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "expenseCategories": {
      description: "Expense-category mapping list (`/expense_categories`)",
      schema: MapListSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "vendors": {
      description: "Vendor mapping list (`/vendors`)",
      schema: MapListSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "expenseSync": {
      description: "One row per txn processed by upsertExpense (§4.4)",
      schema: ExpenseSyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "expenseSyncErrors": {
      description:
        "Durable audit of failed write attempts (additive, WSPEC-04) — one row " +
        "per txn whose POST threw; kept separate from the frozen expenseSync.",
      schema: ExpenseSyncErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "vendorSync": {
      description:
        "One row per distinct vendor processed by upsertVendors (§7.4).",
      schema: VendorSyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "vendorSyncErrors": {
      description:
        "Durable audit of failed vendor creates (§7.4) — flushed even when empty.",
      schema: RefSyncErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "categorySync": {
      description:
        "One row per distinct category processed by upsertExpenseCategories (§7.4).",
      schema: CategorySyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "categorySyncErrors": {
      description:
        "Durable audit of failed category creates (§7.4) — flushed even when empty.",
      schema: RefSyncErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "mapping": {
      description:
        "The derived Mapping (§7.3) emitted by buildMapping; the sync consumes it " +
        "via CEL, dropping the manual mapping input.",
      schema: MappingSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    // --- Read methods (§4.3) — Phase 1a ---
    listInvoices: {
      description:
        "GET /invoices (paginated, include=client) → invoices snapshot with " +
        "status labels + computed overdue.",
      arguments: z.object({
        clientId: z.string().optional(),
        clientStatus: z.string().optional().describe('e.g. "1,2,3,4"'),
      }),
      execute: async (
        args: { clientId?: string; clientStatus?: string; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const query: Array<[string, string]> = [["include", "client"]];
        if (args.clientId) query.push(["client_id", args.clientId]);
        if (args.clientStatus) query.push(["client_status", args.clientStatus]);
        context.logger.info("Fetching invoices");
        const rows = await inFetchAll(
          cfg,
          "invoices",
          query,
          args._fetch,
          context.logger,
        );
        // Overdue is derived against the UTC calendar date. IN due dates are
        // TZ-less calendar dates, so near midnight this can disagree with IN's
        // own local-time overdue view by up to the business's UTC offset. A
        // business-timezone config is deferred (the §4.1 config is frozen for
        // this phase); documented as a known limitation.
        const today = new Date().toISOString().slice(0, 10);
        const items = rows.map((r) => normalizeInvoice(r, today));
        context.logger.info("{count} invoices", { count: items.length });
        const name = scopeName("invoices", [
          args.clientId && `client=${encodeURIComponent(args.clientId)}`,
          args.clientStatus &&
          `status=${encodeURIComponent(args.clientStatus)}`,
        ]);
        return writeSnapshot(context, "invoices", name, items);
      },
    },
    getInvoice: {
      description:
        "GET /invoices/{id}?include=client,payments,activities → invoice.",
      arguments: z.object({
        // Constrain to the IN hashid charset (alphanumeric). The token is
        // full-account, so an unvalidated id interpolated into the path (e.g.
        // "../../users/5") would let a caller reach arbitrary host endpoints
        // with the vaulted token — this regex is the security boundary.
        id: z.string().regex(
          /^[A-Za-z0-9]+$/,
          "IN hashid must be alphanumeric (no path separators)",
        ),
      }),
      execute: async (
        args: { id: string; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        context.logger.info("Fetching invoice {id}", { id: args.id });
        const json = await inFetch(
          cfg,
          "GET",
          `invoices/${args.id}`,
          { query: [["include", "client,payments,activities"]] },
          args._fetch,
        );
        const raw = (json.data ?? {}) as Record<string, unknown>;
        const handle = await context.writeResource(
          "invoice",
          `invoice:${args.id}`,
          {
            id: args.id,
            raw,
            retrievedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    listPayments: {
      description:
        "GET /payments (paginated, include=invoices,client) → payments " +
        "snapshot with appliedInvoices flattened from paymentables.",
      arguments: z.object({
        clientId: z.string().optional(),
      }),
      execute: async (
        args: { clientId?: string; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const query: Array<[string, string]> = [["include", "invoices,client"]];
        if (args.clientId) query.push(["client_id", args.clientId]);
        context.logger.info("Fetching payments");
        const rows = await inFetchAll(
          cfg,
          "payments",
          query,
          args._fetch,
          context.logger,
        );
        const items = rows.map((r) => normalizePayment(r));
        context.logger.info("{count} payments", { count: items.length });
        const name = scopeName("payments", [
          args.clientId && `client=${encodeURIComponent(args.clientId)}`,
        ]);
        return writeSnapshot(context, "payments", name, items);
      },
    },
    listExpenses: {
      description:
        "GET /expenses (paginated, include=vendor,category,client) → expenses " +
        "snapshot (custom_value1 dedup mirror). ?filter= searches custom_value1.",
      arguments: z.object({
        clientId: z.string().optional(),
        vendorId: z.string().optional(),
        categoryId: z.string().optional(),
        filter: z.string().optional().describe(
          "?filter= (searches custom_value1)",
        ),
      }),
      execute: async (
        args: {
          clientId?: string;
          vendorId?: string;
          categoryId?: string;
          filter?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const query: Array<[string, string]> = [
          ["include", "vendor,category,client"],
        ];
        if (args.clientId) query.push(["client_id", args.clientId]);
        if (args.vendorId) query.push(["vendor_id", args.vendorId]);
        if (args.categoryId) query.push(["category_id", args.categoryId]);
        if (args.filter) query.push(["filter", args.filter]);
        context.logger.info("Fetching expenses");
        const rows = await inFetchAll(
          cfg,
          "expenses",
          query,
          args._fetch,
          context.logger,
        );
        const items = rows.map((r) => normalizeExpense(r));
        context.logger.info("{count} expenses", { count: items.length });
        const name = scopeName("expenses", [
          args.clientId && `client=${encodeURIComponent(args.clientId)}`,
          args.vendorId && `vendor=${encodeURIComponent(args.vendorId)}`,
          args.categoryId && `category=${encodeURIComponent(args.categoryId)}`,
          // `filter` is free text (mirrors external bank-txn data) — encode it
          // so a value containing ':' can't collide with the scope delimiter.
          args.filter && `filter=${encodeURIComponent(args.filter)}`,
        ]);
        return writeSnapshot(context, "expenses", name, items);
      },
    },
    expenseCategories: {
      description:
        "GET /expense_categories (paginated) → expenseCategories mapping snapshot.",
      arguments: z.object({}),
      execute: async (
        args: { _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        context.logger.info("Fetching expense categories");
        const rows = await inFetchAll(
          cfg,
          "expense_categories",
          [],
          args._fetch,
          context.logger,
        );
        const items = rows.map((r) => normalizeMapItem(r));
        return writeSnapshot(
          context,
          "expenseCategories",
          "expenseCategories",
          items,
        );
      },
    },
    vendors: {
      description: "GET /vendors (paginated) → vendors mapping snapshot.",
      arguments: z.object({}),
      execute: async (
        args: { _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        context.logger.info("Fetching vendors");
        const rows = await inFetchAll(
          cfg,
          "vendors",
          [],
          args._fetch,
          context.logger,
        );
        const items = rows.map((r) => normalizeMapItem(r));
        return writeSnapshot(context, "vendors", "vendors", items);
      },
    },
    // --- Gated write (§4.4/§7) — Phase 2. Fan-out preferred (per-model lock). ---
    upsertExpenses: {
      description:
        "Check-then-create expenses for a BankTxn[] (dedup on custom_value1). " +
        "Single-writer fan-out; dryRun default true. → expenseSync (+ " +
        "expenseSyncErrors for failed attempts).",
      arguments: z.object({
        txns: z.array(z.record(z.string(), z.unknown())).describe(
          "BankTxn[] (§6)",
        ),
        mapping: z.record(z.string(), z.unknown()).describe(
          "vendor/category/currency mapping tables (§7.3)",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true).",
        ),
      }),
      execute: async (
        args: {
          txns: Array<Record<string, unknown>>;
          mapping: Mapping;
          dryRun?: boolean;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        const mapping = args.mapping;
        // Single-writer: iterate SEQUENTIALLY (no parallel per-txn calls; the
        // check-then-create TOCTOU window is closed only by single-writer
        // discipline + the per-model lock — repo rule 6 / §7.2 / WSPEC-07).
        const seen = new Set<string>();
        const rows: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];
        const now = () => new Date().toISOString();
        // Assigned in the finally below (always runs before the return).
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        try {
          for (const txn of args.txns) {
            try {
              const r = await upsertExpense(
                cfg,
                txn,
                mapping,
                dryRun,
                args._fetch,
                seen,
                context.logger,
              );
              rows.push({
                dedupKey: strOrNull(txn.id) ?? "",
                action: r.action,
                expenseId: r.expenseId,
                amount: numOrNull(txn.amount),
                date: strOrNull(txn.postedDate),
                unmatchedVendor: r.unmatchedVendor,
              });
              // A blank dedup key is a skip AND a surfaced error (§ blank guard).
              if (r.reason === "blank-dedup-key") {
                errors.push({
                  dedupKey: "",
                  amount: numOrNull(txn.amount),
                  currency: strOrNull(txn.currency),
                  error: "blank-dedup-key",
                  attemptedAt: now(),
                  dryRun,
                });
              }
            } catch (e) {
              // A single failure MUST NOT abort the batch (WSPEC-04).
              context.logger.warning("upsertExpense failed for {key}", {
                key: strOrNull(txn.id),
              });
              errors.push({
                dedupKey: strOrNull(txn.id) ?? "",
                amount: numOrNull(txn.amount),
                currency: strOrNull(txn.currency),
                error: e instanceof Error ? e.message : String(e),
                attemptedAt: now(),
                dryRun,
              });
            }
          }
        } finally {
          // Flush BOTH, even on an unexpected throw, so every real create keeps
          // its audit row and every failure keeps a durable, queryable row
          // (WSPEC-04). expenseSyncErrors is flushed ALWAYS (even empty) so a
          // consumer can tell "0 errors this run" from "never ran".
          syncHandle = await context.writeResource(
            "expenseSync",
            "expenseSync",
            { scope: "expenseSync", rows, dryRun, retrievedAt: now() },
          );
          errHandle = await context.writeResource(
            "expenseSyncErrors",
            "expenseSyncErrors",
            { scope: "expenseSyncErrors", rows: errors, retrievedAt: now() },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    // --- Mapping-write (§7.4) — Phase 6. Fan-out; single-writer; dryRun default. ---
    upsertVendors: {
      description:
        "Auto-create IN vendors for the distinct counterparties of candidate " +
        "debits (dedup on normalized name). Single-writer fan-out; dryRun default " +
        "true. → vendorSync (+ vendorSyncErrors); refreshes the vendors snapshot " +
        "after a real create.",
      arguments: z.object({
        txns: z.array(z.record(z.string(), z.unknown())).describe(
          "BankTxn[] (§6)",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true).",
        ),
      }),
      execute: async (
        args: {
          txns: Array<Record<string, unknown>>;
          dryRun?: boolean;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        const now = () => new Date().toISOString();
        // Distinct counterparties over CANDIDATE debits only (§7.4 decision 2) —
        // credits/pending/non-USD never spawn reference data. mapping-overlay:
        // translate each raw counterparty through cfg.vendorOverlay BEFORE
        // dedup, so the auto-create set is the curated TARGET names (e.g.
        // "Nimbus AI" → "Nimbus" is NOT re-created; "WIDGETCO TEAM" →
        // "Widget.Club" creates the target).
        const distinct = distinctByNorm(
          args.txns.filter(isCandidate).map((t) =>
            applyOverlay(strOrNull(t.counterparty), cfg.vendorOverlay ?? {})
          ),
        );
        let outcome: RefSyncOutcome = {
          rows: [],
          errors: [],
          createdCount: 0,
          existingRows: [],
        };
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        try {
          outcome = await syncReferenceEntities(
            cfg,
            "vendors",
            distinct,
            dryRun,
            args._fetch,
            context.logger,
          );
          // After a REAL run ALWAYS refresh the vendors snapshot so buildMapping
          // /reconcile see current IN state (SEC-2/COR-1): re-fetch when rows were
          // created (to pick up the new hashids), else reuse the list
          // syncReferenceEntities already fetched — no second GET. dryRun changed
          // nothing → no refresh.
          if (!dryRun) {
            const refreshed = outcome.createdCount > 0
              ? await inFetchAll(
                cfg,
                "vendors",
                [],
                args._fetch,
                context.logger,
              )
              : outcome.existingRows;
            await writeSnapshot(
              context,
              "vendors",
              "vendors",
              refreshed.map((r) => normalizeMapItem(r)),
            );
          }
        } finally {
          // Flush ALWAYS (even empty) — "0 errors this run" != "never ran".
          syncHandle = await context.writeResource("vendorSync", "vendorSync", {
            scope: "vendorSync",
            rows: outcome.rows.map((r) => ({
              name: r.name,
              action: r.action,
              vendorId: r.id,
              ...(r.reason ? { reason: r.reason } : {}),
            })),
            dryRun,
            retrievedAt: now(),
          });
          errHandle = await context.writeResource(
            "vendorSyncErrors",
            "vendorSyncErrors",
            {
              scope: "vendorSyncErrors",
              rows: outcome.errors,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    upsertExpenseCategories: {
      description:
        "Auto-create IN expense categories for the distinct rawCategories of " +
        "candidate debits (dedup on normalized name), ALWAYS ensuring the " +
        "fallback category. Single-writer fan-out; dryRun default true. → " +
        "categorySync (+ categorySyncErrors); refreshes the expenseCategories snapshot.",
      arguments: z.object({
        txns: z.array(z.record(z.string(), z.unknown())).describe(
          "BankTxn[] (§6)",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true).",
        ),
        fallbackName: z.string().optional().describe(
          "Fallback category name always ensured; default 'Uncategorized'.",
        ),
      }),
      execute: async (
        args: {
          txns: Array<Record<string, unknown>>;
          dryRun?: boolean;
          fallbackName?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        const fallbackName = args.fallbackName ?? "Uncategorized";
        const now = () => new Date().toISOString();
        // Distinct rawCategories over candidate debits, with the fallback ALWAYS
        // appended so the fallback category is guaranteed to exist (§7.4).
        // mapping-overlay: translate each raw category through cfg.categoryOverlay
        // BEFORE dedup (e.g. "Software" → "Software & Subscriptions"). The
        // fallback is appended AS-IS (it is already a target name).
        const vendorCategoryOverlay = cfg.vendorCategoryOverlay ?? {};
        const vcOverlayEntries = Object.entries(vendorCategoryOverlay);
        // vendor-category-override (§7.5, HARD-OVERRIDE): ensure the TARGET category
        // for EVERY candidate debit whose counterparty matches an overlay key — NOT
        // only uncategorized ones. Under hard-override a matched vendor's real-
        // rawCategory rows ALSO route to the vendor category, so the target must
        // exist whenever the counterparty matches (the FALLBACK variant's COR-3
        // rawCategory===null guard is deliberately removed). The mapping consume
        // (mapTxnToExpense) matches case-insensitively via normName, so a case/
        // whitespace-variant key DOES resolve — log at info for auditability
        // (operator can normalize the config key to the exact BankTxn.counterparty
        // spelling to silence the note, but it's not required for correctness).
        const vendorCatTargets: string[] = [];
        for (const t of args.txns.filter(isCandidate)) {
          const cp = strOrNull(t.counterparty);
          if (cp === null) continue;
          const key = normName(cp);
          for (const [k, target] of vcOverlayEntries) {
            if (normName(k) !== key) continue;
            vendorCatTargets.push(target);
            if (k !== cp) {
              context.logger.info(
                "vendorCategoryOverlay key {key} is a case/whitespace variant of " +
                  "the observed counterparty {cp} — the category bind matches case-" +
                  "insensitively (normName), so this row resolves correctly. " +
                  "Normalize the config key to the exact BankTxn.counterparty " +
                  "spelling to silence this note.",
                { key: k, cp },
              );
            }
            break;
          }
        }
        const distinct = distinctByNorm([
          ...args.txns.filter(isCandidate).map((t) =>
            applyOverlay(strOrNull(t.rawCategory), cfg.categoryOverlay ?? {})
          ),
          ...vendorCatTargets,
          fallbackName,
        ]);
        let outcome: RefSyncOutcome = {
          rows: [],
          errors: [],
          createdCount: 0,
          existingRows: [],
        };
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        try {
          outcome = await syncReferenceEntities(
            cfg,
            "expense_categories",
            distinct,
            dryRun,
            args._fetch,
            context.logger,
          );
          // After a REAL run ALWAYS refresh the expenseCategories snapshot (see
          // the upsertVendors note): re-fetch on a create, else reuse the fetched
          // list. dryRun → no refresh.
          if (!dryRun) {
            const refreshed = outcome.createdCount > 0
              ? await inFetchAll(
                cfg,
                "expense_categories",
                [],
                args._fetch,
                context.logger,
              )
              : outcome.existingRows;
            await writeSnapshot(
              context,
              "expenseCategories",
              "expenseCategories",
              refreshed.map((r) => normalizeMapItem(r)),
            );
          }
        } finally {
          syncHandle = await context.writeResource(
            "categorySync",
            "categorySync",
            {
              scope: "categorySync",
              rows: outcome.rows.map((r) => ({
                name: r.name,
                action: r.action,
                categoryId: r.id,
                ...(r.reason ? { reason: r.reason } : {}),
              })),
              dryRun,
              retrievedAt: now(),
            },
          );
          errHandle = await context.writeResource(
            "categorySyncErrors",
            "categorySyncErrors",
            {
              scope: "categorySyncErrors",
              rows: outcome.errors,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    buildMapping: {
      description:
        "PURE derive (no IN fetch): read the latest vendors + expenseCategories " +
        "snapshots (refreshed by the two upserts) and emit the frozen Mapping " +
        "(§7.3) as the `mapping` resource — currencyId + raw-name→id tables + a " +
        "case-insensitively resolved fallbackCategoryId. THROWS if the fallback " +
        "is unresolved (a Mapping with no fallback is unusable).",
      arguments: z.object({
        currencyId: z.string().describe(
          "IN currency hashid (USD-only v1, §12.4).",
        ),
        fallbackCategoryName: z.string().optional().describe(
          "Category whose id becomes fallbackCategoryId; default 'Uncategorized'.",
        ),
      }),
      execute: async (
        args: { currencyId: string; fallbackCategoryName?: string },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const vendorOverlay = cfg.vendorOverlay ?? {};
        const categoryOverlay = cfg.categoryOverlay ?? {};
        const vendorCategoryOverlay = cfg.vendorCategoryOverlay ?? {};
        const fallbackName = args.fallbackCategoryName ?? "Uncategorized";
        // Read the snapshots the two upserts just refreshed (this method depends
        // on them — enforced by workflow ordering, §9.1 Phase-6 variant).
        const read = context.readResource;
        if (!read) {
          throw new Error(
            "buildMapping: context.readResource unavailable — cannot read the " +
              "vendors/expenseCategories snapshots.",
          );
        }
        const vendorsSnap = await read("vendors");
        const catsSnap = await read("expenseCategories");
        // A null snapshot means the resource was NEVER written (the read method
        // and a real upsert both write it) — distinct from a legitimately empty
        // one. Warn so an operator isn't misled by a silently vendor-less mapping
        // (SEC-2/COR-1); the fallback throw below still guards the category side.
        if (vendorsSnap === null) {
          context.logger.warning(
            "buildMapping: no `vendors` snapshot found — mapping will have NO " +
              "vendor attribution. Run the vendors read (or upsertVendors) first.",
          );
        }
        if (catsSnap === null) {
          context.logger.warning(
            "buildMapping: no `expenseCategories` snapshot found — run the " +
              "expenseCategories read (or upsertExpenseCategories) first.",
          );
        }
        const vendorItemsAll =
          (Array.isArray(vendorsSnap?.items) ? vendorsSnap.items : []) as Array<
            Record<string, unknown>
          >;
        const catItemsAll =
          (Array.isArray(catsSnap?.items) ? catsSnap.items : []) as Array<
            Record<string, unknown>
          >;
        // mapping-overlay (gotcha #2): EXCLUDE soft-deleted reference rows before
        // indexing/resolving — IN returns them in the snapshot (4 of 5 real
        // "Nimbus" vendors are deleted), and binding a dead id would send
        // expenses to a vendor that no longer exists. All downstream resolution
        // (rawNameIndex, resolveByNorm for the fallback, overlay targets) runs
        // over the live-only items.
        const vendorItems = vendorItemsAll.filter(notDeleted);
        const catItems = catItemsAll.filter(notDeleted);
        const fallbackCategoryId = resolveByNorm(catItems, fallbackName);
        if (fallbackCategoryId === null) {
          // No partial mapping — mapTxnToExpense REQUIRES fallbackCategoryId.
          throw new Error(
            `buildMapping: fallback category "${fallbackName}" not present (live) in the ` +
              "expenseCategories snapshot; run upsertExpenseCategories (dryRun=false) first.",
          );
        }
        context.logger.info(
          "Building mapping ({vendors}/{vendorsAll} live vendors, {cats}/{catsAll} live categories)",
          {
            vendors: vendorItems.length,
            vendorsAll: vendorItemsAll.length,
            cats: catItems.length,
            catsAll: catItemsAll.length,
          },
        );
        // mapping-overlay: merge the curated aliases AFTER the by-own-name index
        // so an overlayed RAW name (keyed off the overlay config) resolves to its
        // TARGET id (e.g. mapping.vendors["Nimbus AI"] = id(active "Nimbus")).
        // The overlay keys ARE the raw source names to alias.
        // `categories` is the rawCategory/counterparty lookup table (§7.3): own
        // category names + categoryOverlay aliases only. The vendor-category-
        // override (§7.5) counterparty→category aliases go into the SEPARATE
        // `vendorCategories` field below — a disjoint namespace, so a counterparty
        // whose name coincides with a real category can never clobber that
        // category's rawCategory binding (retires COR-1/F2; no collision guard
        // needed). Object.fromEntries + rawNameIndex keep both maps prototype-safe.
        const handle = await context.writeResource("mapping", "mapping", {
          scope: "mapping",
          currencyId: args.currencyId,
          fallbackCategoryId,
          vendors: {
            ...rawNameIndex(vendorItems),
            ...overlayAliases(
              Object.keys(vendorOverlay),
              vendorOverlay,
              vendorItems,
              context.logger,
            ),
          },
          categories: {
            ...rawNameIndex(catItems),
            ...overlayAliases(
              Object.keys(categoryOverlay),
              categoryOverlay,
              catItems,
              context.logger,
            ),
          },
          // HARD-OVERRIDE tier (§7.5): counterparty → target-category id, consulted
          // by mapTxnToExpense BEFORE `categories`. Unresolved target dropped with a
          // warning inside overlayAliases (never a bad bind).
          vendorCategories: overlayAliases(
            Object.keys(vendorCategoryOverlay),
            vendorCategoryOverlay,
            catItems,
            context.logger,
          ),
          retrievedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
