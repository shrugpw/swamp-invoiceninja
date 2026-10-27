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
 * §7.6 (dry-run mapping projection) is an ADDITIVE follow-up to Phase 6:
 * `buildMapping`, when `dryRun` is true, unions would-create vendor/category
 * names (from the `vendorSync`/`categorySync` previews) into the emitted
 * Mapping bound to the `DRYRUN_SENTINEL` id, so an all-dryRun preview resolves
 * them instead of reporting a phantom unmatched vendor/category; `dryRun=false`
 * stays byte-for-byte unchanged. `mapTxnToExpense` remains frozen throughout.
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
import {
  aggregateFinops,
  type FinopsRepo,
  renderDetailedMarkdown,
  renderEmailHtml,
  renderSummaryMarkdown,
} from "../reports/_lib/finops.ts";

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
  // ADDITIVE (clients surface, design/invoiceninja-entity-crud.md §1) — TTL for
  // the getClients `clients` snapshot. Short by default so client PII auto-
  // expires from the datastore rather than lingering (the read snapshot is the
  // only place normalized client names/emails are stored). Accepts any swamp
  // duration ("1h","24h","7d") or "infinite". getClients passes this as the
  // per-write lifetime override; the resource's declared default is also "1h".
  clientSnapshotLifetime: z
    .string()
    // Validate the TTL format (CLI-SEC-2): this is the sole safeguard against
    // client PII lingering, so a typo ("1hr","0","") must fail LOUDLY at config
    // time rather than silently fall through to writeResource and risk a
    // fail-open (no-expiry) snapshot. Accepts a swamp duration or "infinite".
    .regex(
      /^(infinite|\d+(s|m|h|d|w))$/,
      "must be 'infinite' or a swamp duration like '1h','24h','7d'",
    )
    .default("1h")
    .describe(
      "TTL for the getClients `clients` PII snapshot (§1). Short by default so " +
        "client PII auto-expires. Any swamp duration ('1h','24h','7d') or " +
        "'infinite'.",
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
  if (v === null || v === undefined) return null;
  // Treat a blank/whitespace-only string as absent, not as Number("  ")===0
  // (PRJ-COR-2): otherwise a whitespace numeric input would emit a spurious 0.
  if (typeof v === "string" && v.trim() === "") return null;
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

// ADDITIVE (projects surface, design/invoiceninja-entity-crud.md §2). Projects
// are low-PII (names, budgets, rates) — normal infinite/GC-20 treatment (NOT the
// short/sensitive stance clients get). Row is the §2 shape.
const ProjectSchema = z.object({
  id: z.string().describe("Hashed IN id — never coerced to int"),
  number: z.string().nullable(),
  name: z.string().nullable(),
  clientId: z.string().nullable(),
  taskRate: z.number().nullable(),
  budgetedHours: z.number().nullable(),
  dueDate: z.string().nullable(),
  isDeleted: z.boolean().nullable(),
  archivedAt: z.number().nullable().describe("Unix ts; 0/absent → null"),
});

/** Normalize a raw `/projects` row (§2). */
export function normalizeProject(
  raw: Record<string, unknown>,
): z.infer<typeof ProjectSchema> {
  const archivedAt = numOrNull(raw.archived_at);
  return {
    id: strOrNull(raw.id) ?? "",
    number: strOrNull(raw.number),
    name: strOrNull(raw.name),
    clientId: strOrNull(raw.client_id),
    taskRate: numOrNull(raw.task_rate),
    budgetedHours: numOrNull(raw.budgeted_hours),
    dueDate: strOrNull(raw.due_date),
    isDeleted: boolOrNull(raw.is_deleted),
    archivedAt: archivedAt && archivedAt > 0 ? archivedAt : null,
  };
}

// ---------------------------------------------------------------------------
// Task normalization (design/invoiceninja-entity-crud.md §3). A task's running
// state lives in `time_log` — a JSON array of `[start_epoch, stop_epoch]` pairs
// (IN returns it as a JSON STRING on the wire, occasionally already an array).
// An OPEN pair (`stop == 0` or absent) means the timer is running. `parseTimeLog`
// + `isRunning` are PURE (unit-tested; mirror `computedInvoiceStatus`); the timer
// surface (startTask/stopTask, a separate work item) reuses `isRunning` verbatim.
// ---------------------------------------------------------------------------

/**
 * Parse IN's `time_log` into normalized `[start, stop]` epoch-second pairs.
 * Accepts a JSON STRING (the wire form), an already-parsed array, or anything
 * else (→ `[]`). Each pair is coerced through {@link numOrNull}; an ABSENT or
 * non-finite member becomes `0` (so a one-element `[start]` pair reads as OPEN,
 * matching IN's running-timer convention). A non-array entry is dropped. PURE —
 * no I/O, no throw: a malformed string is caught and yields `[]`.
 */
export function parseTimeLog(raw: unknown): Array<[number, number]> {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return [];
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: Array<[number, number]> = [];
  for (const entry of arr) {
    if (!Array.isArray(entry)) continue; // drop a malformed (non-pair) entry
    out.push([numOrNull(entry[0]) ?? 0, numOrNull(entry[1]) ?? 0]);
  }
  return out;
}

/**
 * Whether a task's timer is RUNNING: true iff any `time_log` pair is OPEN
 * (`stop == 0` or absent). Accepts the RAW `time_log` (string | array | absent)
 * and is fully robust via {@link parseTimeLog} — an empty log or malformed input
 * is not running. PURE (mirrors {@link computedInvoiceStatus}); the timer surface
 * reuses this to decide start/stop idempotency without re-deriving the rule.
 */
export function isRunning(rawTimeLog: unknown): boolean {
  return parseTimeLog(rawTimeLog).some(([, stop]) => stop === 0);
}

/** A normalized task row (§3). `timeLog` is parsed pairs; `isRunning` derived. */
const TaskSchema = z.object({
  id: z.string().describe("Hashed IN id — never coerced to int"),
  number: z.string().nullable().describe(
    "IN's auto-managed task number — NOT the caller key (see customValue1)",
  ),
  customValue1: z.string().nullable().describe(
    "Caller-stable dedup key: upsertTasks writes the caller's key here because " +
      "IN auto-assigns/mutates `number`. This is the field to match a synced task.",
  ),
  description: z.string().nullable(),
  clientId: z.string().nullable(),
  projectId: z.string().nullable(),
  statusId: z.string().nullable().describe("Hashed task_status id"),
  rate: z.number().nullable(),
  timeLog: z.array(z.tuple([z.number(), z.number()])).describe(
    "[[start,stop],…] epoch-second pairs (stop 0 ⇒ open)",
  ),
  isRunning: z.boolean().describe("Derived: any time_log pair open"),
  isDeleted: z.boolean().nullable(),
  archivedAt: z.number().nullable().describe("Unix ts; 0/absent → null"),
});

/** Normalize a raw `/tasks` row (§3). */
export function normalizeTask(
  raw: Record<string, unknown>,
): z.infer<typeof TaskSchema> {
  const archivedAt = numOrNull(raw.archived_at);
  return {
    id: strOrNull(raw.id) ?? "",
    number: strOrNull(raw.number),
    customValue1: strOrNull(raw.custom_value1),
    description: strOrNull(raw.description),
    clientId: strOrNull(raw.client_id),
    projectId: strOrNull(raw.project_id),
    // task_status_id is a hashid (never coerced to int, same as other IN ids).
    statusId: strOrNull(raw.status_id),
    rate: numOrNull(raw.rate),
    timeLog: parseTimeLog(raw.time_log),
    isRunning: isRunning(raw.time_log),
    isDeleted: boolOrNull(raw.is_deleted),
    archivedAt: archivedAt && archivedAt > 0 ? archivedAt : null,
  };
}

// ---------------------------------------------------------------------------
// Clients surface (design/invoiceninja-entity-crud.md §1). Read is a by-id batch
// fan-out (no blanket listClients) into a short-lived, single-version, field-
// sensitive `clients` snapshot; write is a gated check-then-create dedup'd on the
// client `number`. Both reuse the frozen inFetch/inFetchAll seams. PII lives only
// in the read snapshot; the write-audit rows carry `number` (a company-assigned
// identifier, not PII) + ids, never names/emails.
// ---------------------------------------------------------------------------

/**
 * Whether a caller-supplied id matches the IN hashid charset (`/^[A-Za-z0-9]+$/`,
 * the same boundary getInvoice enforces at its schema). PURE, exported. getClients
 * gates EVERY id through this before interpolating it into `GET /clients/{id}` —
 * a full-account token makes a malformed id (e.g. "../../users/5") a host-endpoint
 * escape, so a failing id is skipped + surfaced in an errors row, never a path.
 * An empty string fails (the `+` requires ≥1 char).
 */
export function isValidHashid(id: string): boolean {
  return /^[A-Za-z0-9]+$/.test(id);
}

const TaskListSchema = snapshotSchema(TaskSchema);

/** A normalized client contact (§1). Person-name + email are PII → sensitive. */
const ClientContactSchema = z.object({
  id: z.string().nullable(),
  firstName: z.string().nullable().meta({ sensitive: true }),
  lastName: z.string().nullable().meta({ sensitive: true }),
  email: z.string().nullable().meta({ sensitive: true }),
});

/**
 * A normalized client row (§1). PII fields (`name`, contact person-name + email)
 * are `.meta({ sensitive: true })` so the datastore vaults them; `id`/`number`/
 * `balance`/`paidToDate` stay readable (the snapshot is useless otherwise).
 */
const ClientSchema = z.object({
  id: z.string().describe("Hashed IN id — never coerced to int"),
  number: z.string().nullable(),
  name: z.string().nullable().meta({ sensitive: true }),
  balance: z.number().nullable(),
  paidToDate: z.number().nullable(),
  contacts: z.array(ClientContactSchema),
  isDeleted: z.boolean().nullable(),
  archivedAt: z.number().nullable().describe("Unix ts; 0/absent → null"),
});

/** Normalize one raw `/clients/{id}?include=contacts` contact row. */
export function normalizeClientContact(
  raw: Record<string, unknown>,
): z.infer<typeof ClientContactSchema> {
  return {
    id: strOrNull(raw.id),
    firstName: strOrNull(raw.first_name),
    lastName: strOrNull(raw.last_name),
    email: strOrNull(raw.email),
  };
}

/**
 * Normalize a raw `/clients/{id}` row (with `include=contacts`) to the §1 shape.
 * PURE, exported. `contacts` is flattened from the raw `contacts[]` (each row
 * normalized); a missing/non-array `contacts` yields `[]`. Balances are read
 * through, never written back by the write path (IN derives them).
 */
export function normalizeClient(
  raw: Record<string, unknown>,
): z.infer<typeof ClientSchema> {
  const archivedAt = numOrNull(raw.archived_at);
  const rawContacts = Array.isArray(raw.contacts)
    ? raw.contacts as Array<Record<string, unknown>>
    : [];
  return {
    id: strOrNull(raw.id) ?? "",
    number: strOrNull(raw.number),
    name: strOrNull(raw.name),
    balance: numOrNull(raw.balance),
    paidToDate: numOrNull(raw.paid_to_date),
    contacts: rawContacts.map((c) => normalizeClientContact(c)),
    isDeleted: boolOrNull(raw.is_deleted),
    archivedAt: archivedAt && archivedAt > 0 ? archivedAt : null,
  };
}

// The `clients` resource shape (§1). A snapshot envelope over normalized client
// rows PLUS a per-id `errors` array (blank/invalid ids and per-id fetch
// failures) — kept in the SAME single resource the design names (no separate
// clientReadErrors spec), so it is NOT built via the frozen `snapshotSchema`
// (which has no errors field and is shared by every list method).
const ClientListSchema = z.object({
  scope: z.string(),
  count: z.number().int().nonnegative(),
  items: z.array(ClientSchema),
  errors: z.array(z.object({
    id: z.string(),
    error: z.string(),
  })),
  retrievedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Company settings surface (design/specs/invoiceninja-company-settings.spec.md).
// READ (getCompanySettings) snapshots the custom-field LABELS + currency/format
// identifiers; RECONCILE (reconcileCompanySettings) diffs a desired set and, only
// when dryRun=false, round-trips the FULL live settings/custom_fields objects
// (mutating only changed keys) back via PUT so unmanaged siblings survive.
// Field names below are FROZEN to the live GET /companies/{id} shape (custom
// fields keyed task1..4/invoice1..4/client1..4/product1..4, each a `Label` or
// `Label|type` string; currency_id/date_format_id on `settings`). number_format
// is deliberately NOT surfaced: the live probe (your-instance.example, IN v5,
// 2026-09-21) confirmed settings.number_format does not exist on this build -
// number formatting is a composite of the currency record's separators +
// settings.show_currency_code + a top-level use_comma_as_decimal_place flag, all
// out of this surface's scope.
// ---------------------------------------------------------------------------

/**
 * The four custom-field families managed here (each has slots 1..4). The other
 * IN families (company/expense/payment/user) are deliberately OUT of scope.
 */
export const CUSTOM_FIELD_FAMILIES = [
  "task",
  "invoice",
  "client",
  "product",
] as const;

type CustomFieldFamily = typeof CUSTOM_FIELD_FAMILIES[number];

/**
 * Split IN's custom-field encoding into `{ label, type }`. IN stores each slot
 * as either a plain `"Label"` (single-line text) or `"Label|type"` where type is
 * `single_line_text | multi_line_text | switch | date` or a comma-separated
 * dropdown option list. Splits on the FIRST `|` only (a dropdown option list
 * uses commas, never pipes, so the type segment is preserved verbatim). A
 * blank/absent value yields `{ label: null, type: null }`. PURE, exported.
 */
export function splitCustomField(
  raw: unknown,
): { label: string | null; type: string | null } {
  const s = strOrNull(raw);
  if (s === null) return { label: null, type: null };
  const pipe = s.indexOf("|");
  if (pipe < 0) return { label: strOrNull(s), type: null };
  return {
    label: strOrNull(s.slice(0, pipe)),
    type: strOrNull(s.slice(pipe + 1)),
  };
}

/**
 * Re-encode a `{ label, type }` slot into IN's `"Label"` / `"Label|type"` wire
 * form. The type is PRESERVED from the live slot on a relabel (a reconcile only
 * changes the label, never the field type) so the round-trip write never drops
 * the slot's type. PURE, exported.
 */
export function encodeCustomField(
  label: string,
  type: string | null,
): string {
  return type ? `${label}|${type}` : label;
}

/** One normalized custom-field slot: its label + parsed type (null when plain). */
const CustomFieldSlotSchema = z.object({
  label: z.string().nullable(),
  type: z.string().nullable(),
});

/**
 * The normalized company-settings envelope. `customFields` carries the four
 * managed families, each an array of the FOUR slots (index 0 = slot 1).
 * `retrievedAt` is stamped by the method, not the pure normalizer. The full
 * `raw` response is deliberately NOT persisted here (CS-REV-4): reconcile keeps
 * the raw GET body in-memory for its round-trip PUT, but the snapshot resource
 * carries only the normalized fields (the raw company object is heavy and holds
 * unmanaged/low-value config we do not want durably mirrored per-run).
 */
const CompanySettingsSchema = z.object({
  companyId: z.string().describe("Hashed IN company id - never coerced to int"),
  customFields: z.object({
    task: z.array(CustomFieldSlotSchema),
    invoice: z.array(CustomFieldSlotSchema),
    client: z.array(CustomFieldSlotSchema),
    product: z.array(CustomFieldSlotSchema),
  }),
  currencyId: z.string().nullable().describe(
    "settings.currency_id (LIVE-CONFIRMED present, e.g. '1' = USD)",
  ),
  dateFormatId: z.string().nullable().describe(
    "settings.date_format_id (LIVE-CONFIRMED present, e.g. '1')",
  ),
  retrievedAt: z.string(),
});

/**
 * Normalize a raw `GET /companies/{id}` row (`json.data`) to the company-
 * settings envelope. Lifts the four managed custom-field families (each slot
 * split into `{ label, type }` via {@link splitCustomField}) and the
 * currency/date-format identifiers off `settings`. PURE, exported (mirrors
 * normalizeClient/normalizeProject). Does NOT return `raw` (CS-REV-4 - callers
 * that need the round-trip body hold the raw GET response themselves).
 * `retrievedAt` is NOT set here - the method stamps it, like SingleSchema reads.
 */
export function normalizeCompanySettings(
  raw: Record<string, unknown>,
): Omit<z.infer<typeof CompanySettingsSchema>, "retrievedAt"> {
  const cf = (raw.custom_fields ?? {}) as Record<string, unknown>;
  const settings = (raw.settings ?? {}) as Record<string, unknown>;
  const family = (
    fam: CustomFieldFamily,
  ): Array<{ label: string | null; type: string | null }> =>
    [1, 2, 3, 4].map((i) => splitCustomField(cf[`${fam}${i}`]));
  return {
    companyId: strOrNull(raw.id) ?? "",
    customFields: {
      task: family("task"),
      invoice: family("invoice"),
      client: family("client"),
      product: family("product"),
    },
    currencyId: strOrNull(settings.currency_id),
    dateFormatId: strOrNull(settings.date_format_id),
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
const ProjectListSchema = snapshotSchema(ProjectSchema);

// Lean client discovery row (§1) — id/number/name ONLY (no contacts/email/
// phone/address/id_number). The low-PII discovery surface that closes the
// by-id chicken-and-egg gap: you list to learn ids, then fetch full PII for
// specific ones via getClients(ids). `name` stays sensitive (a company/person
// name), but the heavy contact PII is never materialized by this path.
const ClientLeanSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  name: z.string().nullable().meta({ sensitive: true }),
});
const ClientLeanListSchema = snapshotSchema(ClientLeanSchema);

/**
 * PURE: normalize a raw IN client to the lean {id,number,name} discovery row,
 * discarding all heavy PII (email/phone/address/id_number, contacts). Mirrors
 * normalizeClient but keeps only what a name/number→id resolution needs.
 */
export function normalizeClientLean(
  raw: Record<string, unknown>,
): z.infer<typeof ClientLeanSchema> {
  return {
    id: strOrNull(raw.id) ?? "",
    number: strOrNull(raw.number),
    name: strOrNull(raw.name),
  };
}

// --- Client email DOMAINS (§7 lead-spam allowlist source) -------------------
// The known-customer hard-pass (design/lead-spam-filter.md §7) needs the SET of
// customer email DOMAINS, never a local part or full address. These helpers
// extract the domain and nothing else; the full email is transient and is never
// stored or logged. PURE + exported for direct unit testing.

/**
 * The lowercased DOMAIN of an email (text after the last `@`), or null when the
 * value is absent or not a plausible domain. NEVER returns the local part.
 * Rejects addresses with no local part, no domain, whitespace, or a domain that
 * is not a dotted label sequence (so a malformed value never enters the
 * allowlist). "A@Acme.COM" -> "acme.com"; "bare", "@x", "a@", "a b@x.io" -> null.
 */
export function emailDomainOf(email: string | null | undefined): string | null {
  const s = (email ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return null; // need both a local part + a domain
  if (/\s/.test(s)) return null;
  const domain = s.slice(at + 1);
  // Dotted label sequence only (at least one dot, non-empty labels).
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return domain;
}

/**
 * The DEDUPED, sorted set of contact email DOMAINS across normalized clients.
 * Free-mail/blocklisted domains are NOT filtered here — the consumer (the
 * lead-spam classifier) owns that policy; this reader stays single-purpose.
 * Only domains leave this function — never a local part or a full address.
 * PURE + exported.
 */
export function collectClientDomains(
  clients: ReadonlyArray<{ contacts: ReadonlyArray<{ email: string | null }> }>,
): string[] {
  const set = new Set<string>();
  for (const c of clients) {
    for (const contact of c.contacts ?? []) {
      const d = emailDomainOf(contact.email);
      if (d) set.add(d);
    }
  }
  return [...set].sort();
}

// The `clientDomains` resource (§7): domains ONLY, so — unlike `clients` and
// `clientList` — NO field is sensitive (a bare domain carries no person
// identity). Still short-lived + single-version for freshness.
const ClientDomainsSchema = z.object({
  scope: z.string(),
  count: z.number().int().nonnegative(),
  domains: z.array(z.string()).describe(
    "Deduped, sorted client contact email DOMAINS (text after @, lowercased). " +
      "Never a local part or full address.",
  ),
  retrievedAt: z.string(),
});

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
    // ADDITIVE (§7.6 dry-run mapping projection) — preview-only metadata on
    // the sync row, NEVER part of the IN expense POST body. Set to the
    // matched vendor/category NAME when the row's vendor_id/category_id
    // resolved to DRYRUN_SENTINEL; null otherwise (including every real
    // match, since a real bind never needs projecting). Defaulted so an
    // older expenseSync snapshot (pre-§7.6) still parses (back-compat).
    projectedVendor: z.string().nullable().default(null),
    projectedCategory: z.string().nullable().default(null),
    // ADDITIVE (finops-daily-review) — the source txn's counterparty + source
    // ("mercury"/"ynab"), carried on the row so the model-scope `finops-review`
    // report renders a human-readable, per-source line WITHOUT re-joining the
    // BankTxn snapshot (F1 of design/finops-daily-review.md). Projection-only,
    // exactly like projectedVendor above: NEVER part of the IN expense POST
    // body. Defaulted so a pre-finops expenseSync snapshot still parses.
    counterparty: z.string().nullable().default(null),
    source: z.string().nullable().default(null),
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

// ADDITIVE (invoice-write path, design/invoiceninja-invoice-write.md) — one row
// per invoice processed by upsertInvoice. Idempotent on the invoice `number`.
// Kept SEPARATE from the frozen expense resources; the action enum is the same
// frozen ['skip','would-create','created'] (reason carries the fine-grained
// skip cause for reconcile). `total` is the computed line-item total (cost×qty).
const InvoiceSyncSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    action: z.enum(["skip", "would-create", "created"]),
    // Fine-grained skip cause (already-exists, exists-amount-mismatch,
    // in-batch-duplicate, invalid, blank-dedup-key) or null on create/would-
    // create. Additive audit field; not part of any POST body.
    reason: z.string().nullable().default(null),
    invoiceId: z.string().nullable(),
    clientId: z.string().nullable(),
    total: z.number().nullable(),
    status: z.string(),
    date: z.string().nullable(),
  })),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

// ADDITIVE (invoice-write path) — durable audit of failed/rejected invoice
// writes: one row per invoice whose POST threw OR whose input was blank/invalid.
// Flushed ALWAYS (even empty) so a consumer distinguishes "0 errors this run"
// from "never ran". Kept SEPARATE from the frozen expense error resource.
const InvoiceSyncErrorsSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    clientId: z.string().nullable(),
    error: z.string(),
    attemptedAt: z.string(),
    dryRun: z.boolean(),
  })),
  retrievedAt: z.string(),
});

// ADDITIVE (payment-apply path, design/specs/invoiceninja-payment-apply.spec.md)
// — one row per payment processed by applyPayment, idempotent on
// `transaction_reference`. Mirrors InvoiceSyncSchema; PII-light (clientId +
// resolved invoice ids only, never a counterparty name). `amount` is the summed
// application total (nullable when the input amounts are unusable).
const PaymentSyncSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    action: z.enum(["skip", "would-create", "created"]),
    // Fine-grained skip cause (already-exists, already-paid, over-apply,
    // invoice-unresolved, in-batch-duplicate, invalid, blank-dedup-key) or null
    // on create/would-create. Additive audit field; not part of any POST body.
    reason: z.string().nullable().default(null),
    paymentId: z.string().nullable(),
    clientId: z.string().nullable(),
    amount: z.number().nullable(),
    date: z.string().nullable(),
    appliedInvoiceIds: z.array(z.string()),
  })),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

// ADDITIVE (payment-apply path) — durable audit of failed/rejected payment
// applications: one row per payment whose POST threw OR whose input was
// blank/invalid/unresolved/over-apply. Flushed ALWAYS (even empty) so a consumer
// distinguishes "0 errors this run" from "never ran". Kept SEPARATE from the
// frozen expense/invoice error resources.
const PaymentSyncErrorsSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    amount: z.number().nullable(),
    error: z.string(),
    attemptedAt: z.string(),
    dryRun: z.boolean(),
  })),
  retrievedAt: z.string(),
});

// ADDITIVE (mark-sent path, design/specs/invoiceninja-mark-sent.spec.md) — one
// row per invoice processed by markSent: a Draft (status_id 1) transitioned to
// Sent (status_id 2) via IN's bulk `mark_sent` action so it gains a balance and
// applyPayments can then recognize it Paid. `action` is `skip` (unresolved /
// already-sent / already-paid / not-draft), `would-send` (dryRun preview of an
// eligible Draft), or `sent` (a read-back-confirmed status_id 2). Mirrors
// InvoiceSyncSchema's single-writer + finally-flush discipline; carries NO
// counterparty PII (invoice id + status only).
const MarkSentSyncSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    action: z.enum(["skip", "would-send", "sent"]),
    // Fine-grained skip cause (unresolved, already-sent, already-paid,
    // not-draft, send-unconfirmed) or null on would-send/sent. Additive audit
    // field; never part of the POST body.
    reason: z.string().nullable().default(null),
    invoiceId: z.string().nullable(),
    statusId: z.number().nullable(),
  })),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

// ADDITIVE (mark-sent path) — durable audit of failed/rejected mark-sent
// transitions: one row per unresolved target, per invoice whose bulk POST threw,
// or per invoice whose post-write read-back did not confirm status_id 2. Flushed
// ALWAYS (even empty) so a consumer distinguishes "0 errors this run" from
// "never ran". Kept SEPARATE from the frozen invoice/payment error resources.
const MarkSentSyncErrorsSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    error: z.string(),
    attemptedAt: z.string(),
    dryRun: z.boolean(),
  })),
  retrievedAt: z.string(),
});

// ADDITIVE (invoice-from-tasks path, design/specs/invoiceninja-invoice-tasks.spec.md)
// — one row per invoice processed by invoiceTasks: a draft invoice built from a
// set of IN tasks the way IN's UI does (one task-linked service line per task,
// precise hours x rate, time-details notes, `task_id`). `action` is the frozen
// ['skip','would-create','created'] (reason carries the fine-grained skip cause);
// `total` is the computed line-item total (Σ cost×quantity). `taskRows` records
// the per-task classification (a `line` contributed, or a `skip` with reason +
// computed hours) so a reconcile can see exactly which buckets were billed vs
// held. Mirrors InvoiceSyncSchema's single-writer + finally-flush discipline;
// carries NO counterparty PII (client id + task ids + numbers only).
const InvoiceTasksSyncSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    number: z.string(),
    action: z.enum(["skip", "would-create", "created"]),
    // Fine-grained cause (blank-dedup-key, invalid, already-exists,
    // task-fetch-failed, no-eligible-tasks, post-failed) or null on
    // would-create/created.
    reason: z.string().nullable().default(null),
    invoiceId: z.string().nullable(),
    clientId: z.string().nullable(),
    total: z.number().nullable(),
    status: z.string(),
    date: z.string().nullable(),
    taskRows: z.array(z.object({
      taskId: z.string(),
      action: z.enum(["line", "skip"]),
      // Per-task skip cause (wrong-client, not-found, already-invoiced,
      // task-running, zero-cost, zero-hours, duplicate-task-id, task-fetch-
      // failed) or null when the task contributed a line.
      reason: z.string().nullable().default(null),
      // Computed 3-dp hours for a contributed line (null on a skip).
      hours: z.number().nullable().default(null),
    })),
  })),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

// ADDITIVE (invoice-from-tasks path) — durable audit of failed/rejected
// invoice-from-tasks writes: one row per invoice whose input was blank/invalid
// or whose POST threw, per rejected task (wrong-client/not-found/task-running),
// or per eligible task whose post-write read-back did not confirm its
// `invoice_id` flipped to the new invoice (a linkage gap). Flushed ALWAYS (even
// empty) so a consumer distinguishes "0 errors this run" from "never ran". Kept
// SEPARATE from the frozen invoice/payment/mark-sent error resources. `number`
// carries the invoice dedup key, `taskId` the offending task (one is populated).
const InvoiceTasksSyncErrorsSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    number: z.string().nullable().default(null),
    taskId: z.string().nullable().default(null),
    error: z.string(),
    attemptedAt: z.string(),
    dryRun: z.boolean(),
  })),
  retrievedAt: z.string(),
});

// ADDITIVE (clients surface, §1) — one row per client processed by upsertClient,
// idempotent on the client `number`. Mirrors InvoiceSyncSchema; the action enum
// is the frozen ['skip','would-create','created'] (reason carries the fine-
// grained skip cause). Deliberately PII-free: only the `number` dedup key + the
// resolved clientId — never the client name/contacts — so this long-lived audit
// resource never becomes a PII sink (the read `clients` snapshot is the sole,
// short-lived PII store).
const ClientSyncSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    action: z.enum(["skip", "would-create", "created"]),
    reason: z.string().nullable().default(null),
    clientId: z.string().nullable(),
  })),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

// ADDITIVE (clients surface) — durable audit of failed/rejected client writes:
// one row per client whose POST threw OR whose input was blank/invalid. Flushed
// ALWAYS (even empty) so a consumer distinguishes "0 errors this run" from
// "never ran". PII-free (dedupKey = `number` only).
const ClientSyncErrorsSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    error: z.string(),
    attemptedAt: z.string(),
    dryRun: z.boolean(),
  })),
  retrievedAt: z.string(),
});

// ADDITIVE (projects surface, design/invoiceninja-entity-crud.md §2) — one row
// per project processed by upsertProject. Idempotent on the project `number`;
// same frozen ['skip','would-create','created'] action enum (reason carries the
// fine-grained skip cause). Kept SEPARATE from the frozen invoice/expense
// resources.
const ProjectSyncSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    action: z.enum(["skip", "would-create", "created"]),
    // Fine-grained skip cause (already-exists, in-batch-duplicate, invalid,
    // blank-dedup-key) or null on create/would-create. Audit-only; not a body field.
    reason: z.string().nullable().default(null),
    projectId: z.string().nullable(),
    clientId: z.string().nullable(),
    name: z.string().nullable(),
  })),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

// ADDITIVE (projects surface) — durable audit of failed/rejected project writes:
// one row per project whose POST threw OR whose input was blank/invalid. Flushed
// ALWAYS (even empty) so a consumer distinguishes "0 errors this run" from
// "never ran". Kept SEPARATE from the frozen invoice/expense error resources.
const ProjectSyncErrorsSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    clientId: z.string().nullable(),
    error: z.string(),
    attemptedAt: z.string(),
    dryRun: z.boolean(),
  })),
  retrievedAt: z.string(),
});

// ADDITIVE (company-settings surface,
// design/specs/invoiceninja-company-settings.spec.md) — the reconcile audit:
// one row per DIFFED field (only fields the caller marked desired). `changed`
// is the pure diff; `action` reflects the actual outcome (in-sync when the live
// value already matched, would-update on a dry run or an apply that could not
// write, updated when a dryRun=false PUT committed). `applied` records whether a
// PUT actually hit the wire. Kept SEPARATE from the frozen write resources.
const CompanySettingsSyncSchema = z.object({
  scope: z.string(),
  companyId: z.string().nullable(),
  rows: z.array(z.object({
    path: z.string().describe(
      "e.g. custom_fields.task1 / settings.currency_id",
    ),
    current: z.string().nullable(),
    desired: z.string().nullable(),
    changed: z.boolean(),
    action: z.enum(["in-sync", "would-update", "updated", "skipped"]),
    reason: z.string().nullable().default(null).describe(
      "Set only on a `skipped` row (e.g. an empty live slot under the strict " +
        "relabel-only scope, CS-REV-6).",
    ),
  })),
  applied: z.boolean().describe("Whether a PUT actually committed to the wire"),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

// ADDITIVE (company-settings surface) — durable audit of a failed reconcile: a
// resolve/GET/PUT that threw. Flushed ALWAYS (even empty) so a consumer
// distinguishes "0 errors this run" from "never ran". Kept SEPARATE from the
// frozen write error resources.
const CompanySettingsSyncErrorsSchema = z.object({
  scope: z.string(),
  companyId: z.string().nullable(),
  rows: z.array(z.object({
    error: z.string(),
    attemptedAt: z.string(),
    dryRun: z.boolean(),
  })),
  retrievedAt: z.string(),
});

// ADDITIVE (task-write path, design/invoiceninja-entity-crud.md §3) — one row
// per task processed by upsertTask (dedup on `custom_value1`; IN auto-manages
// `number`). Mirrors the invoice-write
// audit; the action enum is the frozen ['skip','would-create','created'] and
// `reason` carries the fine-grained skip cause. NO amount/time_log — a task
// create is orthogonal to timing (the timer surface owns time_log).
const TaskSyncSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    action: z.enum(["skip", "would-create", "created"]),
    reason: z.string().nullable().default(null),
    taskId: z.string().nullable(),
    clientId: z.string().nullable(),
    projectId: z.string().nullable(),
  })),
  dryRun: z.boolean(),
  retrievedAt: z.string(),
});

// ADDITIVE (task-write path) — durable audit of failed/rejected task writes: one
// row per task whose POST threw OR whose input was blank/invalid. Flushed ALWAYS
// (even empty) so a consumer distinguishes "0 errors this run" from "never ran".
const TaskSyncErrorsSchema = z.object({
  scope: z.string(),
  rows: z.array(z.object({
    dedupKey: z.string(),
    clientId: z.string().nullable(),
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

// categoryMerge (design/specs/invoiceninja-category-merge.spec.md) — durable audit
// of ONE mergeExpenseCategories run: which expenses were reassigned off a redundant
// source onto a canonical target, which emptied sources were archived, which were
// skipped (still-has-live-expenses / already-archived), any per-PUT failure, and —
// if the bulk-archive POST itself failed — an `archiveError` recording that nothing
// was archived (so `deletions` is never a lie). Flushed in a `finally` so a
// mid-batch failure still leaves a queryable record of what actually hit the wire.
// ADDITIVE — no frozen schema is touched.
const CategoryMergeSchema = z.object({
  scope: z.string(),
  dryRun: z.boolean(),
  reassignments: z.array(z.object({
    expenseId: z.string(),
    fromId: z.string(),
    toId: z.string(),
    amount: z.number().nullable(),
    archived: z.boolean(),
  })),
  deletions: z.array(z.string()),
  skipped: z.array(z.object({
    categoryId: z.string(),
    reason: z.string(),
    remaining: z.number(),
  })),
  errors: z.array(z.object({
    expenseId: z.string(),
    fromId: z.string(),
    toId: z.string(),
    error: z.string(),
    attemptedAt: z.string(),
  })).default([]),
  // Set ONLY when the bulk-archive POST failed: the ids we ATTEMPTED to archive
  // (none actually were — `deletions` stays []), the error, and when. null on a
  // clean run. Keeps `deletions`/`deletedCount` honest under a POST failure.
  archiveError: z.object({
    ids: z.array(z.string()),
    error: z.string(),
    attemptedAt: z.string(),
  }).nullable().default(null),
  retrievedAt: z.string(),
});

// finops-digest (design/finops-digest.md) — a rendered markdown view of the daily
// dry-run. `markdown` is the body (summary or detailed); the meta fields let a
// consumer gate/label without re-parsing. The email HTML is a `files` resource.
const FinopsDigestSchema = z.object({
  format: z.enum(["summary", "detailed"]),
  markdown: z.string(),
  generatedAt: z.string().nullable(),
  dryRun: z.boolean(),
  window: z.object({
    start: z.string().nullable(),
    end: z.string().nullable(),
  }),
  newCount: z.number(),
  syncedCount: z.number(),
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
  // PUT added (task-timer path): the IN task timer is a PUT /tasks/{id} that
  // rewrites `time_log` (there are NO dedicated start/stop endpoints — verified
  // against v5 `Route::resource('tasks', …)`). Widening the verb union keeps ALL
  // traffic on this single frozen seam (no second HTTP path); GET/POST behavior
  // is byte-for-byte unchanged.
  method: "GET" | "POST" | "PUT",
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
  if (method === "POST" || method === "PUT") {
    headers["Content-Type"] = "application/json";
  }

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
    // ADDITIVE (clients surface) — optional per-write overrides (ResourceWrite
    // Overrides). getClients passes `lifetime` so the `clients` PII snapshot
    // honors cfg.clientSnapshotLifetime instead of the spec default. Optional,
    // so every existing 3-arg caller (writeSnapshot, the *Sync flushes) is
    // unchanged.
    overrides?: {
      lifetime?: string;
      garbageCollection?: number;
      tags?: Record<string, string>;
    },
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
  // Model identity + low-level data API + file writer — provided by the runtime;
  // used by finopsDigest to enumerate the per-scope expenseSync resources
  // (context.dataRepository, same surface the model-scope report uses) and to emit
  // the email HTML file. Optional so methods that don't read/emit files can stub.
  modelType?: unknown;
  modelId?: string;
  dataRepository?: FinopsRepo;
  createFileWriter?: (
    specName: string,
    instanceName: string,
  ) => { writeText: (text: string) => Promise<{ name: string }> };
}

interface ExecuteResult {
  dataHandles: Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// Gated write path (§4.4/§7) — Phase 2. All exported for unit tests.
// ---------------------------------------------------------------------------

/**
 * Sentinel id bound to a would-create vendor/category NAME by buildMapping's
 * §7.6 dry-run mapping projection — NEVER a real IN hashid, and injected ONLY
 * when `dryRun === true` (the live `buildMapping` path is byte-for-byte
 * unchanged and never binds it). `mapTxnToExpense`/`upsertExpenses` resolve it
 * like any other id so a dry-run preview reports the would-create match
 * instead of a phantom `unmatchedVendor`/`None`-fallback gap; the live-write
 * guard in `upsertExpense` throws if this ever reaches a real POST — a
 * sentinel reaching the live writer is a bug, never a valid bind.
 */
export const DRYRUN_SENTINEL = "__dryrun_pending__";

/**
 * Whether a {@link Mapping} carries ANY {@link DRYRUN_SENTINEL} bind across its
 * `vendors` / `categories` / `vendorCategories` tables (DRP-01). Used by the
 * LIVE (`dryRun=false`) `upsertExpenses` pre-flight to fail atomically on a
 * stale, dry-run-built mapping BEFORE any expense POSTs — a sentinel in a live
 * mapping is always cross-run contamination, never a valid bind. Own-values
 * only (`Object.values`), so a prototype member can't masquerade as a bind.
 */
export function mappingHasSentinel(mapping: Mapping): boolean {
  const tables = [
    mapping.vendors,
    mapping.categories,
    mapping.vendorCategories,
  ];
  for (const table of tables) {
    if (table == null) continue;
    for (const id of Object.values(table)) {
      if (id === DRYRUN_SENTINEL) return true;
    }
  }
  return false;
}

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
 * Like {@link ownLookupNorm}, but returns the MATCHED KEY (not its value), or
 * `undefined` when no entry matches `key` (byte-exact first, else {@link
 * normName}). Used by the §7.6 dry-run projection to recover the canonical
 * bound name (the vendor/category that will actually be created) for the
 * preview-only `projectedVendor`/`projectedCategory` fields, WITHOUT
 * duplicating `ownLookupNorm`'s matching rule.
 */
export function ownLookupKeyNorm(
  table: Record<string, string> | undefined,
  key: string | null,
): string | undefined {
  if (table == null || key === null) return undefined;
  if (Object.hasOwn(table, key)) return key;
  const normKey = normName(key);
  if (normKey === "") return undefined;
  for (const k of Object.keys(table)) {
    if (normName(k) === normKey) return k;
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
  /**
   * The resolved `vendor_id`/`category_id` from `mapTxnToExpense` (§7.6,
   * additive) — populated only on `would-create`/`created` (the only paths
   * that build a body); `undefined` on every `skip` path. Lets the
   * `upsertExpenses` row-shaping code detect a {@link DRYRUN_SENTINEL} bind
   * and set `projectedVendor`/`projectedCategory` WITHOUT recomputing
   * resolution logic or touching the frozen `mapTxnToExpense` body.
   */
  vendorId?: string | null;
  categoryId?: string | null;
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
  // (4) build body. FROZEN — mapTxnToExpense is unchanged (§7.3/§7.6); the
  // resolved ids are read back off the body, never recomputed separately, so
  // the sentinel check below and the §7.6 projection can never drift from
  // what actually gets POSTed.
  const body = mapTxnToExpense(txn, mapping);
  const unmatchedVendor = body.vendor_id === null;
  const vendorId = typeof body.vendor_id === "string" ? body.vendor_id : null;
  const categoryId = typeof body.category_id === "string"
    ? body.category_id
    : null;
  // (5) dry-run projection — no write. A DRYRUN_SENTINEL bind (§7.6) is
  // EXPECTED here; it is only ever a problem on the live path below.
  if (dryRun) {
    seen?.add(key);
    return {
      action: "would-create",
      expenseId: null,
      unmatchedVendor,
      vendorId,
      categoryId,
    };
  }
  // Live-write guard (§7.6, defense-in-depth): a sentinel id must NEVER reach
  // a real POST. This can only fire if a stale/dryRun=true mapping was fed
  // into a dryRun=false run — a bug upstream, never a valid bind.
  if (vendorId === DRYRUN_SENTINEL || categoryId === DRYRUN_SENTINEL) {
    throw new Error(
      `upsertExpense: resolved ${
        vendorId === DRYRUN_SENTINEL ? "vendor_id" : "category_id"
      } is the dry-run sentinel (${DRYRUN_SENTINEL}) for txn "${key}" — a ` +
        "sentinel must never reach a live POST. Re-run buildMapping(dryRun=false) " +
        "after the vendor/category creates complete before writing live.",
    );
  }
  // (6) real create.
  const json = await inFetch(cfg, "POST", "expenses", { body }, doFetch);
  const data = (json.data ?? {}) as Record<string, unknown>;
  seen?.add(key);
  return {
    action: "created",
    expenseId: strOrNull(data.id),
    unmatchedVendor,
    vendorId,
    categoryId,
  };
}

// ---------------------------------------------------------------------------
// Invoice-write path (design/invoiceninja-invoice-write.md). A SECOND gated
// write path (invoices), independent of the expense path and idempotent on the
// invoice `number` (unique + `?filter=`-searchable — cleaner than the expense
// custom_value1 hack). Additive: reuses inFetch/inFetchAll + the single-writer
// discipline; touches none of the frozen read/expense-write bodies. Draft-only:
// NEVER emails/sends an invoice to a client under any argument.
// ---------------------------------------------------------------------------

/** Invoice line `type` → IN `type_id` (1=product, 2=service/task). */
const INVOICE_TYPE_ID: Record<string, number> = { product: 1, service: 2 };

/** The result of a single {@link upsertInvoice}. */
export interface InvoiceUpsertResult {
  action: "skip" | "would-create" | "created";
  reason?: string;
  invoiceId: string | null;
}

/**
 * Read + validate the line items off a raw invoice input into IN POST-body
 * rows. Returns null (→ the caller's VALIDATION GATE rejects the invoice) if
 * the list is absent/empty, an entry is not an object, its `type` is not
 * product|service, or its `cost` is non-finite. `quantity` defaults to 1.
 */
function readInvoiceLineItems(
  raw: unknown,
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const li of raw) {
    if (typeof li !== "object" || li === null) return null;
    const item = li as Record<string, unknown>;
    const type = strOrNull(item.type);
    // Object.hasOwn — a caller-controlled `type` like "__proto__"/"constructor"
    // would otherwise resolve a truthy value off the prototype chain and slip
    // past the unknown-type guard. Matches the Map/hasOwn discipline used for
    // the overlay lookups elsewhere in this file.
    const typeId = type !== null && Object.hasOwn(INVOICE_TYPE_ID, type)
      ? INVOICE_TYPE_ID[type]
      : undefined;
    const cost = numOrNull(item.cost);
    // quantity defaults to 1 only when ABSENT; an explicit non-finite or
    // non-positive quantity is malformed. (A negative `cost` IS allowed —
    // discount/credit lines are legitimate on an invoice.)
    const quantity = item.quantity === undefined ? 1 : numOrNull(item.quantity);
    // Unknown line type, non-finite cost, or non-positive/non-finite quantity →
    // the whole invoice is invalid.
    if (
      typeId === undefined || cost === null || quantity === null ||
      quantity <= 0
    ) {
      return null;
    }
    const productKey = strOrNull(item.productKey);
    out.push({
      type_id: typeId,
      ...(productKey !== null ? { product_key: productKey } : {}),
      notes: strOrNull(item.notes) ?? "",
      quantity,
      cost,
    });
  }
  return out;
}

/**
 * The invoice total IN will derive from the line items (Σ cost×quantity). Used
 * for the exists-amount-mismatch check and the audit row; the method NEVER
 * sends an `amount` — IN computes it. Null when the line items are invalid.
 */
function computeInvoiceTotal(inv: Record<string, unknown>): number | null {
  const items = readInvoiceLineItems(inv.lineItems);
  if (items === null) return null;
  const total = items.reduce(
    (sum, li) => sum + (li.cost as number) * (li.quantity as number),
    0,
  );
  // finite × finite can still overflow to ±Infinity — a non-finite total must
  // never be persisted to the audit or compared, so treat it as invalid.
  return Number.isFinite(total) ? total : null;
}

/**
 * Build the POST `/invoices` body from a raw invoice input (PURE, unit-tested).
 * `status:'sent'` → `status_id` 2, otherwise Draft (1). NEVER sets `send_email`
 * or any email-trigger field, and NEVER sets `amount`/`balance` (IN derives the
 * total from `line_items`). Optional string fields are omitted when blank.
 *
 * @param inv A raw invoice input (design/invoiceninja-invoice-write.md).
 * @returns The IN v5 `/invoices` create body.
 */
export function mapInvoiceToBody(
  inv: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    client_id: strOrNull(inv.clientId),
    number: strOrNull(inv.number), // DEDUP KEY (caller-assigned, stable)
    status_id: strOrNull(inv.status) === "sent" ? 2 : 1, // draft default
    line_items: readInvoiceLineItems(inv.lineItems) ?? [],
  };
  const optional: Array<[string, string]> = [
    ["date", "date"],
    ["dueDate", "due_date"],
    ["poNumber", "po_number"],
    ["publicNotes", "public_notes"],
    ["privateNotes", "private_notes"],
    ["currencyId", "currency_id"],
  ];
  for (const [inKey, outKey] of optional) {
    const v = strOrNull(inv[inKey]);
    if (v !== null) body[outKey] = v;
  }
  return body;
}

/**
 * Check-then-create ONE invoice, idempotent on `number`. Never mutates. Order:
 *   0. blank-key guard — never call `?filter=` with `""`. `blank-dedup-key`.
 *   1. VALIDATION GATE — `clientId` must match the IN hashid charset
 *      (`/^[A-Za-z0-9]+$/`, the same path-safety boundary as getInvoice, applied
 *      here because a full-account token makes a malformed id dangerous) AND at
 *      least one valid line item (finite cost, known type). `invalid`.
 *   2. in-run dedup via `seen` — IN's `?filter=` is NOT read-your-writes, so an
 *      invoice created earlier in THIS batch may not be searchable yet.
 *   3. PAGINATED dedup: scan every page of `?filter=number` (TRASH-INCLUSIVE, so
 *      a soft-deleted invoice with this number still counts — else deleting one
 *      in the UI would cause a duplicate create) for a row whose `number`
 *      EXACTLY equals the key (the filter is a substring/multi-column search).
 *      On a match, compare the existing total to the computed line-item total
 *      and flag `exists-amount-mismatch` for reconcile.
 *   4/5/6. build body; in dryRun return `would-create` (NO POST); else POST.
 * `seen` is populated on BOTH would-create and created so a repeated number is
 * caught in dry-run and real runs alike.
 *
 * @param cfg Resolved config.
 * @param inv A raw invoice input.
 * @param dryRun When true, never POSTs.
 * @param doFetch Fetch implementation (injected in tests).
 * @param seen In-run set of numbers already would-created/created this batch.
 * @param logger Optional logger.
 */
export async function upsertInvoice(
  cfg: GlobalArgs,
  inv: Record<string, unknown>,
  dryRun: boolean,
  doFetch?: FetchLike,
  seen?: Set<string>,
  logger?: MethodLogger,
): Promise<InvoiceUpsertResult> {
  const number = strOrNull(inv.number);
  // (0) blank-key guard — must precede any `?filter=` call (a blank number would
  // exact-match every other blank-number row). A whitespace-only number is
  // treated as blank too (it would otherwise filter on "%20…" and create a
  // junk-numbered invoice).
  if (number === null || number.trim() === "") {
    return { action: "skip", reason: "blank-dedup-key", invoiceId: null };
  }
  // (1) validation gate — client id must match the IN hashid charset
  // (`/^[A-Za-z0-9]+$/`; a data-format sanity check on the caller-supplied id,
  // not a path boundary — `clientId` is a POST-body field here, never a URL
  // path segment) AND at least one valid line item whose totals are finite.
  const clientId = strOrNull(inv.clientId);
  const lineItems = readInvoiceLineItems(inv.lineItems);
  const total = lineItems === null ? null : computeInvoiceTotal(inv);
  if (
    clientId === null || !/^[A-Za-z0-9]+$/.test(clientId) ||
    lineItems === null || total === null
  ) {
    return { action: "skip", reason: "invalid", invoiceId: null };
  }
  // (2) in-run dedup.
  if (seen?.has(number)) {
    return { action: "skip", reason: "in-batch-duplicate", invoiceId: null };
  }
  // (3) paginated exact-match dedup, TRASH-INCLUSIVE.
  const existing = await inFetchAll(
    cfg,
    "invoices",
    [["filter", number], ["with_trashed", "true"]],
    doFetch,
    logger,
  );
  const match = existing.find((row) => strOrNull(row.number) === number);
  if (match) {
    const matchTotal = numOrNull(match.amount);
    const computed = computeInvoiceTotal(inv);
    const mismatch = matchTotal !== null && computed !== null &&
      Math.abs(matchTotal - computed) > 0.01;
    return {
      action: "skip",
      reason: mismatch ? "exists-amount-mismatch" : "already-exists",
      invoiceId: strOrNull(match.id),
    };
  }
  // (4) build body.
  const body = mapInvoiceToBody(inv);
  // (5) dry-run — no write.
  if (dryRun) {
    seen?.add(number);
    return { action: "would-create", invoiceId: null };
  }
  // (6) real create.
  const json = await inFetch(cfg, "POST", "invoices", { body }, doFetch);
  const data = (json.data ?? {}) as Record<string, unknown>;
  seen?.add(number);
  return { action: "created", invoiceId: strOrNull(data.id) };
}

// ---------------------------------------------------------------------------
// Client-write path (design/invoiceninja-entity-crud.md §1). A THIRD gated write
// path (clients), independent of the expense/invoice paths and idempotent on the
// client `number` (unique per company + `?filter=`-searchable — same clean key
// as invoices, resolving the design's open question: `number` is the primary
// dedup key, NOT custom_value1). Additive: reuses inFetch/inFetchAll + the
// single-writer discipline; touches none of the frozen bodies. NEVER sets
// balance/paid_to_date — IN derives them.
// ---------------------------------------------------------------------------

/**
 * Read + normalize the optional contacts off a raw client input into IN POST-body
 * rows (snake_case, blank fields dropped). Returns null when no createable
 * contact is present (absent list, non-array, or every entry blank) so the
 * caller simply omits `contacts` and lets IN create its default contact. PURE.
 */
function readClientContacts(
  raw: unknown,
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const c of raw) {
    if (typeof c !== "object" || c === null) continue;
    const contact = c as Record<string, unknown>;
    const firstName = strOrNull(contact.firstName);
    const lastName = strOrNull(contact.lastName);
    const email = strOrNull(contact.email);
    if (firstName === null && lastName === null && email === null) continue;
    out.push({
      ...(firstName !== null ? { first_name: firstName } : {}),
      ...(lastName !== null ? { last_name: lastName } : {}),
      ...(email !== null ? { email } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Build the POST `/clients` body from a raw client input (PURE, unit-tested).
 * `number` is the dedup key (caller-assigned, stable). Optional string fields
 * (`name`, `id_number`, `public_notes`, `private_notes`) are omitted when blank;
 * `contacts` is omitted when none are createable. NEVER sets `balance` or
 * `paid_to_date` — Invoice Ninja derives those from the client's invoices.
 *
 * @param client A raw client input (§1 ClientInput).
 * @returns The IN v5 `/clients` create body.
 */
export function mapClientToBody(
  client: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    number: strOrNull(client.number), // DEDUP KEY (caller-assigned, stable)
  };
  const optional: Array<[string, string]> = [
    ["name", "name"],
    ["idNumber", "id_number"],
    ["publicNotes", "public_notes"],
    ["privateNotes", "private_notes"],
  ];
  for (const [inKey, outKey] of optional) {
    const v = strOrNull(client[inKey]);
    if (v !== null) body[outKey] = v;
  }
  const contacts = readClientContacts(client.contacts);
  if (contacts !== null) body.contacts = contacts;
  return body;
}

/** The result of a single {@link upsertClient}. */
export interface ClientUpsertResult {
  action: "skip" | "would-create" | "created";
  reason?: string;
  clientId: string | null;
}

/**
 * Check-then-create ONE client, idempotent on `number`. Never mutates. Order
 * mirrors upsertInvoice:
 *   0. blank-key guard — never call `?filter=` with `""` (a blank/whitespace
 *      number would exact-match every other blank-number row). `blank-dedup-key`.
 *   1. VALIDATION GATE — `name` must be a non-blank string (a nameless client is
 *      not useful and IN would store an empty name). `invalid`.
 *   2. in-run dedup via `seen` — IN's `?filter=` is NOT read-your-writes, so a
 *      client created earlier in THIS batch may not be searchable yet.
 *   3. PAGINATED dedup: scan every page of `?filter=number` (TRASH-INCLUSIVE, so
 *      a soft-deleted client with this number still counts — else deleting one in
 *      the UI would cause a duplicate create) for a row whose `number` EXACTLY
 *      equals the key (the filter is a substring/multi-column search). Clients
 *      carry no caller-set amount, so a match is always `already-exists` (no
 *      amount-mismatch tier — balances are IN-derived).
 *   4/5/6. build body; in dryRun return `would-create` (NO POST); else POST.
 * `seen` is populated on BOTH would-create and created so a repeated number is
 * caught in dry-run and real runs alike.
 *
 * @param cfg Resolved config.
 * @param client A raw client input (§1 ClientInput).
 * @param dryRun When true, never POSTs.
 * @param doFetch Fetch implementation (injected in tests).
 * @param seen In-run set of numbers already would-created/created this batch.
 * @param logger Optional logger.
 */
export async function upsertClient(
  cfg: GlobalArgs,
  client: Record<string, unknown>,
  dryRun: boolean,
  doFetch?: FetchLike,
  seen?: Set<string>,
  logger?: MethodLogger,
): Promise<ClientUpsertResult> {
  const number = strOrNull(client.number);
  // (0) blank-key guard — must precede any `?filter=` call (whitespace-only is
  // treated as blank too).
  if (number === null || number.trim() === "") {
    return { action: "skip", reason: "blank-dedup-key", clientId: null };
  }
  // (1) validation gate — a client needs a name.
  const name = strOrNull(client.name);
  if (name === null || name.trim() === "") {
    return { action: "skip", reason: "invalid", clientId: null };
  }
  // (2) in-run dedup.
  if (seen?.has(number)) {
    return { action: "skip", reason: "in-batch-duplicate", clientId: null };
  }
  // (3) paginated exact-match dedup, TRASH-INCLUSIVE.
  const existing = await inFetchAll(
    cfg,
    "clients",
    [["filter", number], ["with_trashed", "true"]],
    doFetch,
    logger,
  );
  const match = existing.find((row) => strOrNull(row.number) === number);
  if (match) {
    return {
      action: "skip",
      reason: "already-exists",
      clientId: strOrNull(match.id),
    };
  }
  // (4) build body.
  const body = mapClientToBody(client);
  // (5) dry-run — no write.
  if (dryRun) {
    seen?.add(number);
    return { action: "would-create", clientId: null };
  }
  // (6) real create.
  const json = await inFetch(cfg, "POST", "clients", { body }, doFetch);
  const data = (json.data ?? {}) as Record<string, unknown>;
  seen?.add(number);
  return { action: "created", clientId: strOrNull(data.id) };
}

// ---------------------------------------------------------------------------
// Projects-write path (design/invoiceninja-entity-crud.md §2). ADDITIVE — mirrors
// upsertInvoice's discipline exactly (blank-key guard → validation gate → in-run
// seen dedup → paginated trash-inclusive exact-match → dryRun would-create → live
// POST). Reuses inFetch/inFetchAll; adds no second HTTP path. Projects carry no
// amount total, so there is no exists-amount-mismatch tier.
// ---------------------------------------------------------------------------

/** The result of a single {@link upsertProject}. */
export interface ProjectUpsertResult {
  action: "skip" | "would-create" | "created";
  reason?: string;
  projectId: string | null;
}

/**
 * Build the POST `/projects` body from a raw project input (PURE, unit-tested).
 * `number` is the caller-assigned dedup key; `client_id` is the owning client.
 * Numeric optionals (`task_rate`, `budgeted_hours`) are omitted unless finite
 * (numOrNull drops NaN/±Infinity/blank); string optionals are omitted when
 * blank. NEVER sets any derived/rollup field (IN computes those).
 *
 * @param proj A raw ProjectInput (design/invoiceninja-entity-crud.md §2).
 * @returns The IN v5 `/projects` create body.
 */
export function mapProjectToBody(
  proj: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: strOrNull(proj.name) ?? "",
    number: strOrNull(proj.number), // DEDUP KEY (caller-assigned, stable)
    client_id: strOrNull(proj.clientId),
  };
  const numeric: Array<[string, string]> = [
    ["taskRate", "task_rate"],
    ["budgetedHours", "budgeted_hours"],
  ];
  for (const [inKey, outKey] of numeric) {
    const v = numOrNull(proj[inKey]);
    if (v !== null) body[outKey] = v;
  }
  const optional: Array<[string, string]> = [
    ["dueDate", "due_date"],
    ["publicNotes", "public_notes"],
    ["privateNotes", "private_notes"],
  ];
  for (const [inKey, outKey] of optional) {
    const v = strOrNull(proj[inKey]);
    if (v !== null) body[outKey] = v;
  }
  return body;
}

/**
 * Check-then-create ONE project, idempotent on `number`. Never mutates. Order:
 *   0. blank-key guard — never call `?filter=` with `""`. `blank-dedup-key`.
 *   1. VALIDATION GATE — `clientId` must match the IN hashid charset
 *      (`/^[A-Za-z0-9]+$/`, the path-safety boundary applied to the caller-
 *      supplied client id BEFORE it is used in the POST body; a full-account
 *      token makes a malformed id dangerous) AND `name` must be present.
 *      `invalid`.
 *   2. in-run dedup via `seen` — IN's `?filter=` is NOT read-your-writes, so a
 *      project created earlier in THIS batch may not be searchable yet.
 *   3. PAGINATED dedup: scan every page of `?filter=number` (TRASH-INCLUSIVE, so
 *      a soft-deleted project with this number still counts — else deleting one
 *      in the UI would cause a duplicate create) for a row whose `number`
 *      EXACTLY equals the key (the filter is a substring/multi-column search).
 *   4/5/6. build body; in dryRun return `would-create` (NO POST); else POST.
 * `seen` is populated on BOTH would-create and created so a repeated number is
 * caught in dry-run and real runs alike.
 *
 * @param cfg Resolved config.
 * @param proj A raw ProjectInput.
 * @param dryRun When true, never POSTs.
 * @param doFetch Fetch implementation (injected in tests).
 * @param seen In-run set of numbers already would-created/created this batch.
 * @param logger Optional logger.
 */
export async function upsertProject(
  cfg: GlobalArgs,
  proj: Record<string, unknown>,
  dryRun: boolean,
  doFetch?: FetchLike,
  seen?: Set<string>,
  logger?: MethodLogger,
  projectCache?: { rows: Array<Record<string, unknown>> | null },
): Promise<ProjectUpsertResult> {
  const number = strOrNull(proj.number);
  // (0) blank-key guard — must precede any `?filter=` call (a blank number would
  // exact-match every other blank-number row). Whitespace-only is blank too.
  if (number === null || number.trim() === "") {
    return { action: "skip", reason: "blank-dedup-key", projectId: null };
  }
  // (1) validation gate — client id must match the IN hashid charset
  // (`/^[A-Za-z0-9]+$/`) BEFORE it is placed in the POST body, and a name must
  // be present. A project references a client, so a malformed/absent client id
  // rejects the whole input.
  const clientId = strOrNull(proj.clientId);
  const name = strOrNull(proj.name);
  // A whitespace-only name is blank (PRJ-COR-1) — mirror the upsertClient gate,
  // don't POST a junk-named project.
  if (
    clientId === null || !/^[A-Za-z0-9]+$/.test(clientId) ||
    name === null || name.trim() === ""
  ) {
    return { action: "skip", reason: "invalid", projectId: null };
  }
  // (2) in-run dedup.
  if (seen?.has(number)) {
    return { action: "skip", reason: "in-batch-duplicate", projectId: null };
  }
  // (3) exact-match dedup, TRASH-INCLUSIVE. NB: unlike clients/invoices, IN's
  // `/projects?filter=` does NOT search the `number` field — a `filter=<number>`
  // query returns ZERO rows even when the project exists, so it can never dedup and
  // EVERY project would be re-created (duplicate). Match `number` client-side against
  // the FULL project list (trash-inclusive) — the same authoritative signal
  // listProjects / snapshot-drift use. A batch caller (upsertProjects) passes a
  // shared `projectCache`: the list is fetched LAZILY on the first project that
  // reaches this step and reused by the rest, so the fan-out does a single GET
  // instead of N full-table scans (PRJ-1) — yet an all-invalid/blank batch (which
  // returns above, before here) still never hits the wire. A direct single call
  // passes no cache and fetches inline. In-batch duplicates are caught earlier by
  // `seen`, so a per-batch snapshot is sufficient (a just-created project's number
  // is already in `seen` before a later dup could reach this list).
  let existing = projectCache?.rows ?? null;
  if (existing === null) {
    existing = await inFetchAll(
      cfg,
      "projects",
      [["with_trashed", "true"]],
      doFetch,
      logger,
    );
    if (projectCache) projectCache.rows = existing;
  }
  const match = existing.find((row) => strOrNull(row.number) === number);
  if (match) {
    return {
      action: "skip",
      reason: "already-exists",
      projectId: strOrNull(match.id),
    };
  }
  // (4) build body.
  const body = mapProjectToBody(proj);
  // (5) dry-run — no write.
  if (dryRun) {
    seen?.add(number);
    return { action: "would-create", projectId: null };
  }
  // (6) real create.
  const json = await inFetch(cfg, "POST", "projects", { body }, doFetch);
  const data = (json.data ?? {}) as Record<string, unknown>;
  seen?.add(number);
  return { action: "created", projectId: strOrNull(data.id) };
}

// ---------------------------------------------------------------------------
// Task-write path (design/invoiceninja-entity-crud.md §3). A THIRD gated write
// path (tasks), independent of the expense/invoice paths and idempotent on the
// task `number` (caller-assigned, unique + `?filter=`-searchable). Additive:
// reuses inFetch/inFetchAll + the single-writer discipline; touches none of the
// frozen bodies. NEVER sets `time_log` — a task create is orthogonal to timing
// (the timer surface owns start/stop over time_log), so create + timing stay
// independent.
// ---------------------------------------------------------------------------

const TASK_ID_CHARSET = /^[A-Za-z0-9]+$/;

/** The result of a single {@link upsertTask}. */
export interface TaskUpsertResult {
  action: "skip" | "would-create" | "created";
  reason?: string;
  taskId: string | null;
}

/**
 * Build the POST `/tasks` body from a raw task input (PURE, unit-tested).
 * `number` is the caller-assigned dedup key. Optional `client_id`/`project_id`
 * are included only when present (and only after the charset gate in
 * {@link upsertTask} has validated them). NEVER sets `time_log` — timing is the
 * timer surface's job, kept orthogonal to create.
 *
 * @param task A raw task input (§3): {number, description, clientId?,
 *   projectId?, rate?}.
 */
export function mapTaskToBody(
  task: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    // IN AUTO-ASSIGNS and MUTATES a task's `number` (verified live: a supplied
    // number is ignored on create and regenerated on later updates), so it is
    // NOT a usable dedup anchor. Store the caller's stable key in custom_value1
    // — writable + `?filter=`-searchable, exactly like upsertExpense — and dedup
    // on THAT. (TSK-COR-3.)
    custom_value1: strOrNull(task.number), // DEDUP KEY (caller-stable)
    description: strOrNull(task.description) ?? "",
  };
  const clientId = strOrNull(task.clientId);
  const projectId = strOrNull(task.projectId);
  const rate = numOrNull(task.rate);
  if (clientId !== null) body.client_id = clientId;
  if (projectId !== null) body.project_id = projectId;
  if (rate !== null) body.rate = rate;
  return body;
}

/**
 * Check-then-create ONE task, idempotent on `custom_value1` (IN auto-manages
 * `number`, so it cannot be the dedup anchor — TSK-COR-3). Never mutates. Order
 * mirrors {@link upsertInvoice}:
 *   0. blank-key guard — never call `?filter=` with `""` (a blank/whitespace-only
 *      number would exact-match every other blank-number row). `blank-dedup-key`.
 *   1. VALIDATION GATE — any supplied `clientId`/`projectId` must match the IN
 *      hashid charset (`/^[A-Za-z0-9]+$/`); a malformed id (a full-account token
 *      makes it dangerous) rejects the task. A non-finite supplied `rate` is
 *      also invalid. `invalid`.
 *   2. in-run dedup via `seen` — IN's `?filter=` is NOT read-your-writes.
 *   3. PAGINATED dedup: scan every page of `?filter=number` (TRASH-INCLUSIVE, so
 *      a soft-deleted task with this number still counts) for a row whose
 *      `number` EXACTLY equals the key. `already-exists`.
 *   4/5/6. build body; in dryRun return `would-create` (NO POST); else POST.
 * `seen` is populated on BOTH would-create and created.
 *
 * @param cfg Resolved config.
 * @param task A raw task input.
 * @param dryRun When true, never POSTs.
 * @param doFetch Fetch implementation (injected in tests).
 * @param seen In-run set of numbers already would-created/created this batch.
 * @param logger Optional logger.
 */
export async function upsertTask(
  cfg: GlobalArgs,
  task: Record<string, unknown>,
  dryRun: boolean,
  doFetch?: FetchLike,
  seen?: Set<string>,
  logger?: MethodLogger,
): Promise<TaskUpsertResult> {
  const number = strOrNull(task.number);
  // (0) blank-key guard — must precede any `?filter=` call.
  if (number === null || number.trim() === "") {
    return { action: "skip", reason: "blank-dedup-key", taskId: null };
  }
  // (1) validation gate — charset-validate any supplied id BEFORE it reaches a
  // POST body (design §3 / cross-cutting invariant), and reject a non-finite
  // rate. Absent ids/rate are allowed (all optional on a task).
  const clientId = strOrNull(task.clientId);
  const projectId = strOrNull(task.projectId);
  const rateProvided = task.rate !== undefined && task.rate !== null &&
    task.rate !== "";
  const rate = numOrNull(task.rate);
  if (
    (clientId !== null && !TASK_ID_CHARSET.test(clientId)) ||
    (projectId !== null && !TASK_ID_CHARSET.test(projectId)) ||
    (rateProvided && rate === null)
  ) {
    return { action: "skip", reason: "invalid", taskId: null };
  }
  // (2) in-run dedup.
  if (seen?.has(number)) {
    return { action: "skip", reason: "in-batch-duplicate", taskId: null };
  }
  // (3) paginated exact-match dedup, TRASH-INCLUSIVE. Match on custom_value1
  // (the caller-stable key) — NOT `number`, which IN auto-manages (TSK-COR-3).
  // `?filter=` searches custom_value1 (same as the expense path); the exact
  // equality below is the safety against the filter's substring/multi-field match.
  const existing = await inFetchAll(
    cfg,
    "tasks",
    [["filter", number], ["with_trashed", "true"]],
    doFetch,
    logger,
  );
  const match = existing.find((row) => strOrNull(row.custom_value1) === number);
  if (match) {
    return {
      action: "skip",
      reason: "already-exists",
      taskId: strOrNull(match.id),
    };
  }
  // (4) build body.
  const body = mapTaskToBody(task);
  // (5) dry-run — no write.
  if (dryRun) {
    seen?.add(number);
    return { action: "would-create", taskId: null };
  }
  // (6) real create.
  const json = await inFetch(cfg, "POST", "tasks", { body }, doFetch);
  const data = (json.data ?? {}) as Record<string, unknown>;
  seen?.add(number);
  return { action: "created", taskId: strOrNull(data.id) };
}

// ---------------------------------------------------------------------------
// Payment-apply path (design/specs/invoiceninja-payment-apply.spec.md). A gated
// write path (payments) that RECOGNIZES a received payment against an existing
// invoice — the ONLY correct way to mark an invoice Paid (writing status_id:4
// directly desyncs paid_to_date/balance and leaves no payment record; IN derives
// Paid once the applied amount covers the balance). Additive: reuses
// inFetch/inFetchAll + the single-writer discipline; touches none of the frozen
// read/write bodies. NEVER sets a top-level `amount` (IN sums invoices[].amount)
// and NEVER sets any email/notify field.
// ---------------------------------------------------------------------------

/** A resolved invoice target: its hashid + current (IN-derived) balance. */
export interface InvoiceIndexEntry {
  id: string;
  balance: number | null;
  // Owning client hashid (client cross-check, PAY-REV-6): a payment may only
  // settle an invoice belonging to its OWN client. null when the invoice row
  // carried no `client_id` (the guard is skipped then — back-compat).
  clientId?: string | null;
  // Running amount already applied to THIS invoice earlier in the current batch
  // (cumulative balance guard, PAY-REV-2). Folded in at each created/would-create
  // so a second application — in the same payment OR a later one — sees the
  // in-memory balance net of what the batch already consumed. Absent === 0.
  applied?: number;
}

/**
 * Number->target map for invoice resolution + the balance guard. A number that
 * maps to more than one LIVE invoice collapses to `"ambiguous"` so it fails
 * closed (never picks an arbitrary invoice). Built ONCE per batch by
 * {@link buildInvoiceIndex} (trash-EXCLUSIVE — a payment settles only a live
 * invoice) and reused across the fan-out (the PRJ-1 single-prefetch idiom).
 */
export type InvoiceIndex = Map<string, InvoiceIndexEntry | "ambiguous">;

/**
 * Prefetch the LIVE invoice list once and index it by `number` → {id, balance}.
 * Trash-EXCLUSIVE: a soft-deleted invoice cannot receive a payment, so it must
 * NOT resolve (unlike the upsert dedup, which is trash-inclusive). A duplicate
 * live number collapses to `"ambiguous"` (fail-closed).
 *
 * @param cfg Resolved config.
 * @param doFetch Fetch implementation (injected in tests).
 * @param logger Optional logger.
 */
export async function buildInvoiceIndex(
  cfg: GlobalArgs,
  doFetch?: FetchLike,
  logger?: MethodLogger,
): Promise<InvoiceIndex> {
  // Trash-EXCLUSIVE and INDEPENDENT of cfg.withTrashed (PAY-REV-5): a payment
  // settles only a LIVE invoice, so a soft-deleted/archived invoice must never be
  // a resolvable target — even if an operator set cfg.withTrashed=true globally
  // (which inFetchAll would otherwise honor). Clone cfg with withTrashed:false so
  // inFetchAll never appends the with_trashed=true pair for THIS prefetch.
  const liveCfg = { ...cfg, withTrashed: false } as GlobalArgs;
  const rows = await inFetchAll(liveCfg, "invoices", [], doFetch, logger);
  const index: InvoiceIndex = new Map();
  for (const row of rows) {
    const number = strOrNull(row.number);
    if (number === null) continue;
    if (index.has(number)) {
      index.set(number, "ambiguous"); // duplicate live number → fail closed
      continue;
    }
    const clientId = strOrNull(row.client_id);
    index.set(number, {
      id: strOrNull(row.id) ?? "",
      balance: numOrNull(row.balance),
      // Owning client for the payment cross-check (PAY-REV-6); omitted when the
      // source row carries no client_id (the guard then can't assert a mismatch).
      ...(clientId !== null ? { clientId } : {}),
    });
  }
  return index;
}

/**
 * Resolve ONE application to its invoice target via the prefetched index. An
 * application carries `invoiceId` OR `invoiceNumber`. An id resolves against the
 * index's values (the id IS the hashid; the scan is only to read its balance); a
 * number resolves by key. Returns null when unresolved / ambiguous / missing a
 * usable balance (fail-closed — the caller then skips `invoice-unresolved`).
 */
function resolveApplication(
  index: InvoiceIndex,
  app: Record<string, unknown>,
): InvoiceIndexEntry | null {
  const id = strOrNull(app.invoiceId);
  const number = strOrNull(app.invoiceNumber);
  let entry: InvoiceIndexEntry | null = null;
  if (id !== null) {
    // The id is already the hashid; scan the index only to read its balance.
    for (const v of index.values()) {
      if (v !== "ambiguous" && v.id === id) {
        entry = v;
        break;
      }
    }
  } else if (number !== null) {
    const hit = index.get(number);
    entry = hit === undefined || hit === "ambiguous" ? null : hit;
  }
  // A target with no readable balance cannot pass the balance guard — fail closed.
  if (entry === null || entry.balance === null) return null;
  return entry;
}

/**
 * Build the POST `/payments` body from a PaymentInput (PURE, unit-tested). Each
 * application's `invoice_id` comes from `resolve(app)` (the caller passes a
 * resolver bound to the prefetched index). NEVER sets a top-level `amount` (IN
 * sums `invoices[].amount`) and NEVER sets any email/notify field. Optional
 * `type_id` / `private_notes` are omitted when absent.
 *
 * @param pay A raw PaymentInput.
 * @param resolve Maps an application to its resolved invoice hashid.
 * @returns The IN v5 `/payments` create body.
 */
export function mapPaymentToBody(
  pay: Record<string, unknown>,
  resolve: (app: Record<string, unknown>) => string,
): Record<string, unknown> {
  const applications = Array.isArray(pay.applications)
    ? pay.applications as Array<Record<string, unknown>>
    : [];
  const body: Record<string, unknown> = {
    client_id: strOrNull(pay.clientId),
    date: strOrNull(pay.date), // YYYY-MM-DD settlement date
    transaction_reference: strOrNull(pay.transactionReference), // DEDUP mirror
    invoices: applications.map((a) => ({
      invoice_id: resolve(a),
      amount: numOrNull(a.amount),
    })),
  };
  const typeId = numOrNull(pay.typeId);
  if (typeId !== null) body.type_id = typeId;
  const privateNotes = strOrNull(pay.privateNotes);
  if (privateNotes !== null) body.private_notes = privateNotes;
  return body;
}

/** The result of a single {@link applyPayment}. */
export interface PaymentApplyResult {
  action: "skip" | "would-create" | "created";
  reason?: string;
  paymentId: string | null;
  appliedInvoiceIds: string[];
}

/**
 * Check-then-create ONE payment, idempotent on `transaction_reference` — the ONLY
 * correct way to mark an invoice Paid (NEVER write status_id:4). Never mutates.
 * Order (design/specs/invoiceninja-payment-apply.spec.md):
 *   0. blank-key guard — blank/whitespace `transactionReference` → skip
 *      `blank-dedup-key`; never call `?filter=` with `""`.
 *   1. VALIDATION GATE — `clientId` matches the IN hashid charset
 *      (`/^[A-Za-z0-9]+$/`; a full-account token makes a malformed id
 *      dangerous), >= 1 application, every application `amount` finite > 0.
 *      `invalid`.
 *   2. invoice resolution — each application resolves (invoiceId OR
 *      invoiceNumber) via `invoiceIndex` (trash-EXCLUSIVE prefetch); an
 *      unresolved / ambiguous target fails the WHOLE payment closed →
 *      `invoice-unresolved` (never a partial money write). A resolved invoice
 *      whose owning client != `pay.clientId` fails closed →
 *      `invoice-client-mismatch` (never settle another client's invoice).
 *   3. in-run dedup via `seen` — IN's `?filter=` is NOT read-your-writes, so a
 *      payment created earlier in THIS batch may not be searchable yet. Checked
 *      BEFORE the balance guard so a same-ref repeat isn't miscounted as an
 *      over-apply against the balance its first occurrence already consumed.
 *   4. balance guard (CUMULATIVE) — an already-Paid target (original balance 0)
 *      → `already-paid`; an application `amount` PLUS everything already applied
 *      to that invoice in this batch, over the balance by > 0.01 → `over-apply`
 *      (never over-pay / create a credit balance).
 *   5. PAGINATED dedup — scan every `?filter=transaction_reference` page for a
 *      row whose `transaction_reference` EXACTLY equals the key (the filter is a
 *      substring/multi-column search); TRASH-INCLUSIVE (with_trashed=true) so a
 *      soft-deleted payment still counts. `already-exists`, paymentId = match.
 *   6. build body; in dryRun return `would-create` (NO POST); else POST. Both
 *      commit paths fold the applications into the shared index's running totals.
 * `seen` is populated on BOTH would-create and created so a repeated ref is
 * caught in dry-run and real runs alike.
 *
 * @param cfg Resolved config.
 * @param pay A raw PaymentInput.
 * @param dryRun When true, never POSTs.
 * @param doFetch Fetch implementation (injected in tests).
 * @param seen In-run set of refs already would-created/created this batch.
 * @param invoiceIndex Prefetched number->target index; built inline when absent.
 * @param logger Optional logger.
 */
export async function applyPayment(
  cfg: GlobalArgs,
  pay: Record<string, unknown>,
  dryRun: boolean,
  doFetch?: FetchLike,
  seen?: Set<string>,
  invoiceIndex?: InvoiceIndex,
  logger?: MethodLogger,
): Promise<PaymentApplyResult> {
  const ref = strOrNull(pay.transactionReference);
  // (0) blank-key guard — must precede any `?filter=` call (a blank ref would
  // exact-match every other blank-ref payment). Whitespace-only is blank too.
  if (ref === null || ref.trim() === "") {
    return {
      action: "skip",
      reason: "blank-dedup-key",
      paymentId: null,
      appliedInvoiceIds: [],
    };
  }
  // (1) validation gate — client id must match the IN hashid charset, at least
  // one application, and every application amount finite > 0.
  const clientId = strOrNull(pay.clientId);
  const applications = Array.isArray(pay.applications)
    ? pay.applications as Array<Record<string, unknown>>
    : [];
  if (
    clientId === null || !/^[A-Za-z0-9]+$/.test(clientId) ||
    applications.length === 0
  ) {
    return {
      action: "skip",
      reason: "invalid",
      paymentId: null,
      appliedInvoiceIds: [],
    };
  }
  for (const a of applications) {
    const amt = numOrNull(a.amount);
    if (amt === null || amt <= 0) {
      return {
        action: "skip",
        reason: "invalid",
        paymentId: null,
        appliedInvoiceIds: [],
      };
    }
  }
  // (2) invoice resolution — resolve each application to a live invoice target
  // via the prefetched index (built inline for a direct single call). An
  // unresolved / ambiguous number OR an unknown id fails the WHOLE payment
  // closed. A resolved invoice whose owning client differs from the payment's
  // client fails closed too (invoice-client-mismatch, PAY-REV-6) so a payment
  // never settles another client's invoice in the same company. `resolved`
  // records the app→hashid binding fed to mapPaymentToBody.
  const index = invoiceIndex ?? await buildInvoiceIndex(cfg, doFetch, logger);
  const targets: InvoiceIndexEntry[] = [];
  const appliedInvoiceIds: string[] = [];
  const resolved = new Map<Record<string, unknown>, string>();
  for (const a of applications) {
    const entry = resolveApplication(index, a);
    if (entry === null) {
      return {
        action: "skip",
        reason: "invoice-unresolved",
        paymentId: null,
        appliedInvoiceIds: [],
      };
    }
    // Client cross-check (PAY-REV-6/PAY-REV-7): fails closed. A present clientId
    // that differs is a mismatch; a null clientId means the source row omitted
    // client_id so the owning client cannot be confirmed equal to the payment's
    // client — the house style is fail-closed on an unverifiable relation, so we
    // skip rather than settle a payment against an invoice we can't attribute.
    if (entry.clientId != null && entry.clientId !== clientId) {
      return {
        action: "skip",
        reason: "invoice-client-mismatch",
        paymentId: null,
        appliedInvoiceIds: [],
      };
    }
    if (entry.clientId == null) {
      return {
        action: "skip",
        reason: "invoice-client-unverified",
        paymentId: null,
        appliedInvoiceIds: [],
      };
    }
    targets.push(entry);
    appliedInvoiceIds.push(entry.id);
    resolved.set(a, entry.id);
  }
  // (3) in-run dedup — checked BEFORE the balance guard so a same-ref repeat (a
  // dedup, NOT a real second application) is caught as in-batch-duplicate and
  // never mistaken for an over-apply against a balance the first occurrence
  // already consumed in the cumulative guard below.
  if (seen?.has(ref)) {
    return {
      action: "skip",
      reason: "in-batch-duplicate",
      paymentId: null,
      appliedInvoiceIds,
    };
  }
  // (4) balance guard — CUMULATIVE within the batch (PAY-REV-2). An already-Paid
  // target (original balance 0) is checked BEFORE the over-apply comparison (a
  // 0-balance invoice would otherwise trip over-apply for any positive amount).
  // Over-apply compares the amount PLUS everything already applied to this same
  // invoice — earlier applications in THIS payment (`runningThisPayment`) and
  // amounts committed to it by earlier payments in the batch (`entry.applied`) —
  // against the balance, so two applications can't sum past it / create a credit.
  const runningThisPayment = new Map<InvoiceIndexEntry, number>();
  for (let i = 0; i < applications.length; i++) {
    const amt = numOrNull(applications[i].amount) as number;
    const entry = targets[i];
    const balance = entry.balance as number;
    if (balance === 0) {
      return {
        action: "skip",
        reason: "already-paid",
        paymentId: null,
        appliedInvoiceIds,
      };
    }
    const prior = (entry.applied ?? 0) + (runningThisPayment.get(entry) ?? 0);
    if (prior + amt > balance + 0.01) {
      return {
        action: "skip",
        reason: "over-apply",
        paymentId: null,
        appliedInvoiceIds,
      };
    }
    runningThisPayment.set(entry, (runningThisPayment.get(entry) ?? 0) + amt);
  }
  // Fold this payment's applications into the shared index entries' running
  // totals — invoked at each commit (created OR would-create) so a later payment
  // (and dry-run previews) see the cumulative amount. NOT called on a dedup skip.
  const commitApplied = () => {
    for (const [entry, sum] of runningThisPayment) {
      entry.applied = (entry.applied ?? 0) + sum;
    }
  };
  // (5) paginated exact-match dedup — the `?filter=` is a substring/multi-column
  // search, so the exact `transaction_reference` equality below is the safety
  // against a false positive. TRASH-INCLUSIVE regardless of cfg.withTrashed
  // (PAY-REV-1): a soft-deleted payment with this reference still means the txn
  // was recognized once, so with_trashed=true forces IN to include it in the
  // match set — otherwise a human deleting an auto-created payment in the IN UI
  // would cause a DUPLICATE create on the next run (soft-delete idempotency hole,
  // same idiom as upsertExpense's dedup).
  const existing = await inFetchAll(
    cfg,
    "payments",
    [["filter", ref], ["with_trashed", "true"]],
    doFetch,
    logger,
  );
  const match = existing.find(
    (row) => strOrNull(row.transaction_reference) === ref,
  );
  if (match) {
    return {
      action: "skip",
      reason: "already-exists",
      paymentId: strOrNull(match.id),
      appliedInvoiceIds,
    };
  }
  // (6) build body.
  const body = mapPaymentToBody(pay, (a) => resolved.get(a) ?? "");
  // dry-run — no write.
  if (dryRun) {
    seen?.add(ref);
    commitApplied(); // preview cumulative balances too (PAY-REV-2)
    return { action: "would-create", paymentId: null, appliedInvoiceIds };
  }
  // real create.
  const json = await inFetch(cfg, "POST", "payments", { body }, doFetch);
  const data = (json.data ?? {}) as Record<string, unknown>;
  seen?.add(ref);
  commitApplied(); // decrement in-memory balances for later payments (PAY-REV-2)
  return {
    action: "created",
    paymentId: strOrNull(data.id),
    appliedInvoiceIds,
  };
}

/** Sum an application list to the payment total (null if any amount is unusable). */
function paymentTotal(pay: Record<string, unknown>): number | null {
  const applications = Array.isArray(pay.applications)
    ? pay.applications as Array<Record<string, unknown>>
    : [];
  let sum = 0;
  for (const a of applications) {
    const amt = numOrNull(a.amount);
    if (amt === null) return null;
    sum += amt;
  }
  return Number.isFinite(sum) ? sum : null;
}

// ---------------------------------------------------------------------------
// Mark-sent path (design/specs/invoiceninja-mark-sent.spec.md). `upsertInvoices`
// only ever creates a Draft (status_id 1, balance 0); IN's REST create ALWAYS
// lands Draft and re-runs SKIP an existing number, so nothing here can move an
// invoice Draft -> Sent. `markSent` closes that gap via IN's bulk `mark_sent`
// action (status-only; it does NOT email the client — that is the separate
// `email_invoice` action), establishing each invoice's balance so applyPayments
// can then recognize it Paid. Additive: reuses inFetch/inFetchAll + the
// single-writer + finally-flush discipline; touches none of the frozen bodies.
// ---------------------------------------------------------------------------

/** One entry in the {@link MarkSentIndex}: an invoice hashid + its current status. */
export interface MarkSentIndexEntry {
  id: string;
  statusId: number | null;
}

/**
 * Number->target map for mark-sent resolution + classification. A number that
 * maps to more than one LIVE invoice collapses to `"ambiguous"` (fail-closed —
 * never mark an arbitrary invoice). Built ONCE per batch by
 * {@link buildMarkSentIndex} (trash-EXCLUSIVE — a soft-deleted invoice is never
 * a mark-sent target) and reused across the fan-out (the PRJ-1 single-prefetch
 * idiom, same seam as {@link buildInvoiceIndex}).
 */
export type MarkSentIndex = Map<string, MarkSentIndexEntry | "ambiguous">;

/**
 * Prefetch the LIVE invoice list once and index it by `number` -> {id, statusId}.
 * Trash-EXCLUSIVE and INDEPENDENT of cfg.withTrashed: a soft-deleted/archived
 * invoice cannot be marked sent, so it must never resolve (even if an operator
 * set cfg.withTrashed=true globally). A duplicate live number collapses to
 * `"ambiguous"` (fail-closed). Reused verbatim for the post-write read-back.
 *
 * @param cfg Resolved config.
 * @param doFetch Fetch implementation (injected in tests).
 * @param logger Optional logger.
 */
export async function buildMarkSentIndex(
  cfg: GlobalArgs,
  doFetch?: FetchLike,
  logger?: MethodLogger,
): Promise<MarkSentIndex> {
  // Clone cfg with withTrashed:false so inFetchAll never appends the
  // with_trashed=true pair for THIS prefetch (same rationale as buildInvoiceIndex).
  const liveCfg = { ...cfg, withTrashed: false } as GlobalArgs;
  const rows = await inFetchAll(liveCfg, "invoices", [], doFetch, logger);
  const index: MarkSentIndex = new Map();
  for (const row of rows) {
    const number = strOrNull(row.number);
    if (number === null) continue;
    if (index.has(number)) {
      index.set(number, "ambiguous"); // duplicate live number -> fail closed
      continue;
    }
    index.set(number, {
      id: strOrNull(row.id) ?? "",
      statusId: numOrNull(row.status_id),
    });
  }
  return index;
}

/**
 * Resolve ONE target ({invoiceId? | invoiceNumber?}) to its invoice via the
 * prefetched index. An id resolves against the index's values (the id IS the
 * hashid; the scan reads its status); a number resolves by key. Returns null
 * when unresolved / ambiguous (fail-closed — the caller then skips
 * `unresolved`), never guessing an arbitrary invoice.
 */
function resolveMarkSentTarget(
  index: MarkSentIndex,
  target: Record<string, unknown>,
): MarkSentIndexEntry | null {
  const id = strOrNull(target.invoiceId);
  const number = strOrNull(target.invoiceNumber);
  if (id !== null) {
    for (const v of index.values()) {
      if (v !== "ambiguous" && v.id === id) return v;
    }
    return null;
  }
  if (number !== null) {
    const hit = index.get(number);
    return hit === undefined || hit === "ambiguous" ? null : hit;
  }
  return null;
}

/**
 * Build the `POST /invoices/bulk` body for the IN v5 `mark_sent` action (PURE,
 * unit-tested). ONE call for all ids (fan-out, repo rule 6). Status-only: it
 * carries NEVER an email/notify field (that is the separate `email_invoice`
 * action). Mirrors the archiveTasks `{action, ids}` bulk shape.
 *
 * @param ids Invoice hashids to transition Draft -> Sent.
 * @returns The IN v5 `/invoices/bulk` body.
 */
export function mapMarkSentBody(ids: string[]): Record<string, unknown> {
  return { action: "mark_sent", ids };
}

// ---------------------------------------------------------------------------
// Invoice-from-tasks path (design/specs/invoiceninja-invoice-tasks.spec.md).
// `upsertInvoices` builds line items via readInvoiceLineItems, which DROPS
// `task_id` — so a hand-built line can reproduce the dollar total but cannot
// link the tasks or mark them invoiced (a double-bill hazard). `invoiceTasks`
// creates ONE draft invoice from a set of IN tasks the way IN's UI does: fetch
// each task, build a task-linked service line (precise hours x rate,
// time-details notes, `task_id`), POST /invoices, and confirm each task became
// invoiced (its `invoice_id` flipped). Draft-only, number-dedup'd, dry-by-
// default, NEVER emails. Additive: reuses inFetch/inFetchAll + getTask
// normalization + the single-writer + finally-flush discipline; touches none of
// the frozen bodies.
// ---------------------------------------------------------------------------

/** Three-letter month names for the frozen task-time-details HTML format. */
const TASK_TIME_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Format an epoch-second timestamp for the task-time-details HTML.
 * `full` = `D/Mon/YYYY HH:MM:SS` (day WITHOUT a leading zero, matching IN's
 * `j/M/Y` rendering on invoice 0072); `time` = `HH:MM:SS` (24h, zero-padded).
 *
 * LIVE-VERIFICATION UNKNOWN (spec verification #3): the epoch is rendered in
 * UTC here so the PURE builder stays deterministic and config-free. IN's UI
 * renders in the COMPANY timezone; if the sandbox diff shows a timezone offset,
 * the caller must thread the company tz through (getCompanySettings fetches the
 * company but does not yet normalize its timezone). The div STRUCTURE is frozen
 * against 0072; only the wall-clock offset is unverified.
 */
function formatTaskTimestamp(epochSec: number): { full: string; time: string } {
  const d = new Date(epochSec * 1000);
  const day = d.getUTCDate(); // no leading zero (matches "18/Aug/2026")
  const mon = TASK_TIME_MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const time = `${hh}:${mm}:${ss}`;
  return { full: `${day}/${mon}/${year} ${time}`, time };
}

/**
 * Build ONE task-linked invoice service line from a normalized task (PURE,
 * unit-tested; mirrors mapInvoiceToBody's build-and-validate style). Reproduces
 * exactly what IN's UI POSTs for a task bucket (verified against invoice 0072):
 *
 * - `quantity` = Σ(stop - start) over CLOSED time-log pairs / 3600, rounded to
 *   3 dp (IN's native precision).
 * - An OPEN pair (`stop == 0`, a running timer) makes the task INELIGIBLE →
 *   returns null (the caller must have already classified it `task-running`; the
 *   open segment is never silently dropped into a partial quantity).
 * - `quantity <= 0` (a zero-hours bucket) → returns null → caller skips
 *   `zero-hours` (IN drops the 0h bucket; readInvoiceLineItems rejects it too).
 * - `cost` = `rateOverride ?? task.rate ?? 0`; a resolved cost that is not a
 *   finite number > 0 makes the task INELIGIBLE → returns null → caller skips
 *   `zero-cost` (never POST a $0 line / mark a task invoiced at $0; COR-1).
 * - `notes` = `task.description` followed by one
 *   `<div class="task-time-details"> D/Mon/YYYY HH:MM:SS -  HH:MM:SS \n </div>`
 *   per closed pair (start = full date+time, stop = time-only; format frozen vs
 *   0072). LIVE-VERIFICATION UNKNOWN (spec verification #3): the inter-div /
 *   description separator is a single space here (the most self-consistent
 *   reading of 0072's `… </div> <div …`) and the timezone is UTC — both must be
 *   diffed against a UI-made invoice before the first live cut.
 * - line = `{ type_id:"2", quantity, cost, notes, task_id, unit_code:"C62" }`
 *   (type_id is the STRING "2", matching 0072).
 *
 * @param task Normalized task (id, description, rate, parsed timeLog pairs).
 * @param rateOverride Optional flat rate; else the task's own rate.
 * @returns The IN line-item row, or null when the task is ineligible.
 */
export function buildTaskLineItem(
  task: {
    id: string;
    description: string | null;
    rate: number | null;
    timeLog: Array<[number, number]>;
  },
  rateOverride?: number,
): Record<string, unknown> | null {
  const pairs = task.timeLog ?? [];
  // An OPEN pair makes the whole task ineligible — never bill a running timer
  // (the caller classifies this `task-running`; this is a defensive redundancy
  // so the pure builder can never emit a line with a dropped open segment).
  if (pairs.some(([, stop]) => stop === 0)) return null;
  let seconds = 0;
  for (const [start, stop] of pairs) seconds += stop - start;
  const quantity = Math.round((seconds / 3600) * 1000) / 1000;
  // Zero/negative-hours bucket → drop it (mirrors IN + readInvoiceLineItems).
  if (!(quantity > 0)) return null;
  const cost = rateOverride ?? task.rate ?? 0;
  // COR-1: positive-cost eligibility guard. A null/0/negative/non-finite rate
  // (with no rateOverride) would otherwise POST a $0 line and mark the task
  // invoiced at $0 (a silent under-bill). Drop it → caller skips `zero-cost`.
  if (!(Number.isFinite(cost) && cost > 0)) return null;
  const divs = pairs.map(([start, stop]) => {
    const s = formatTaskTimestamp(start);
    const e = formatTaskTimestamp(stop);
    return `<div class="task-time-details"> ${s.full} -  ${e.time} \n </div>`;
  });
  const desc = task.description ?? "";
  const notes = [desc, ...divs].filter((p) => p !== "").join(" ");
  return {
    type_id: "2",
    quantity,
    cost,
    notes,
    task_id: task.id,
    unit_code: "C62",
  };
}

/** A per-task classification row for the invoiceTasks audit. */
export interface InvoiceTasksTaskRow {
  taskId: string;
  action: "line" | "skip";
  reason: string | null;
  hours: number | null;
}

/** The result of a single {@link invoiceTasksForOne}. */
export interface InvoiceTasksResult {
  action: "skip" | "would-create" | "created";
  reason?: string;
  invoiceId: string | null;
  lines: Array<Record<string, unknown>>;
  total: number | null;
  taskRows: InvoiceTasksTaskRow[];
  // Per-task / linkage errors to surface into invoiceTasksSyncErrors. Each is a
  // {taskId?, error} the entrypoint stamps with attemptedAt/dryRun/number.
  errors: Array<{ taskId?: string; error: string }>;
}

/** Whether an inFetch error message denotes an HTTP 404 (task not found). */
function isNotFoundError(e: unknown): boolean {
  return e instanceof Error && /HTTP 404\b/.test(e.message);
}

/**
 * Sum an eligible line set's total (Σ cost×quantity); null if any term is
 * non-finite (never persist a non-finite total or compare it for mismatch).
 */
function sumLineTotal(
  lines: Array<Record<string, unknown>>,
): number | null {
  const total = lines.reduce(
    (sum, li) => sum + (li.cost as number) * (li.quantity as number),
    0,
  );
  return Number.isFinite(total) ? total : null;
}

/**
 * Create ONE draft invoice from a set of IN tasks, the way IN's UI does. Order
 * (design/specs/invoiceninja-invoice-tasks.spec.md §invoiceTasksForOne):
 *   0. BLANK-KEY GUARD on `number` → skip `blank-dedup-key` (never `?filter=""`).
 *   1. VALIDATION GATE — clientId charset-valid, taskIds non-empty, each taskId
 *      charset-valid → else skip `invalid`, NO POST. Then DEDUPE taskIds to
 *      unique (first-seen order; SEC-1) — a repeat is a `duplicate-task-id`
 *      per-task skip and can never bill twice.
 *   2. DEDUP on `number` FIRST (before any task fetch; COR-3/COR-5) — paginated
 *      `?filter=number` exact-match (substring-guarded, trash-inclusive, as
 *      upsertInvoice). On a hit → skip `already-exists` immediately, NO task
 *      fetch, NO POST. (exists-amount-mismatch removed — no computed total is
 *      available before classify; COR-2/COR-3.)
 *   3. FETCH + CLASSIFY each unique task (sequential; per-model lock). A task GET
 *      that cleanly 404s → `not-found` skip (+ error), proceed; any OTHER fetch
 *      failure → `task-fetch-failed` skip (+ error), ABORT the invoice by
 *      RETURNING (never under-bill by dropping a task we could not read, never
 *      POST a partial invoice). Classify: wrong-client / already-invoiced /
 *      task-running / zero-cost / zero-hours → per-task skip; else eligible line.
 *   4. NO eligible lines → skip `no-eligible-tasks`, NO POST (a zero-line
 *      invoice is invalid).
 *   5. Build body; NEVER amount/balance or any email/send field.
 *   6. dryRun (default true) → `would-create` with lines + total, NO POST.
 *   7. dryRun=false → POST /invoices (a POST that throws → `post-failed` skip +
 *      error, RETURN, no partial state; COR-5), then read back each eligible task
 *      and confirm its `invoice_id` flipped to the new id before emitting
 *      `created`; a task that did not flip is surfaced as a linkage error
 *      (invoice still recorded). NEVER sets amount/balance or any email/send.
 *
 * Always RETURNS a result (never throws for transient IN fetch/write failures)
 * so the entrypoint records a sync row for every attempted invoice (COR-5).
 *
 * @param cfg Resolved config.
 * @param input An InvoiceTasksInput (number, clientId, taskIds, optional fields).
 * @param dryRun When true, never POSTs.
 * @param doFetch Fetch implementation (injected in tests).
 * @param logger Optional logger.
 */
export async function invoiceTasksForOne(
  cfg: GlobalArgs,
  input: Record<string, unknown>,
  dryRun: boolean,
  doFetch?: FetchLike,
  logger?: MethodLogger,
): Promise<InvoiceTasksResult> {
  const taskRows: InvoiceTasksTaskRow[] = [];
  const errors: Array<{ taskId?: string; error: string }> = [];
  const numberRaw = strOrNull(input.number);
  // (0) blank-key guard — must precede any `?filter=` call.
  if (numberRaw === null || numberRaw.trim() === "") {
    return {
      action: "skip",
      reason: "blank-dedup-key",
      invoiceId: null,
      lines: [],
      total: null,
      taskRows,
      errors,
    };
  }
  // COR-4: trim ONCE right after the blank-guard and use the trimmed value
  // everywhere (the ?filter= dedup query, the exact-equality compare, and the
  // POST body) so " 0073 " dedups against and creates "0073".
  const number = numberRaw.trim();
  // (1) validation gate — clientId charset (a data-format sanity check on the
  // caller-supplied POST-body id), a non-empty task list, and every taskId
  // charset-valid (each IS interpolated into GET /tasks/{id}, so this is the
  // SSRF-style path boundary — a malformed id must never reach a fetch).
  const clientId = strOrNull(input.clientId);
  const rawTaskIds = Array.isArray(input.taskIds) ? input.taskIds : [];
  const taskIds = rawTaskIds.map((t) => strOrNull(t));
  if (
    clientId === null || !isValidHashid(clientId) ||
    taskIds.length === 0 ||
    taskIds.some((t) => t === null || !isValidHashid(t))
  ) {
    return {
      action: "skip",
      reason: "invalid",
      invoiceId: null,
      lines: [],
      total: null,
      taskRows,
      errors,
    };
  }
  const validTaskIds = taskIds as string[];
  // SEC-1 (double-bill): dedupe taskIds to unique, preserving first-seen order.
  // A repeated id must NEVER contribute a second line or to the total; each
  // dropped duplicate is recorded as a visible per-task skip row so a reconcile
  // can see it happened.
  const seenTaskIds = new Set<string>();
  const uniqueTaskIds: string[] = [];
  for (const t of validTaskIds) {
    if (seenTaskIds.has(t)) {
      taskRows.push({
        taskId: t,
        action: "skip",
        reason: "duplicate-task-id",
        hours: null,
      });
      continue;
    }
    seenTaskIds.add(t);
    uniqueTaskIds.push(t);
  }
  const rateOverride = numOrNull(input.rateOverride) ?? undefined;
  // (2) DEDUP on `number` FIRST (COR-3/COR-5; the spec's stated step order):
  // paginated exact-match, TRASH-INCLUSIVE (mirrors upsertInvoice). On a hit →
  // skip `already-exists` IMMEDIATELY, WITHOUT fetching any task, so a re-run
  // never re-GETs tasks and a transient task GET can never turn an
  // already-exists into a thrown error.
  // COR-2/COR-3: exists-amount-mismatch is intentionally REMOVED. We no longer
  // classify tasks before dedup, so no computed line subtotal is available here
  // to compare against the existing invoice — and classifying-before-dedup was
  // the billing-safety bug this reorder fixes. (Were it ever reintroduced on a
  // create path, it must compare the pre-tax line subtotal against the existing
  // invoice's PRE-TAX subtotal, never its tax-inclusive `amount`.)
  const existing = await inFetchAll(
    cfg,
    "invoices",
    [["filter", number], ["with_trashed", "true"]],
    doFetch,
    logger,
  );
  const match = existing.find((row) => strOrNull(row.number) === number);
  if (match) {
    return {
      action: "skip",
      reason: "already-exists",
      invoiceId: strOrNull(match.id),
      lines: [],
      total: null,
      taskRows,
      errors,
    };
  }
  // (3) fetch + classify each UNIQUE task SEQUENTIALLY (per-model lock;
  // single-writer).
  const eligible: Array<{ taskId: string; line: Record<string, unknown> }> = [];
  for (const taskId of uniqueTaskIds) {
    let raw: Record<string, unknown>;
    try {
      const json = await inFetch(
        cfg,
        "GET",
        `tasks/${taskId}`,
        { query: [["include", "client,project,status"]] },
        doFetch,
      );
      raw = (json.data ?? {}) as Record<string, unknown>;
    } catch (e) {
      if (isNotFoundError(e)) {
        taskRows.push({
          taskId,
          action: "skip",
          reason: "not-found",
          hours: null,
        });
        errors.push({ taskId, error: "not-found" });
        continue;
      }
      // COR-3/COR-5: a non-404 task GET failure is transient DATA, not a crash.
      // Never silently under-bill by dropping a task we could not read: record it
      // and ABORT this invoice WITHOUT POSTing (never POST a partial/under-billed
      // invoice), RETURNING a result (not throwing) so the entrypoint still
      // records a sync row for this attempted invoice.
      taskRows.push({
        taskId,
        action: "skip",
        reason: "task-fetch-failed",
        hours: null,
      });
      errors.push({
        taskId,
        error: `task-fetch-failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
      return {
        action: "skip",
        reason: "task-fetch-failed",
        invoiceId: null,
        lines: [],
        total: null,
        taskRows,
        errors,
      };
    }
    const norm = normalizeTask(raw);
    // wrong-client FIRST (security): never invoice another client's task here.
    if (norm.clientId !== clientId) {
      taskRows.push({
        taskId,
        action: "skip",
        reason: "wrong-client",
        hours: null,
      });
      errors.push({ taskId, error: "wrong-client" });
      continue;
    }
    // already-invoiced (task-level double-bill guard, independent of number dedup).
    if (strOrNull(raw.invoice_id) !== null) {
      taskRows.push({
        taskId,
        action: "skip",
        reason: "already-invoiced",
        hours: null,
      });
      continue;
    }
    // task-running (open pair) — never bill a live timer.
    if (norm.isRunning) {
      taskRows.push({
        taskId,
        action: "skip",
        reason: "task-running",
        hours: null,
      });
      errors.push({ taskId, error: "task-running" });
      continue;
    }
    const line = buildTaskLineItem(norm, rateOverride);
    if (line === null) {
      // COR-1: a null line here is either zero-cost or zero-hours (task-running
      // is already handled above). Resolve the cost the same way
      // buildTaskLineItem does; a non-positive/non-finite cost ⇒ `zero-cost`,
      // else `zero-hours`.
      const resolvedCost = rateOverride ?? norm.rate ?? 0;
      const reason = !(Number.isFinite(resolvedCost) && resolvedCost > 0)
        ? "zero-cost"
        : "zero-hours";
      taskRows.push({ taskId, action: "skip", reason, hours: null });
      continue;
    }
    taskRows.push({
      taskId,
      action: "line",
      reason: null,
      hours: line.quantity as number,
    });
    eligible.push({ taskId, line });
  }
  const lines = eligible.map((e) => e.line);
  const total = sumLineTotal(lines);
  // (4) no eligible lines — an invoice with zero lines is invalid; NO POST.
  if (eligible.length === 0) {
    return {
      action: "skip",
      reason: "no-eligible-tasks",
      invoiceId: null,
      lines,
      total,
      taskRows,
      errors,
    };
  }
  // (5) build body. NEVER amount/balance (IN derives) and NEVER an email/send
  // field. status:'sent' → status_id 2, else Draft (1).
  const body: Record<string, unknown> = {
    client_id: clientId,
    number,
    status_id: strOrNull(input.status) === "sent" ? 2 : 1,
    line_items: lines,
  };
  const optional: Array<[string, string]> = [
    ["date", "date"],
    ["dueDate", "due_date"],
    ["poNumber", "po_number"],
    ["publicNotes", "public_notes"],
    ["privateNotes", "private_notes"],
    ["currencyId", "currency_id"],
  ];
  for (const [inKey, outKey] of optional) {
    const v = strOrNull(input[inKey]);
    if (v !== null) body[outKey] = v;
  }
  // (6) dry-run — no write.
  if (dryRun) {
    return {
      action: "would-create",
      invoiceId: null,
      lines,
      total,
      taskRows,
      errors,
    };
  }
  // (7) real create, then per-task read-back to confirm invoice_id flipped.
  // COR-5: a POST that throws is transient DATA, not a crash — catch it, record
  // an error, and RETURN a skip (no partial invoice state, no read-back) so the
  // entrypoint still records a sync row for this attempted invoice.
  let json: Awaited<ReturnType<typeof inFetch>>;
  try {
    json = await inFetch(cfg, "POST", "invoices", { body }, doFetch);
  } catch (e) {
    errors.push({
      error: `post-failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return {
      action: "skip",
      reason: "post-failed",
      invoiceId: null,
      lines,
      total,
      taskRows,
      errors,
    };
  }
  const data = (json.data ?? {}) as Record<string, unknown>;
  const invoiceId = strOrNull(data.id);
  // Confirm each eligible task now shows invoice_id == the new id (spec
  // verification #1: the linkage travels on create). A task that did NOT flip is
  // a linkage gap — surfaced as an error; the invoice is still recorded created.
  for (const { taskId } of eligible) {
    try {
      const back = await inFetch(
        cfg,
        "GET",
        `tasks/${taskId}`,
        { query: [["include", "client,project,status"]] },
        doFetch,
      );
      const backRaw = (back.data ?? {}) as Record<string, unknown>;
      const linked = strOrNull(backRaw.invoice_id);
      if (invoiceId === null || linked !== invoiceId) {
        errors.push({
          taskId,
          error: `linkage-unconfirmed: invoice_id=${linked ?? "null"}`,
        });
      }
    } catch (e) {
      errors.push({
        taskId,
        error: `linkage-readback-failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
  }
  return {
    action: "created",
    invoiceId,
    lines,
    total,
    taskRows,
    errors,
  };
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

/**
 * Resolve the target company id for the company-settings surface. A caller-
 * supplied id is charset-gated (the token is full-account, so an unvalidated id
 * interpolated into `GET/PUT /companies/{id}` is an SSRF-style boundary break —
 * same gate as getProject). When absent, auto-resolve via `GET /companies` and
 * take the SOLE company; fail LOUDLY when the token owns zero or more than one
 * (do not guess which). The resolved id is charset-gated too. Exported for tests.
 *
 * @throws On an invalid id, a zero/multi-company account, or a fetch failure.
 */
export async function resolveCompanyId(
  cfg: GlobalArgs,
  companyId: string | undefined,
  doFetch?: FetchLike,
): Promise<string> {
  // Charset-gate an explicit id FIRST (cheap, no network) - it is the SSRF-style
  // path-interpolation boundary and must never reach a fetch.
  if (companyId !== undefined && !isValidHashid(companyId)) {
    throw new Error(
      `resolveCompanyId: companyId ${JSON.stringify(companyId)} is not a ` +
        `valid IN hashid (/^[A-Za-z0-9]+$/) - refusing to interpolate it ` +
        `into a company path.`,
    );
  }
  // ALWAYS fetch the token's company list - it is the membership ground truth
  // (CS-REV-1). IN's GET/PUT /companies/{id} act on the token-BOUND company and
  // 401/ignore ids the token does not own, so an explicit id must be confirmed
  // present here before we interpolate it into a path.
  const json = await inFetch(cfg, "GET", "companies", {}, doFetch);
  const data = Array.isArray(json.data)
    ? json.data as Array<Record<string, unknown>>
    : [];
  const ownedIds = data
    .map((c) => strOrNull(c.id))
    .filter((x): x is string => x !== null);
  if (companyId !== undefined) {
    if (!ownedIds.includes(companyId)) {
      throw new Error(
        `resolveCompanyId: companyId ${JSON.stringify(companyId)} is not ` +
          `owned by this token.`,
      );
    }
    return companyId;
  }
  if (data.length === 0) {
    throw new Error(
      "resolveCompanyId: GET /companies returned no company for this token - " +
        "pass companyId explicitly.",
    );
  }
  if (data.length > 1) {
    throw new Error(
      `resolveCompanyId: token owns ${data.length} companies; pass ` +
        `companyId explicitly.`,
    );
  }
  const id = strOrNull(data[0].id);
  if (id === null || !isValidHashid(id)) {
    throw new Error(
      `resolveCompanyId: resolved company id ${JSON.stringify(id)} is not a ` +
        `valid IN hashid - refusing to use it.`,
    );
  }
  return id;
}

/**
 * Assert the company a GET/PUT actually acted on matches the id we targeted
 * (CS-REV-1). IN's `/companies/{id}` endpoints operate on the TOKEN-bound
 * company and ignore the path id, so a response whose `raw.id` differs from what
 * we asked for means we are about to read/write the WRONG company - fail loudly
 * rather than silently proceed. Returns the ground-truth id (`raw.id`) for the
 * audit trail. PURE (no I/O).
 */
export function assertCompanyIdMatch(
  raw: Record<string, unknown>,
  requested: string,
): string {
  const actual = strOrNull(raw.id);
  if (actual !== requested) {
    throw new Error(
      `company id mismatch: requested ${JSON.stringify(requested)} but ` +
        `GET /companies/{id} returned ${JSON.stringify(actual)} - IN's ` +
        `/companies/{id} endpoints act on the token-bound company regardless ` +
        `of the path id, so refusing to proceed (would touch the wrong company).`,
    );
  }
  return actual;
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

// ---------------------------------------------------------------------------
// Task timer (design §4) — a STATEFUL action over a task's `time_log`, NOT CRUD.
//
// STEP-0 finding (verified against invoiceninja/invoiceninja v5-stable source,
// NOT a live/sandbox instance): there are NO dedicated `POST /tasks/{id}/start`
// or `/stop` endpoints. `routes/api.php` exposes only
// `Route::resource('tasks', TaskController::class)` (+ bulk/sort/upload), so a
// timer flip is a `PUT /tasks/{id}` that rewrites `time_log` — the design's
// default model. `time_log` is a JSON array of entries `[start, stop, …]` whose
// timestamps are UNIX seconds (Task.php `normalizeTimeLog` casts `(int)$log[0]`
// and `Carbon::createFromTimestamp(...)` reads seconds); an entry is OPEN
// (running) when its stop element (index 1) is 0 or absent. Entries may carry
// trailing elements (description, billable) which these helpers PRESERVE. The
// per-model lock + single-writer discipline is the guard against concurrent
// start/stop corrupting `time_log` (same as the create paths — no extra code).
//
// The helpers below are PURE + unit-tested; the clock enters as an explicit
// `nowSec` param (mirrors the injected `today` in normalizeInvoice) so timer
// logic is deterministic without wall-clock flake. NOTE: a sibling agent builds
// tasks CRUD in parallel, so `hasOpenTimeLogPair`/`latestOpenPairIndex` are
// defined here independently; the orchestrator unifies any duplicate at
// integration.
// ---------------------------------------------------------------------------

/**
 * One `time_log` entry — normally `[start, stop, description?, billable?]`, but
 * typed `unknown` because a stored log may contain legacy/non-array junk we must
 * PRESERVE on round-trip (TMR-SEC-2), not silently drop.
 */
export type TimeLogEntry = unknown;

/**
 * Parse a task's `time_log` into an array of entry-arrays. IN returns it as a
 * JSON-encoded STRING (e.g. `"[[1710000000,0]]"`); tolerate an already-parsed
 * array too. A null/blank/malformed value or a non-array parse result → `[]`.
 * Every entry is PRESERVED verbatim (TMR-SEC-2) — including any legacy/non-array
 * element — so a later PUT round-trips the whole log and never silently deletes
 * data. Entry-level helpers (`isOpenEntry`) treat a non-array entry as not-open,
 * so junk never masquerades as a running pair.
 */
export function parseTimeLogEntries(raw: unknown): TimeLogEntry[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return [];
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

/**
 * Whether an entry is OPEN (the timer is running for it): its stop element
 * (index 1) is absent, 0, or non-positive. `numOrNull` coerces IN's stringy
 * numbers before the comparison.
 */
export function isOpenEntry(entry: unknown): boolean {
  // A non-array/legacy entry is never an open pair (TMR-SEC-2): it is preserved
  // on round-trip but must not be treated as a running timer.
  if (!Array.isArray(entry)) return false;
  const stop = numOrNull(entry[1]);
  return stop === null || stop <= 0;
}

/**
 * Index of the LATEST (highest-index) open entry in a parsed `time_log`, or
 * `-1` when none is open. "Latest" so a task with multiple prior closed pairs
 * plus one trailing open pair stops the RIGHT (most recent) pair.
 */
export function latestOpenPairIndex(log: TimeLogEntry[]): number {
  for (let i = log.length - 1; i >= 0; i--) {
    if (isOpenEntry(log[i])) return i;
  }
  return -1;
}

/** Whether ANY entry is an open pair (the task is currently running). */
export function hasOpenTimeLogPair(log: TimeLogEntry[]): boolean {
  return latestOpenPairIndex(log) >= 0;
}

/**
 * Append a new open pair `[nowSec, 0]`. Returns a NEW log (no mutation of the
 * input or its entries).
 */
export function appendOpenPair(
  log: TimeLogEntry[],
  nowSec: number,
): TimeLogEntry[] {
  return [...log, [nowSec, 0]];
}

/**
 * Close the entry at `index` by setting its stop (index 1) to `nowSec`,
 * PRESERVING any trailing elements (description/billable). Returns a NEW log;
 * the input and its other entries are untouched. A missing start slot is
 * back-filled with 0 so the closed entry is always a well-formed pair.
 */
export function closeOpenPair(
  log: TimeLogEntry[],
  index: number,
  nowSec: number,
): TimeLogEntry[] {
  return log.map((entry, i) => {
    if (i !== index) return entry;
    // `index` comes from latestOpenPairIndex, which only returns array entries.
    const copy = [...(entry as unknown[])];
    if (copy.length === 0) copy.push(0);
    copy[1] = nowSec;
    return copy;
  });
}

/** The pure decision produced by {@link decideStart}/{@link decideStop}. */
export interface TimerDecision {
  running: boolean;
  action: "started" | "already-running" | "stopped" | "not-running";
  /** The would-be `time_log` after the flip (same array when unchanged). */
  newLog: TimeLogEntry[];
  /** Whether a PUT is needed (false ⇒ idempotent no-op, never PUTs). */
  changed: boolean;
}

/**
 * Decide the outcome of a `startTask` given the current parsed `time_log`. An
 * already-open pair ⇒ idempotent no-op (`already-running`, no change); else
 * append `[nowSec, 0]` (`started`). PURE.
 */
export function decideStart(
  log: TimeLogEntry[],
  nowSec: number,
): TimerDecision {
  if (hasOpenTimeLogPair(log)) {
    return {
      running: true,
      action: "already-running",
      newLog: log,
      changed: false,
    };
  }
  return {
    running: true,
    action: "started",
    newLog: appendOpenPair(log, nowSec),
    changed: true,
  };
}

/**
 * Decide the outcome of a `stopTask` given the current parsed `time_log`. No
 * open pair ⇒ idempotent no-op (`not-running`, no change); else close the
 * LATEST open pair at `nowSec` (`stopped`). PURE.
 */
export function decideStop(
  log: TimeLogEntry[],
  nowSec: number,
): TimerDecision {
  const idx = latestOpenPairIndex(log);
  if (idx < 0) {
    return {
      running: false,
      action: "not-running",
      newLog: log,
      changed: false,
    };
  }
  // Derive `running` from the RESULT (TMR-COR-1): with a malformed pre-existing
  // log carrying multiple open pairs, closing the latest still leaves an earlier
  // one open — so the flag must reflect the actual post-close state, not a
  // hardcoded false that would contradict the persisted timeLog.
  const newLog = closeOpenPair(log, idx, nowSec);
  return {
    running: hasOpenTimeLogPair(newLog),
    action: "stopped",
    newLog,
    changed: true,
  };
}

/** The task-timer outcome resource (§4) — one row per startTask/stopTask flip. */
const TaskTimerSchema = z.object({
  taskId: z.string(),
  running: z.boolean(),
  action: z.enum(["started", "already-running", "stopped", "not-running"]),
  dryRun: z.boolean(),
  // The would-be `time_log` after the flip (structured; entries are mixed
  // [start, stop, …]). On a dry run this is the state that WOULD be PUT.
  timeLog: z.array(z.array(z.unknown())),
  at: z.string(),
});

export const model = {
  type: "@shrug/invoiceninja",
  version: "2026.09.22.1",
  description:
    "Invoice Ninja v5 (/api/v1): read invoices/payments/expenses + mapping " +
    "lists, an idempotent gated-write upsertExpense (dedup on custom_value1), a " +
    "mapping-write path (upsertVendors/upsertExpenseCategories/buildMapping) that " +
    "auto-creates reference data and derives the Mapping, with a faithful §7.6 " +
    "dry-run mapping projection (sentinel-bound would-create names), an " +
    "idempotent invoice-write path upsertInvoices (dedup on `number`, full " +
    "product/service line items, draft-only — never emails), a payment-apply " +
    "path applyPayments (dedup on `transaction_reference`, recognizes received " +
    "payments against existing invoices — the only correct way to mark an " +
    "invoice Paid), a mark-sent path markSent (bulk `mark_sent` — transitions " +
    "Draft invoices to Sent so they gain a balance; status-only, never emails), " +
    "an invoice-from-tasks path invoiceTasks (create ONE draft invoice from a " +
    "set of tasks the way IN's UI does — task-linked service lines with precise " +
    "hours + task_id, dedup on `number`, draft-only, never emails), " +
    "and the core-entity " +
    "surfaces clients (lean listClients discovery + by-id getClients + " +
    "upsertClients, PII-sensitive short-lived snapshot), projects (list/get + " +
    "upsertProjects), tasks (list/get + " +
    "upsertTasks), and a stateful task timer (startTask/stopTask over time_log). " +
    "All writes gated behind dryRun (default true).",
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
    {
      toVersion: "2026.07.22.1",
      description:
        "Dry-run mapping projection (§7.6): buildMapping (dryRun=true, the " +
        "default) now unions would-create vendor/category names from " +
        "vendorSync/categorySync into the emitted mapping, bound to the " +
        "DRYRUN_SENTINEL id, so an all-dryRun preview resolves a would-create " +
        "vendor/category instead of reporting a phantom unmatchedVendor/None " +
        "fallback. upsertExpenses gains additive projectedVendor/" +
        "projectedCategory preview-only fields on expenseSync rows (never part " +
        "of the IN POST body), and a live-write guard throws if a resolved " +
        "vendor_id/category_id is ever the sentinel. dryRun=false is byte-for-" +
        "byte unchanged. Additive — no frozen-schema change (Mapping shape " +
        "unchanged; expenseSync fields additive with defaults).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.08.1",
      description:
        "Add the invoice-write path (design/invoiceninja-invoice-write.md): a " +
        "second gated-write fan-out upsertInvoices — check-then-create invoices " +
        "idempotent on `number`, full product/service line_items (type→type_id " +
        "1/2), draft-only (status_id 1, optional 'sent'→2, NEVER emails/sends), " +
        "with two additive resources (invoiceSync/invoiceSyncErrors) mirroring " +
        "the expense writer's single-writer + finally-flush discipline. " +
        "globalArguments is unchanged, so this is a no-op attribute migration " +
        "(existing instances upgrade cleanly with no field changes).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.08.2",
      description:
        "Add the core-entity surfaces (design/invoiceninja-entity-crud.md): " +
        "clients — listClients (lean id/number/name discovery, no contact PII) " +
        "+ getClients (by-id batch fan-out, full PII) + upsertClients (dedup on " +
        "`number`), with short-lived (config clientSnapshotLifetime, default " +
        "'1h'), gc=1, PII-sensitive read snapshots; projects — listProjects/" +
        "getProject + upsertProjects (dedup on `number`, references a client); " +
        "tasks — listTasks/getTask + upsertTasks (dedup on `custom_value1`, never " +
        "writes time_log) with a pure isRunning derivation; and a stateful task " +
        "timer — startTask/stopTask, a PUT /tasks/{id} that rewrites time_log " +
        "(UNIX-seconds, open pair = stop 0/absent), idempotent no-ops with an " +
        "injectable clock. All writes reuse the single inFetch/inFetchAll seam " +
        "(widened to PUT), the single-writer + finally-flushed *Sync/*SyncErrors " +
        "discipline, and dryRun (default true). Additive: the new optional " +
        "clientSnapshotLifetime config carries a default, so existing instances " +
        "upgrade cleanly (no-op attribute migration).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.1",
      description: "Add the payment-apply path " +
        "(design/specs/invoiceninja-payment-apply.spec.md): a gated fan-out " +
        "applyPayments — check-then-create payments idempotent on " +
        "`transaction_reference`, recognizing a received payment against an " +
        "existing invoice (the ONLY correct way to mark an invoice Paid — never " +
        "writes status_id:4, never sets a top-level amount or any email/notify " +
        "field). Fail-closed on a blank dedup key, an unresolved/ambiguous " +
        "invoice, an already-paid target, or an over-apply. Two additive " +
        "resources (paymentSync/paymentSyncErrors) mirror the invoice writer's " +
        "single-writer + finally-flush discipline. globalArguments is unchanged, " +
        "so this is a no-op attribute migration (existing instances upgrade " +
        "cleanly with no field changes).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.19.1",
      description: "Add the mark-sent path " +
        "(design/specs/invoiceninja-mark-sent.spec.md): a gated fan-out " +
        "markSent — transition Draft invoices (status_id 1) to Sent " +
        "(status_id 2) via IN's bulk `mark_sent` action so each gains a balance " +
        "and applyPayments can then recognize it Paid. Prefetch the invoice " +
        "index ONCE (trash-exclusive number->{id,statusId}); resolve by " +
        "invoiceId OR invoiceNumber (unresolved/ambiguous -> skip unresolved); " +
        "classify (Draft -> eligible, Sent/Partial -> already-sent, Paid -> " +
        "already-paid, else -> not-draft); dryRun (default true) -> would-send, " +
        "NO POST; else ONE POST /invoices/bulk then a read-back confirms " +
        "status_id 2 before emitting `sent`. STATUS-ONLY — NEVER sets any " +
        "email/notify field. Two additive resources (markSentSync/" +
        "markSentSyncErrors) mirror the payment writer's single-writer + " +
        "finally-flush discipline. globalArguments is unchanged, so this is a " +
        "no-op attribute migration (existing instances upgrade cleanly with no " +
        "field changes).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.21.1",
      description: "Add the company-settings surface " +
        "(design/specs/invoiceninja-company-settings.spec.md): a read method " +
        "getCompanySettings (GET /companies/{id}) snapshots the custom-field " +
        "LABELS (task/invoice/client/product slots 1..4, `Label|type` encoded), " +
        "currency_id, and date_format_id into a normalized " +
        "companySettings resource; and a declarative, dry-by-default reconcile " +
        "reconcileCompanySettings that diffs a desired set per-field and, only " +
        "when dryRun=false, round-trips the FULL live settings/custom_fields " +
        "objects (mutating only changed target keys) back via PUT /companies/" +
        "{id} so unmanaged sibling keys are never wiped. companyId auto-resolves " +
        "via GET /companies when absent (fails loudly on more than one company) " +
        "and is charset-gated before path interpolation. Two additive resources " +
        "(companySettingsSync/companySettingsSyncErrors) mirror the project " +
        "writer's single-writer + finally-flush discipline. globalArguments is " +
        "unchanged, so this is a no-op attribute migration (existing instances " +
        "upgrade cleanly with no field changes).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.22.1",
      description: "Add the invoice-from-tasks path " +
        "(design/specs/invoiceninja-invoice-tasks.spec.md): a gated method " +
        "invoiceTasks — create ONE draft invoice from a set of IN tasks the way " +
        "IN's UI does. buildTaskLineItem (PURE) builds a task-linked service " +
        "line per task (precise 3-dp hours from CLOSED time_log pairs x rate, " +
        "the task-time-details notes HTML frozen vs invoice 0072, task_id, " +
        "unit_code C62, type_id '2'); invoiceTasksForOne fetches + classifies " +
        "each task (wrong-client/not-found/already-invoiced/task-running/zero-" +
        "hours/zero-cost/duplicate-task-id -> per-task skip), dedups on `number` " +
        "(paginated exact-match, BEFORE task classify), and on dryRun=false POSTs " +
        "/invoices then reads " +
        "back each task's invoice_id linkage. Draft-only, NEVER emails/sends, " +
        "NEVER sets amount/balance. Two additive resources (invoiceTasksSync/" +
        "invoiceTasksSyncErrors) mirror the invoice writer's single-writer + " +
        "finally-flush discipline. globalArguments is unchanged, so this is a " +
        "no-op attribute migration (existing instances upgrade cleanly with no " +
        "field changes).",
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
    "invoiceSync": {
      description:
        "One row per invoice processed by upsertInvoice (invoice-write path); " +
        "dedup on `number`.",
      schema: InvoiceSyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "invoiceSyncErrors": {
      description:
        "Durable audit of failed/rejected invoice writes — one row per invoice " +
        "whose POST threw or whose input was blank/invalid; flushed even when " +
        "empty. Kept separate from the frozen expenseSyncErrors.",
      schema: InvoiceSyncErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "paymentSync": {
      description:
        "One row per payment processed by applyPayment (payment-apply path); " +
        "dedup on `transaction_reference`. PII-light (clientId + invoice ids).",
      schema: PaymentSyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "paymentSyncErrors": {
      description:
        "Durable audit of failed/rejected payment applications — one row per " +
        "payment whose POST threw or whose input was blank/invalid/unresolved/" +
        "over-apply; flushed even when empty. Kept separate from the frozen " +
        "invoice/expense error resources.",
      schema: PaymentSyncErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "markSentSync": {
      description:
        "One row per invoice processed by markSent (mark-sent path); a Draft " +
        "transitioned to Sent via the bulk `mark_sent` action. Carries no " +
        "counterparty PII (invoice id + status only).",
      schema: MarkSentSyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "markSentSyncErrors": {
      description:
        "Durable audit of failed/rejected mark-sent transitions — one row per " +
        "unresolved target, bulk POST that threw, or read-back that did not " +
        "confirm status_id 2; flushed even when empty. Kept separate from the " +
        "frozen invoice/payment error resources.",
      schema: MarkSentSyncErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "invoiceTasksSync": {
      description:
        "One row per invoice processed by invoiceTasks (invoice-from-tasks " +
        "path); a draft invoice built from a set of tasks (one task-linked " +
        "service line each). Carries the per-task classification (taskRows) + " +
        "computed total. No counterparty PII (client id + task ids only).",
      schema: InvoiceTasksSyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "invoiceTasksSyncErrors": {
      description:
        "Durable audit of failed/rejected invoice-from-tasks writes — one row " +
        "per blank/invalid input, rejected task (wrong-client/not-found/task-" +
        "running), POST that threw, or eligible task whose read-back did not " +
        "confirm its invoice_id flipped; flushed even when empty. Kept separate " +
        "from the frozen invoice/payment/mark-sent error resources.",
      schema: InvoiceTasksSyncErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "clients": {
      description:
        "By-id client snapshot (getClients, §1) — deliberately short-lived + " +
        "single-version + PII-field-sensitive. Carries per-id read errors " +
        "(blank/invalid ids, fetch failures). lifetime is a DEFAULT; getClients " +
        "overrides it per-write from cfg.clientSnapshotLifetime.",
      schema: ClientListSchema,
      // Short default so client PII auto-expires; getClients overrides per-write.
      lifetime: "1h",
      // Keep only the latest version — no PII history.
      garbageCollection: 1,
    },
    "clientList": {
      description:
        "Lean client discovery snapshot (listClients, §1) — id/number/name " +
        "ONLY (no contacts/email/phone/address/id_number). The low-PII " +
        "discovery surface; full client PII requires an explicit getClients " +
        "fetch. Short-lived + single-version; the `name` field is sensitive. " +
        "lifetime is a DEFAULT; listClients overrides per-write from " +
        "cfg.clientSnapshotLifetime.",
      schema: ClientLeanListSchema,
      // Short default so even the lean snapshot auto-expires; overridden per-write.
      lifetime: "1h",
      // Keep only the latest version — no client-name history.
      garbageCollection: 1,
    },
    "clientDomains": {
      description:
        "Client email-DOMAIN snapshot (clientDomains, §7) — the deduped SET of " +
        "customer contact email domains ONLY (no local part, no full address, no " +
        "name/contact PII). Powers the lead-spam known-customer hard-pass. No " +
        "field is sensitive (a bare domain carries no person identity). " +
        "lifetime is a DEFAULT; clientDomains overrides per-write from " +
        "cfg.clientSnapshotLifetime.",
      schema: ClientDomainsSchema,
      lifetime: "1h",
      // Keep only the latest version.
      garbageCollection: 1,
    },
    "clientSync": {
      description:
        "One row per client processed by upsertClient (client-write path); dedup " +
        "on `number`. PII-free (number + resolved clientId only).",
      schema: ClientSyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "clientSyncErrors": {
      description:
        "Durable audit of failed/rejected client writes — one row per client " +
        "whose POST threw or whose input was blank/invalid; flushed even when " +
        "empty. PII-free.",
      schema: ClientSyncErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "projects": {
      description:
        "A project list snapshot (§2 entity-crud; low-PII — infinite/GC-20).",
      schema: ProjectListSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "project": {
      description: "A single detailed project (`/projects/{id}`).",
      schema: SingleSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "projectSync": {
      description:
        "One row per project processed by upsertProject (§2); dedup on `number`.",
      schema: ProjectSyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "projectSyncErrors": {
      description:
        "Durable audit of failed/rejected project writes (§2) — flushed even " +
        "when empty. Kept separate from the frozen invoice/expense error resources.",
      schema: ProjectSyncErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "companySettings": {
      description:
        "A normalized company-settings snapshot (getCompanySettings): custom-" +
        "field labels (task/invoice/client/product slots 1..4) + currency/date/" +
        "number-format identifiers. Low-PII config — infinite/GC-20.",
      schema: CompanySettingsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "companySettingsSync": {
      description:
        "Per-field reconcile audit (reconcileCompanySettings): one row per diffed " +
        "custom-field/setting with current/desired/changed + outcome action. " +
        "Preview on dryRun; records whether a PUT committed via `applied`.",
      schema: CompanySettingsSyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "companySettingsSyncErrors": {
      description:
        "Durable audit of a failed company-settings reconcile (resolve/GET/PUT " +
        "that threw) — flushed even when empty. Kept separate from the frozen " +
        "write error resources.",
      schema: CompanySettingsSyncErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "tasks": {
      description: "A task list snapshot (§3; timeLog + derived isRunning)",
      schema: TaskListSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "task": {
      description:
        "A single normalized task (`/tasks/{id}`); same row shape as the list.",
      schema: TaskSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "taskSync": {
      description:
        "One row per task processed by upsertTask (task-write path); dedup on " +
        "`number`.",
      schema: TaskSyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "taskSyncErrors": {
      description:
        "Durable audit of failed/rejected task writes — one row per task whose " +
        "POST threw or whose input was blank/invalid; flushed even when empty.",
      schema: TaskSyncErrorsSchema,
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
    "categoryMerge": {
      description:
        "Durable audit of a mergeExpenseCategories run (reassignments, archived " +
        "sources, skipped, per-PUT errors) — flushed even on a mid-batch failure.",
      schema: CategoryMergeSchema,
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
    "finopsDigest": {
      description:
        "A rendered markdown view (summary|detailed) of the daily dry-run, written " +
        "by finopsDigest (design/finops-digest.md).",
      schema: FinopsDigestSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "taskTimer": {
      description:
        "Outcome of a startTask/stopTask timer flip (task time_log action, §4).",
      schema: TaskTimerSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  files: {
    "finopsHtml": {
      description:
        "Email-ready, self-contained HTML view of the daily dry-run, written by " +
        "finopsDigest (design/finops-digest.md).",
      contentType: "text/html",
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
        scope: z.string().min(1).optional().describe(
          "Optional instance-name qualifier: suffixes the written snapshot " +
            "instance name with `--<scope>` so a pipeline's snapshots do not " +
            "collide with another workflow's bare-named ones (data.latest is " +
            "an exact-name lookup). Absent = the historical bare name.",
        ),
      }),
      execute: async (
        args: {
          clientId?: string;
          clientStatus?: string;
          scope?: string;
          _fetch?: FetchLike;
        },
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
        ]) + (args.scope ? `--${args.scope}` : "");
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
    // --- Clients read (§1) — by-id batch fan-out; NO blanket listClients. ---
    getClients: {
      description:
        "GET /clients/{id}?include=contacts per id (batch fan-out, sequential; " +
        "per-model lock). Each id charset-validated (/^[A-Za-z0-9]+$/); a blank/" +
        "invalid id is skipped + surfaced in an errors row, NEVER interpolated " +
        "into a path. → clients (short-lived per cfg.clientSnapshotLifetime, " +
        "gc=1, PII fields sensitive).",
      arguments: z.object({
        // A batch of ids. Unlike getInvoice (single id, regex at the schema
        // boundary), these are validated PER-ELEMENT inside execute so one bad
        // id doesn't reject the whole batch — it's skipped + surfaced instead.
        ids: z.array(z.string()).describe(
          "IN client hashids; each validated /^[A-Za-z0-9]+$/. A blank/invalid " +
            "id is skipped + surfaced in the errors[] row, never a path.",
        ),
        scope: z.string().min(1).optional().describe(
          "Optional instance-name qualifier: writes the snapshot as " +
            "`clients--<scope>` so a pipeline's snapshot does not collide with " +
            "another workflow's bare `clients` one. Absent = bare `clients`.",
        ),
      }),
      execute: async (
        args: { ids: string[]; scope?: string; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const items: Array<Record<string, unknown>> = [];
        const errors: Array<{ id: string; error: string }> = [];
        // Sequential fan-out (per-model lock; single request each — inFetch, not
        // inFetchAll: GET /clients/{id} returns one record).
        for (const rawId of args.ids) {
          const id = strOrNull(rawId);
          if (id === null || !isValidHashid(id)) {
            // Never interpolate a failing id into the path; surface it instead.
            errors.push({ id: id ?? "", error: "invalid-id" });
            continue;
          }
          try {
            const json = await inFetch(
              cfg,
              "GET",
              `clients/${id}`,
              { query: [["include", "contacts"]] },
              args._fetch,
            );
            const raw = (json.data ?? {}) as Record<string, unknown>;
            items.push(normalizeClient(raw));
          } catch (e) {
            // A single failed fetch must not abort the batch (mirrors the write
            // fan-out). The error MESSAGE from inFetch carries only method/path/
            // status — no token, no PII.
            context.logger.warning("getClients failed for {id}", { id });
            errors.push({
              id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        context.logger.info(
          "Fetched {n} client(s), {e} error(s)",
          { n: items.length, e: errors.length },
        );
        // Single `clients` resource carries rows + per-id errors. Override the
        // lifetime per-write from cfg so the PII snapshot honors the operator's
        // TTL (default "1h"); gc=1 (latest only) comes from the spec.
        const clientsName = args.scope ? `clients--${args.scope}` : "clients";
        const handle = await context.writeResource(
          "clients",
          clientsName,
          {
            scope: clientsName,
            count: items.length,
            items,
            errors,
            retrievedAt: new Date().toISOString(),
          },
          { lifetime: cfg.clientSnapshotLifetime },
        );
        return { dataHandles: [handle] };
      },
    },
    listClients: {
      description:
        "GET /clients (paginated; NO include=contacts, optional ?filter=) → " +
        "clientList: LEAN {id,number,name} rows ONLY. The heavy PII (contacts/" +
        "email/phone/address/id_number) is neither fetched nor stored — this is " +
        "the discovery surface (resolve a name/number→id), and full PII requires " +
        "an explicit getClients(ids) fetch (§1). Short-lived (cfg." +
        "clientSnapshotLifetime), gc=1, `name` sensitive.",
      arguments: z.object({
        // A ?filter= search term (name/number/email substring). Query param
        // ONLY — never interpolated into a path — so no charset gate is needed
        // (unlike getClients' by-id path segments).
        filter: z.string().optional().describe(
          "IN ?filter= search term (name/number/email substring). Query param " +
            "only, never a path segment.",
        ),
      }),
      execute: async (
        args: { filter?: string; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        // Deliberately NO include=contacts: the lean snapshot must never even
        // fetch contact emails. inFetchAll paginates GET /clients to completion.
        const query: Array<[string, string]> = [];
        const filter = strOrNull(args.filter);
        if (filter !== null) query.push(["filter", filter]);
        context.logger.info("Listing clients (lean discovery)");
        const rows = await inFetchAll(
          cfg,
          "clients",
          query,
          args._fetch,
          context.logger,
        );
        const items = rows.map((r) => normalizeClientLean(r));
        context.logger.info("{count} client(s) (lean)", {
          count: items.length,
        });
        // CLI-SEC-1: the filter term may be raw PII (a name/number/email the
        // caller searched). The resource NAME is a separate addressing channel
        // that field-level `.meta({sensitive})` does NOT cover and would
        // accumulate unbounded, un-TTL'd PII in the catalog. Use a CONSTANT name
        // (like the `clients` resource) — gc=1 keeps only the latest lean
        // snapshot; the filter lives only in the (transient) query, never the key.
        const name = "clients-list";
        // Override lifetime per-write so even the lean snapshot honors the
        // operator TTL (default "1h"); gc=1 (latest only) comes from the spec.
        const handle = await context.writeResource(
          "clientList",
          name,
          {
            scope: "clients-list",
            count: items.length,
            items,
            retrievedAt: new Date().toISOString(),
          },
          { lifetime: cfg.clientSnapshotLifetime },
        );
        return { dataHandles: [handle] };
      },
    },
    clientDomains: {
      description:
        "GET /clients?include=contacts (paginated) → clientDomains: the DEDUPED " +
        "SET of client contact email DOMAINS (text after @, lowercased) ONLY. " +
        "The local part and full address are extracted to a domain in-method and " +
        "then DISCARDED — never stored, never logged. This is the lead-spam " +
        "known-customer allowlist source (design/lead-spam-filter.md §7): it " +
        "exposes domain-only, so a returning customer hard-passes the spam gate " +
        "without any contact PII leaving IN. Free-mail domains are NOT filtered " +
        "here (the consumer applies its blocklist). Short-lived " +
        "(cfg.clientSnapshotLifetime), gc=1.",
      arguments: z.object({
        // Query param ONLY (never a path segment), so no charset gate — same as
        // listClients' filter.
        filter: z.string().optional().describe(
          "IN ?filter= search term (name/number/email substring). Query param " +
            "only, never a path segment.",
        ),
      }),
      execute: async (
        args: { filter?: string; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        // include=contacts IS required to read emails — but only the DOMAIN
        // survives: emails are reduced to domains below and never written/logged.
        const query: Array<[string, string]> = [["include", "contacts"]];
        const filter = strOrNull(args.filter);
        if (filter !== null) query.push(["filter", filter]);
        context.logger.info("Collecting client email domains (§7 allowlist)");
        const rows = await inFetchAll(
          cfg,
          "clients",
          query,
          args._fetch,
          context.logger,
        );
        const clients = rows.map((r) => normalizeClient(r));
        const domains = collectClientDomains(clients);
        // Log the COUNT only — never the domains or emails themselves.
        context.logger.info("{count} distinct client domain(s)", {
          count: domains.length,
        });
        // Domain-only snapshot; override lifetime per-write from cfg (default
        // "1h"); gc=1 (latest only) from the resource spec.
        const handle = await context.writeResource(
          "clientDomains",
          "client-domains",
          {
            scope: "client-domains",
            count: domains.length,
            domains,
            retrievedAt: new Date().toISOString(),
          },
          { lifetime: cfg.clientSnapshotLifetime },
        );
        return { dataHandles: [handle] };
      },
    },
    // --- Projects read (design/invoiceninja-entity-crud.md §2) ---
    listProjects: {
      description:
        "GET /projects (paginated, include=client; optional client_id filter) → " +
        "projects snapshot.",
      arguments: z.object({
        clientId: z.string().optional(),
        scope: z.string().min(1).optional().describe(
          "Optional instance-name qualifier: suffixes the written snapshot " +
            "instance name with `--<scope>` so a pipeline's snapshots do not " +
            "collide with another workflow's bare-named ones. Absent = bare name.",
        ),
      }),
      execute: async (
        args: { clientId?: string; scope?: string; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const query: Array<[string, string]> = [["include", "client"]];
        if (args.clientId) query.push(["client_id", args.clientId]);
        context.logger.info("Fetching projects");
        const rows = await inFetchAll(
          cfg,
          "projects",
          query,
          args._fetch,
          context.logger,
        );
        const items = rows.map((r) => normalizeProject(r));
        context.logger.info("{count} projects", { count: items.length });
        const name = scopeName("projects", [
          args.clientId && `client=${encodeURIComponent(args.clientId)}`,
        ]) + (args.scope ? `--${args.scope}` : "");
        return writeSnapshot(context, "projects", name, items);
      },
    },
    getProject: {
      description: "GET /projects/{id}?include=client → project.",
      arguments: z.object({
        // Constrain to the IN hashid charset (alphanumeric): the token is full-
        // account, so an unvalidated id interpolated into the path (e.g.
        // "../../users/5") would let a caller reach arbitrary endpoints with the
        // vaulted token — this regex is the security boundary (same as getInvoice).
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
        context.logger.info("Fetching project {id}", { id: args.id });
        const json = await inFetch(
          cfg,
          "GET",
          `projects/${args.id}`,
          { query: [["include", "client"]] },
          args._fetch,
        );
        const raw = (json.data ?? {}) as Record<string, unknown>;
        const handle = await context.writeResource(
          "project",
          `project:${args.id}`,
          {
            id: args.id,
            raw,
            retrievedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    // --- Company settings read (invoiceninja-company-settings.spec sec 3/sec 5) ---
    getCompanySettings: {
      description:
        "GET /companies/{id} -> companySettings: normalized custom-field labels " +
        "(task/invoice/client/product slots 1..4) + currency_id/date_format_id. " +
        "companyId is optional - when absent it auto-resolves via GET /companies " +
        "(fails loudly on a multi-company token), is confirmed present in the " +
        "token's company list, and is charset-gated (/^[A-Za-z0-9]+$/) before " +
        "path interpolation. The returned company id is asserted against the " +
        "requested id (IN acts on the token-bound company regardless of path).",
      arguments: z.object({
        // Optional: auto-resolves via GET /companies when absent. When present,
        // constrained to the IN hashid charset - the token is full-account, so
        // an unvalidated id in the path (e.g. "../../users/5") is a host-endpoint
        // escape (same boundary as getProject).
        companyId: z.string().regex(
          /^[A-Za-z0-9]+$/,
          "IN hashid must be alphanumeric (no path separators)",
        ).optional(),
        scope: z.string().min(1).optional().describe(
          "Optional instance-name qualifier: writes the snapshot as " +
            "`companySettings--<scope>` so a pipeline's snapshot does not collide " +
            "with another workflow's bare `companySettings` one.",
        ),
      }),
      execute: async (
        args: { companyId?: string; scope?: string; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const companyId = await resolveCompanyId(
          cfg,
          args.companyId,
          args._fetch,
        );
        context.logger.info("Fetching company settings {id}", {
          id: companyId,
        });
        const json = await inFetch(
          cfg,
          "GET",
          `companies/${companyId}`,
          {},
          args._fetch,
        );
        const raw = (json.data ?? {}) as Record<string, unknown>;
        // CS-REV-1: the endpoint acts on the token-bound company regardless of
        // the path id - refuse to snapshot a company other than the one asked for.
        assertCompanyIdMatch(raw, companyId);
        const normalized = normalizeCompanySettings(raw);
        const name = args.scope
          ? `companySettings--${args.scope}`
          : "companySettings";
        const handle = await context.writeResource(
          "companySettings",
          name,
          { ...normalized, retrievedAt: new Date().toISOString() },
        );
        return { dataHandles: [handle] };
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
        syncScope: z.string().min(1).optional().describe(
          "Caller scope key (e.g. 'mercury-<accountId>' | 'ynab'). Names the " +
            "output resources expenseSync--<scope> / expenseSyncErrors--<scope> " +
            "so a multi-source run leaves one LIVE resource per source instead of " +
            "overwriting a single name (the model-scope finops-review report reads " +
            "latest-per-name, not version history). Absent → legacy bare " +
            "'expenseSync' / 'expenseSyncErrors'.",
        ),
      }),
      execute: async (
        args: {
          txns: Array<Record<string, unknown>>;
          mapping: Mapping;
          dryRun?: boolean;
          syncScope?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        const mapping = args.mapping;
        // Live pre-flight (DRP-01): a DRYRUN_SENTINEL id is only ever injected
        // by buildMapping(dryRun=true) (§7.6). If one reaches a LIVE
        // (dryRun=false) upsertExpenses, the `mapping` resource is STALE — built
        // by a prior dry-run and handed to a live run (cross-run contamination).
        // Scan the whole mapping BEFORE the fan-out makes any POST and throw
        // ATOMICALLY, so a contaminated mapping never partially writes (without
        // this, the per-txn guard in upsertExpense would trip only for
        // sentinel-bound txns — caught by the fan-out try/catch and folded into
        // expenseSyncErrors like a transient failure — while other txns from the
        // same stale mapping still POST live). The per-txn guard stays as
        // defense-in-depth. dryRun=true legitimately carries sentinels → skip.
        if (!dryRun && mappingHasSentinel(mapping)) {
          throw new Error(
            "upsertExpenses: mapping contains dry-run sentinel binds " +
              `(${DRYRUN_SENTINEL}) — it was built by buildMapping(dryRun=true); ` +
              "rebuild the mapping with dryRun=false before writing live.",
          );
        }
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
              // §7.6 dry-run mapping projection — preview-only, ADDITIVE row
              // metadata; NEVER fed into mapTxnToExpense/the IN POST body.
              // `r.vendorId`/`r.categoryId` are undefined on every skip path
              // (no body was built), so both stay null there.
              const projectedVendor = r.vendorId === DRYRUN_SENTINEL
                ? (ownLookupKeyNorm(
                  mapping.vendors,
                  strOrNull(txn.counterparty),
                ) ??
                  strOrNull(txn.counterparty))
                : null;
              const projectedCategory = r.categoryId === DRYRUN_SENTINEL
                ? (ownLookupKeyNorm(
                  mapping.vendorCategories,
                  strOrNull(txn.counterparty),
                ) ??
                  ownLookupKeyNorm(
                    mapping.categories,
                    strOrNull(txn.rawCategory),
                  ) ??
                  ownLookupKeyNorm(
                    mapping.categories,
                    strOrNull(txn.counterparty),
                  ) ??
                  strOrNull(txn.rawCategory) ??
                  strOrNull(txn.counterparty))
                : null;
              rows.push({
                dedupKey: strOrNull(txn.id) ?? "",
                action: r.action,
                expenseId: r.expenseId,
                amount: numOrNull(txn.amount),
                date: strOrNull(txn.postedDate),
                unmatchedVendor: r.unmatchedVendor,
                projectedVendor,
                projectedCategory,
                // finops-daily-review (additive, projection-only) — carry the
                // source txn's name + origin so the finops-review report needs
                // no cross-model join. Same `txn` already read above.
                counterparty: strOrNull(txn.counterparty),
                source: strOrNull(txn.source),
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
          // Per-scope resource NAMES (finops-daily-review V1.1). Each fan-out
          // child passes a distinct `syncScope` so its write lands on its own
          // resource NAME instead of overwriting one shared `expenseSync` — the
          // model-scope finops-review report enumerates latest-per-name (it has
          // no version-history API), so a shared name would collapse a multi-
          // source run to the last writer. writeResource's SPEC (first arg) stays
          // "expenseSync"/"expenseSyncErrors"; only the instance NAME varies. The
          // payload `scope` self-describes the scope key. Absent syncScope keeps
          // the legacy bare names AND each resource's own legacy `scope` literal
          // (back-compat: the errors resource keeps `expenseSyncErrors`, not the
          // sync resource's default — they defaulted independently pre-fix). The
          // schema's .min(1) rejects an empty syncScope, so a blank never silently
          // downgrades to the shared bare name.
          const syncName = args.syncScope
            ? `expenseSync--${args.syncScope}`
            : "expenseSync";
          const errName = args.syncScope
            ? `expenseSyncErrors--${args.syncScope}`
            : "expenseSyncErrors";
          syncHandle = await context.writeResource(
            "expenseSync",
            syncName,
            {
              scope: args.syncScope ?? "expenseSync",
              rows,
              dryRun,
              retrievedAt: now(),
            },
          );
          errHandle = await context.writeResource(
            "expenseSyncErrors",
            errName,
            {
              scope: args.syncScope ?? "expenseSyncErrors",
              rows: errors,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    // --- Invoice-write path (design/invoiceninja-invoice-write.md) ---
    // Fan-out; single-writer; dedup on `number`; dryRun default; NEVER sends.
    upsertInvoices: {
      description:
        "Check-then-create invoices for an InvoiceInput[] (dedup on `number`). " +
        "Single-writer fan-out; dryRun default true; draft-only — NEVER emails/" +
        "sends an invoice to a client. → invoiceSync (+ invoiceSyncErrors for " +
        "failed/rejected attempts).",
      arguments: z.object({
        invoices: z.array(z.record(z.string(), z.unknown())).describe(
          "InvoiceInput[]: {number (dedup key), clientId, lineItems:[{type:" +
            "'product'|'service', notes, cost, quantity?, productKey?}], date?, " +
            "dueDate?, poNumber?, publicNotes?, privateNotes?, status?:'draft'|" +
            "'sent', currencyId?} (design/invoiceninja-invoice-write.md).",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true).",
        ),
        syncScope: z.string().min(1).optional().describe(
          "Caller scope key; names invoiceSync--<scope> / " +
            "invoiceSyncErrors--<scope> (absent → bare names). Mirrors " +
            "upsertExpenses so a multi-source run keeps one resource per source.",
        ),
      }),
      execute: async (
        args: {
          invoices: Array<Record<string, unknown>>;
          dryRun?: boolean;
          syncScope?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        // Single-writer: iterate SEQUENTIALLY (the check-then-create TOCTOU
        // window is closed only by single-writer discipline + the per-model
        // lock — repo rule 6). No atomic upsert exists in IN.
        const seen = new Set<string>();
        const rows: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];
        const now = () => new Date().toISOString();
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        try {
          for (const inv of args.invoices) {
            const number = strOrNull(inv.number);
            try {
              const r = await upsertInvoice(
                cfg,
                inv,
                dryRun,
                args._fetch,
                seen,
                context.logger,
              );
              rows.push({
                dedupKey: number ?? "",
                action: r.action,
                reason: r.reason ?? null,
                invoiceId: r.invoiceId,
                clientId: strOrNull(inv.clientId),
                total: computeInvoiceTotal(inv),
                status: strOrNull(inv.status) ?? "draft",
                date: strOrNull(inv.date),
              });
              // A blank OR invalid input is a skip AND a surfaced error, so the
              // rejection is queryable (not just a low-signal skip row).
              if (r.reason === "blank-dedup-key" || r.reason === "invalid") {
                errors.push({
                  dedupKey: number ?? "",
                  clientId: strOrNull(inv.clientId),
                  error: r.reason,
                  attemptedAt: now(),
                  dryRun,
                });
              }
            } catch (e) {
              // A single failure MUST NOT abort the batch.
              context.logger.warning("upsertInvoice failed for {number}", {
                number,
              });
              errors.push({
                dedupKey: number ?? "",
                clientId: strOrNull(inv.clientId),
                error: e instanceof Error ? e.message : String(e),
                attemptedAt: now(),
                dryRun,
              });
            }
          }
        } finally {
          // Flush BOTH, even on an unexpected throw, so every real create keeps
          // its audit row and every failure keeps a durable, queryable row.
          // invoiceSyncErrors is flushed ALWAYS (even empty) so a consumer can
          // tell "0 errors this run" from "never ran". Per-scope resource NAMES
          // mirror upsertExpenses (the WRITE spec stays constant; only the
          // instance NAME varies) so a multi-source run doesn't collapse to the
          // last writer.
          const syncName = args.syncScope
            ? `invoiceSync--${args.syncScope}`
            : "invoiceSync";
          const errName = args.syncScope
            ? `invoiceSyncErrors--${args.syncScope}`
            : "invoiceSyncErrors";
          syncHandle = await context.writeResource(
            "invoiceSync",
            syncName,
            {
              scope: args.syncScope ?? "invoiceSync",
              rows,
              dryRun,
              retrievedAt: now(),
            },
          );
          errHandle = await context.writeResource(
            "invoiceSyncErrors",
            errName,
            {
              scope: args.syncScope ?? "invoiceSyncErrors",
              rows: errors,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    // --- Payments apply (payment-apply path) — fan-out; single-writer; dryRun
    // default. Recognizes received payments against existing invoices; the ONLY
    // correct way to mark an invoice Paid. ---
    applyPayments: {
      description:
        "Recognize received payments against existing invoices for a " +
        "PaymentInput[] (dedup on `transaction_reference`) — the ONLY correct " +
        "way to mark an invoice Paid (NEVER writes status_id:4). Single-writer " +
        "fan-out; dryRun default true; NEVER emails/notifies. → paymentSync (+ " +
        "paymentSyncErrors for failed/rejected attempts).",
      arguments: z.object({
        payments: z.array(z.record(z.string(), z.unknown())).describe(
          "PaymentInput[]: {clientId (hashid), date:'YYYY-MM-DD', " +
            "transactionReference (dedup key), typeId?, privateNotes?, " +
            "applications:[{invoiceId? | invoiceNumber?, amount>0}]} " +
            "(design/specs/invoiceninja-payment-apply.spec.md).",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true).",
        ),
        syncScope: z.string().min(1).optional().describe(
          "Caller scope key; names paymentSync--<scope> / " +
            "paymentSyncErrors--<scope> (absent → bare names). Mirrors " +
            "upsertInvoices so a multi-source run keeps one resource per source.",
        ),
      }),
      execute: async (
        args: {
          payments: Array<Record<string, unknown>>;
          dryRun?: boolean;
          syncScope?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        // Single-writer: iterate SEQUENTIALLY (the check-then-create TOCTOU
        // window is closed only by single-writer discipline + the per-model
        // lock — repo rule 6). No atomic upsert exists in IN.
        const seen = new Set<string>();
        const rows: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];
        const now = () => new Date().toISOString();
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        try {
          // Prefetch the invoice index ONCE (trash-exclusive number->{id,balance})
          // so N payments do not each re-scan the invoice list (PRJ-1 idiom).
          // INSIDE the try (PAY-REV-3): a prefetch failure must still flush BOTH
          // audits via the finally — a durable prefetch-failure error row, never
          // an ambiguous "0 errors vs never ran". No money is written on failure;
          // the throw is re-raised so the run fails loudly.
          let invoiceIndex: InvoiceIndex;
          try {
            invoiceIndex = await buildInvoiceIndex(
              cfg,
              args._fetch,
              context.logger,
            );
          } catch (e) {
            errors.push({
              dedupKey: "",
              amount: null,
              error: `invoice-prefetch-failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
              attemptedAt: now(),
              dryRun,
            });
            throw e;
          }
          for (const pay of args.payments) {
            const ref = strOrNull(pay.transactionReference);
            const amount = paymentTotal(pay);
            try {
              const r = await applyPayment(
                cfg,
                pay,
                dryRun,
                args._fetch,
                seen,
                invoiceIndex,
                context.logger,
              );
              rows.push({
                dedupKey: ref ?? "",
                action: r.action,
                reason: r.reason ?? null,
                paymentId: r.paymentId,
                clientId: strOrNull(pay.clientId),
                amount,
                date: strOrNull(pay.date),
                appliedInvoiceIds: r.appliedInvoiceIds,
              });
              // A fail-closed rejection is a skip AND a surfaced error, so the
              // rejection is queryable (not just a low-signal skip row). Benign
              // skips (already-exists/already-paid/in-batch-duplicate) do NOT
              // become errors.
              if (
                r.reason === "blank-dedup-key" || r.reason === "invalid" ||
                r.reason === "invoice-unresolved" ||
                r.reason === "over-apply" ||
                r.reason === "invoice-client-mismatch" ||
                r.reason === "invoice-client-unverified"
              ) {
                errors.push({
                  dedupKey: ref ?? "",
                  amount,
                  error: r.reason,
                  attemptedAt: now(),
                  dryRun,
                });
              }
            } catch (e) {
              // A single failure MUST NOT abort the batch.
              context.logger.warning("applyPayment failed for {ref}", { ref });
              errors.push({
                dedupKey: ref ?? "",
                amount,
                error: e instanceof Error ? e.message : String(e),
                attemptedAt: now(),
                dryRun,
              });
            }
          }
        } finally {
          // Flush BOTH, even on an unexpected throw, so every real create keeps
          // its audit row and every failure keeps a durable, queryable row.
          // paymentSyncErrors is flushed ALWAYS (even empty) so a consumer can
          // tell "0 errors this run" from "never ran". Per-scope resource NAMES
          // mirror upsertInvoices (the WRITE spec stays constant; only the
          // instance NAME varies) so a multi-source run doesn't collapse to the
          // last writer.
          const syncName = args.syncScope
            ? `paymentSync--${args.syncScope}`
            : "paymentSync";
          const errName = args.syncScope
            ? `paymentSyncErrors--${args.syncScope}`
            : "paymentSyncErrors";
          syncHandle = await context.writeResource(
            "paymentSync",
            syncName,
            {
              scope: args.syncScope ?? "paymentSync",
              rows,
              dryRun,
              retrievedAt: now(),
            },
          );
          errHandle = await context.writeResource(
            "paymentSyncErrors",
            errName,
            {
              scope: args.syncScope ?? "paymentSyncErrors",
              rows: errors,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    // --- Mark-sent (design/specs/invoiceninja-mark-sent.spec.md) — fan-out;
    //     single-writer; dryRun default; status-only, NEVER emails. ---
    markSent: {
      description:
        "Transition Draft invoices (status_id 1) to Sent (status_id 2) via IN's " +
        "bulk `mark_sent` action so each gains a balance and applyPayments can " +
        "then recognize it Paid. Prefetch the invoice index ONCE (trash-" +
        "exclusive number->{id,statusId}); resolve each target by invoiceId OR " +
        "invoiceNumber (unresolved/ambiguous -> skip unresolved); classify " +
        "(Draft -> eligible, Sent/Partial -> already-sent, Paid -> already-paid, " +
        "else -> not-draft). Single-writer fan-out: ONE POST /invoices/bulk for " +
        "all eligible ids, then a read-back confirms status_id 2 before emitting " +
        "`sent` rows. dryRun default true -> `would-send`, NO POST. STATUS-ONLY: " +
        "NEVER sets any email/notify field (that is the separate email_invoice " +
        "action). -> markSentSync (+ markSentSyncErrors for unresolved/failed/" +
        "unconfirmed transitions).",
      arguments: z.object({
        invoices: z.array(z.record(z.string(), z.unknown())).describe(
          "Targets: [{invoiceId? | invoiceNumber?}] — each resolves to ONE live " +
            "invoice hashid via the prefetched index " +
            "(design/specs/invoiceninja-mark-sent.spec.md).",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true) -> preview only.",
        ),
        syncScope: z.string().min(1).optional().describe(
          "Caller scope key; names markSentSync--<scope> / " +
            "markSentSyncErrors--<scope> (absent -> bare names). Mirrors " +
            "applyPayments so a multi-source run keeps one resource per source.",
        ),
      }),
      execute: async (
        args: {
          invoices: Array<Record<string, unknown>>;
          dryRun?: boolean;
          syncScope?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        const rows: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];
        const now = () => new Date().toISOString();
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        try {
          // Prefetch the invoice index ONCE (trash-exclusive number->{id,statusId})
          // so N targets do not each re-scan the invoice list (PRJ-1 idiom). INSIDE
          // the try: a prefetch failure must still flush BOTH audits via the finally
          // — a durable prefetch-failure error row, never an ambiguous "0 errors vs
          // never ran". No status is written on failure; the throw is re-raised so
          // the run fails loudly.
          let index: MarkSentIndex;
          try {
            index = await buildMarkSentIndex(cfg, args._fetch, context.logger);
          } catch (e) {
            errors.push({
              dedupKey: "",
              error: `invoice-prefetch-failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
              attemptedAt: now(),
              dryRun,
            });
            throw e;
          }
          // Resolve + classify each target. An unresolved/ambiguous target is a
          // skip AND a surfaced error (queryable), and never aborts the batch.
          const eligible: Array<{ dedupKey: string; id: string }> = [];
          for (const t of args.invoices) {
            const dedupKey = strOrNull(t.invoiceNumber) ??
              strOrNull(t.invoiceId) ?? "";
            const entry = resolveMarkSentTarget(index, t);
            if (entry === null) {
              rows.push({
                dedupKey,
                action: "skip",
                reason: "unresolved",
                invoiceId: null,
                statusId: null,
              });
              errors.push({
                dedupKey,
                error: "unresolved",
                attemptedAt: now(),
                dryRun,
              });
              continue;
            }
            const st = entry.statusId;
            if (st === 1) {
              // Draft -> eligible. dryRun emits the would-send row now; a live run
              // defers the row until the read-back confirms status_id 2.
              eligible.push({ dedupKey, id: entry.id });
              if (dryRun) {
                rows.push({
                  dedupKey,
                  action: "would-send",
                  reason: null,
                  invoiceId: entry.id,
                  statusId: 1,
                });
              }
            } else if (st === 2 || st === 3) {
              rows.push({
                dedupKey,
                action: "skip",
                reason: "already-sent",
                invoiceId: entry.id,
                statusId: st,
              });
            } else if (st === 4) {
              rows.push({
                dedupKey,
                action: "skip",
                reason: "already-paid",
                invoiceId: entry.id,
                statusId: st,
              });
            } else {
              rows.push({
                dedupKey,
                action: "skip",
                reason: "not-draft",
                invoiceId: entry.id,
                statusId: st,
              });
            }
          }
          // Live write: ONE bulk POST for all eligible ids (fan-out, rule 6), then
          // a read-back confirms each moved to status_id 2 before emitting a `sent`
          // row. STATUS-ONLY — mapMarkSentBody carries NO email/notify field. A
          // bulk failure is caught (batch not aborted): every eligible id keeps a
          // durable error row and no unconfirmed `sent` is emitted.
          if (!dryRun && eligible.length > 0) {
            const ids = eligible.map((e) => e.id);
            try {
              await inFetch(
                cfg,
                "POST",
                "invoices/bulk",
                { body: mapMarkSentBody(ids) },
                args._fetch,
              );
              const after = await buildMarkSentIndex(
                cfg,
                args._fetch,
                context.logger,
              );
              const statusById = new Map<string, number | null>();
              for (const v of after.values()) {
                if (v !== "ambiguous") statusById.set(v.id, v.statusId);
              }
              for (const e of eligible) {
                const st = statusById.has(e.id) ? statusById.get(e.id)! : null;
                if (st === 2) {
                  rows.push({
                    dedupKey: e.dedupKey,
                    action: "sent",
                    reason: null,
                    invoiceId: e.id,
                    statusId: 2,
                  });
                } else {
                  // The bulk POST returned OK but the read-back did not confirm
                  // Sent — surface it (never claim a `sent` we can't confirm).
                  rows.push({
                    dedupKey: e.dedupKey,
                    action: "skip",
                    reason: "send-unconfirmed",
                    invoiceId: e.id,
                    statusId: st,
                  });
                  errors.push({
                    dedupKey: e.dedupKey,
                    error: `send-unconfirmed: status_id=${st}`,
                    attemptedAt: now(),
                    dryRun,
                  });
                }
              }
            } catch (err) {
              // A bulk failure MUST NOT abort the batch flush — every eligible id
              // keeps a durable, queryable error row.
              context.logger.warning(
                "markSent bulk POST failed for {n} invoice(s)",
                { n: eligible.length },
              );
              const msg = err instanceof Error ? err.message : String(err);
              for (const e of eligible) {
                errors.push({
                  dedupKey: e.dedupKey,
                  error: msg,
                  attemptedAt: now(),
                  dryRun,
                });
              }
            }
          }
        } finally {
          // Flush BOTH, even on an unexpected throw, so every real write keeps its
          // audit row and every failure keeps a durable, queryable row.
          // markSentSyncErrors is flushed ALWAYS (even empty) so a consumer can
          // tell "0 errors this run" from "never ran". Per-scope resource NAMES
          // mirror applyPayments (the WRITE spec stays constant; only the instance
          // NAME varies) so a multi-source run doesn't collapse to the last writer.
          const syncName = args.syncScope
            ? `markSentSync--${args.syncScope}`
            : "markSentSync";
          const errName = args.syncScope
            ? `markSentSyncErrors--${args.syncScope}`
            : "markSentSyncErrors";
          syncHandle = await context.writeResource(
            "markSentSync",
            syncName,
            {
              scope: args.syncScope ?? "markSentSync",
              rows,
              dryRun,
              retrievedAt: now(),
            },
          );
          errHandle = await context.writeResource(
            "markSentSyncErrors",
            errName,
            {
              scope: args.syncScope ?? "markSentSyncErrors",
              rows: errors,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    // --- Invoice-from-tasks (design/specs/invoiceninja-invoice-tasks.spec.md) —
    // v1 creates ONE draft invoice per call from a set of tasks (one task-linked
    // service line each), the way IN's UI does. Keeps the fan-out shape (single
    // input looped once) + finally-flushes both audits. Single-writer; dryRun
    // default true; draft-only — NEVER emails/sends. ---
    invoiceTasks: {
      description:
        "Create ONE draft invoice from a set of IN tasks the way IN's UI does: " +
        "fetch each task, build a task-linked service line (precise 3-dp hours x " +
        "rate, task-time-details notes, task_id, unit_code C62), dedup on " +
        "`number`, POST /invoices, and read back each task's invoice_id linkage. " +
        "Per-task classify (wrong-client/not-found/already-invoiced/task-running/" +
        "zero-hours -> skip); no eligible tasks -> invoice skip, NO POST. dryRun " +
        "default true -> would-create with computed lines + total, NO POST. " +
        "Draft-only: NEVER emails/sends and NEVER sets amount/balance. -> " +
        "invoiceTasksSync (+ invoiceTasksSyncErrors for rejected/failed tasks).",
      arguments: z.object({
        number: z.string().describe(
          "Stable dedup key (the next sequential IN invoice number, e.g. 0073); " +
            "blank-guarded.",
        ),
        clientId: z.string().describe("IN client hashid; charset-validated."),
        taskIds: z.array(z.string()).describe(
          ">=1 IN task hashids to invoice (explicit — nothing over-included by a " +
            "date-range guess). Each charset-validated before path interpolation.",
        ),
        date: z.string().optional(),
        dueDate: z.string().optional(),
        poNumber: z.string().optional(),
        publicNotes: z.string().optional(),
        privateNotes: z.string().optional(),
        currencyId: z.string().optional(),
        status: z.enum(["draft", "sent"]).optional().describe(
          "Default 'draft'. 'sent' -> status_id 2 but NEVER emails either way.",
        ),
        rateOverride: z.number().optional().describe(
          "Optional flat rate for every line; else each task's own rate.",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true) -> preview only.",
        ),
        syncScope: z.string().min(1).optional().describe(
          "Caller scope key; names invoiceTasksSync--<scope> / " +
            "invoiceTasksSyncErrors--<scope> (absent -> bare names). Mirrors " +
            "upsertInvoices.",
        ),
      }),
      execute: async (
        args: {
          number: string;
          clientId: string;
          taskIds: string[];
          date?: string;
          dueDate?: string;
          poNumber?: string;
          publicNotes?: string;
          privateNotes?: string;
          currencyId?: string;
          status?: "draft" | "sent";
          rateOverride?: number;
          dryRun?: boolean;
          syncScope?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        // v1 invoices ONE client/one invoice per call, but keep the fan-out shape
        // for symmetry: loop a 1-element list SEQUENTIALLY (single-writer) and
        // FLUSH BOTH audits in a finally, exactly like upsertInvoices.
        const inputs = [args];
        const rows: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];
        const now = () => new Date().toISOString();
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        try {
          for (const input of inputs) {
            const number = strOrNull(input.number) ?? "";
            try {
              const r = await invoiceTasksForOne(
                cfg,
                input as unknown as Record<string, unknown>,
                dryRun,
                args._fetch,
                context.logger,
              );
              rows.push({
                number,
                action: r.action,
                reason: r.reason ?? null,
                invoiceId: r.invoiceId,
                clientId: strOrNull(input.clientId),
                total: r.total,
                status: strOrNull(input.status) ?? "draft",
                date: strOrNull(input.date),
                taskRows: r.taskRows,
              });
              // A blank OR invalid input is a skip AND a surfaced error, so the
              // rejection is queryable (not just a low-signal skip row).
              if (r.reason === "blank-dedup-key" || r.reason === "invalid") {
                errors.push({
                  number,
                  taskId: null,
                  error: r.reason,
                  attemptedAt: now(),
                  dryRun,
                });
              }
              // Per-task / linkage errors (wrong-client, not-found, task-running,
              // linkage-unconfirmed, linkage-readback-failed).
              for (const te of r.errors) {
                errors.push({
                  number,
                  taskId: te.taskId ?? null,
                  error: te.error,
                  attemptedAt: now(),
                  dryRun,
                });
              }
            } catch (e) {
              // A single failure MUST NOT abort the run (fan-out symmetry).
              context.logger.warning("invoiceTasks failed for {number}", {
                number,
              });
              errors.push({
                number,
                taskId: null,
                error: e instanceof Error ? e.message : String(e),
                attemptedAt: now(),
                dryRun,
              });
            }
          }
        } finally {
          // Flush BOTH, even on an unexpected throw, so every real create keeps
          // its audit row and every failure keeps a durable, queryable row.
          // invoiceTasksSyncErrors is flushed ALWAYS (even empty) so a consumer
          // can tell "0 errors this run" from "never ran".
          const syncName = args.syncScope
            ? `invoiceTasksSync--${args.syncScope}`
            : "invoiceTasksSync";
          const errName = args.syncScope
            ? `invoiceTasksSyncErrors--${args.syncScope}`
            : "invoiceTasksSyncErrors";
          syncHandle = await context.writeResource(
            "invoiceTasksSync",
            syncName,
            {
              scope: args.syncScope ?? "invoiceTasksSync",
              rows,
              dryRun,
              retrievedAt: now(),
            },
          );
          errHandle = await context.writeResource(
            "invoiceTasksSyncErrors",
            errName,
            {
              scope: args.syncScope ?? "invoiceTasksSyncErrors",
              rows: errors,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    // --- Clients write (§1) — fan-out; single-writer; dryRun default. ---
    upsertClients: {
      description:
        "Check-then-create clients for a ClientInput[] (dedup on `number`). " +
        "Single-writer fan-out; dryRun default true; never sets balances (IN " +
        "derives them). → clientSync (+ clientSyncErrors for failed/rejected " +
        "attempts).",
      arguments: z.object({
        clients: z.array(z.record(z.string(), z.unknown())).describe(
          "ClientInput[]: {number (dedup key), name, idNumber?, contacts:[{" +
            "firstName?, lastName?, email?}]?, publicNotes?, privateNotes?} " +
            "(design/invoiceninja-entity-crud.md §1).",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true).",
        ),
        syncScope: z.string().min(1).optional().describe(
          "Caller scope key; names clientSync--<scope> / " +
            "clientSyncErrors--<scope> (absent → bare names). Mirrors " +
            "upsertInvoices so a multi-source run keeps one resource per source.",
        ),
      }),
      execute: async (
        args: {
          clients: Array<Record<string, unknown>>;
          dryRun?: boolean;
          syncScope?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        // Single-writer: iterate SEQUENTIALLY (the check-then-create TOCTOU
        // window is closed only by single-writer discipline + the per-model
        // lock — repo rule 6). No atomic upsert exists in IN.
        const seen = new Set<string>();
        const rows: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];
        const now = () => new Date().toISOString();
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        try {
          for (const client of args.clients) {
            const number = strOrNull(client.number);
            try {
              const r = await upsertClient(
                cfg,
                client,
                dryRun,
                args._fetch,
                seen,
                context.logger,
              );
              // PII-free audit row: number (dedup key) + resolved id only —
              // never the client name/contacts (see ClientSyncSchema).
              rows.push({
                dedupKey: number ?? "",
                action: r.action,
                reason: r.reason ?? null,
                clientId: r.clientId,
              });
              // A blank OR invalid input is a skip AND a surfaced error, so the
              // rejection is queryable (not just a low-signal skip row).
              if (r.reason === "blank-dedup-key" || r.reason === "invalid") {
                errors.push({
                  dedupKey: number ?? "",
                  error: r.reason,
                  attemptedAt: now(),
                  dryRun,
                });
              }
            } catch (e) {
              // A single failure MUST NOT abort the batch.
              context.logger.warning("upsertClient failed for {number}", {
                number,
              });
              errors.push({
                dedupKey: number ?? "",
                error: e instanceof Error ? e.message : String(e),
                attemptedAt: now(),
                dryRun,
              });
            }
          }
        } finally {
          // Flush BOTH, even on an unexpected throw, so every real create keeps
          // its audit row and every failure keeps a durable, queryable row.
          // clientSyncErrors is flushed ALWAYS (even empty) so a consumer can
          // tell "0 errors this run" from "never ran". Per-scope resource NAMES
          // mirror upsertInvoices (the WRITE spec stays constant; only the
          // instance NAME varies) so a multi-source run doesn't collapse to the
          // last writer.
          const syncName = args.syncScope
            ? `clientSync--${args.syncScope}`
            : "clientSync";
          const errName = args.syncScope
            ? `clientSyncErrors--${args.syncScope}`
            : "clientSyncErrors";
          syncHandle = await context.writeResource(
            "clientSync",
            syncName,
            {
              scope: args.syncScope ?? "clientSync",
              rows,
              dryRun,
              retrievedAt: now(),
            },
          );
          errHandle = await context.writeResource(
            "clientSyncErrors",
            errName,
            {
              scope: args.syncScope ?? "clientSyncErrors",
              rows: errors,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    // --- Projects-write path (design/invoiceninja-entity-crud.md §2) ---
    // Fan-out; single-writer; dedup on `number`; dryRun default true.
    upsertProjects: {
      description:
        "Check-then-create projects for a ProjectInput[] (dedup on `number`). " +
        "Single-writer fan-out; dryRun default true. → projectSync (+ " +
        "projectSyncErrors for failed/rejected attempts).",
      arguments: z.object({
        projects: z.array(z.record(z.string(), z.unknown())).describe(
          "ProjectInput[]: {number (dedup key), name, clientId, taskRate?, " +
            "budgetedHours?, dueDate?, publicNotes?, privateNotes?} " +
            "(design/invoiceninja-entity-crud.md §2).",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true).",
        ),
        syncScope: z.string().min(1).optional().describe(
          "Caller scope key; names projectSync--<scope> / " +
            "projectSyncErrors--<scope> (absent → bare names). Mirrors " +
            "upsertInvoices so a multi-source run keeps one resource per source.",
        ),
      }),
      execute: async (
        args: {
          projects: Array<Record<string, unknown>>;
          dryRun?: boolean;
          syncScope?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        // Single-writer: iterate SEQUENTIALLY (the check-then-create TOCTOU
        // window is closed only by single-writer discipline + the per-model
        // lock — repo rule 6). No atomic upsert exists in IN.
        const seen = new Set<string>();
        const rows: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];
        const now = () => new Date().toISOString();
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        // PRJ-1: share ONE trash-inclusive project-list scan across the whole
        // batch. IN's `/projects?filter=` can't dedup by number, so each
        // upsertProject would otherwise re-scan the entire /projects table —
        // N×(full paginated fetch) + a longer per-model-lock hold. The cache is
        // filled lazily by the first project that reaches the dedup step and reused
        // by the rest (so an all-invalid batch, which never reaches that step, still
        // issues zero GETs).
        const projectCache: { rows: Array<Record<string, unknown>> | null } = {
          rows: null,
        };
        try {
          for (const proj of args.projects) {
            const number = strOrNull(proj.number);
            try {
              const r = await upsertProject(
                cfg,
                proj,
                dryRun,
                args._fetch,
                seen,
                context.logger,
                projectCache,
              );
              rows.push({
                dedupKey: number ?? "",
                action: r.action,
                reason: r.reason ?? null,
                projectId: r.projectId,
                clientId: strOrNull(proj.clientId),
                name: strOrNull(proj.name),
              });
              // A blank OR invalid input is a skip AND a surfaced error, so the
              // rejection is queryable (not just a low-signal skip row).
              if (r.reason === "blank-dedup-key" || r.reason === "invalid") {
                errors.push({
                  dedupKey: number ?? "",
                  clientId: strOrNull(proj.clientId),
                  error: r.reason,
                  attemptedAt: now(),
                  dryRun,
                });
              }
            } catch (e) {
              // A single failure MUST NOT abort the batch.
              context.logger.warning("upsertProject failed for {number}", {
                number,
              });
              errors.push({
                dedupKey: number ?? "",
                clientId: strOrNull(proj.clientId),
                error: e instanceof Error ? e.message : String(e),
                attemptedAt: now(),
                dryRun,
              });
            }
          }
        } finally {
          // Flush BOTH, even on an unexpected throw, so every real create keeps
          // its audit row and every failure keeps a durable, queryable row.
          // projectSyncErrors is flushed ALWAYS (even empty). Per-scope resource
          // NAMES mirror upsertInvoices (the WRITE spec stays constant; only the
          // instance NAME varies) so a multi-source run doesn't collapse to the
          // last writer.
          const syncName = args.syncScope
            ? `projectSync--${args.syncScope}`
            : "projectSync";
          const errName = args.syncScope
            ? `projectSyncErrors--${args.syncScope}`
            : "projectSyncErrors";
          syncHandle = await context.writeResource(
            "projectSync",
            syncName,
            {
              scope: args.syncScope ?? "projectSync",
              rows,
              dryRun,
              retrievedAt: now(),
            },
          );
          errHandle = await context.writeResource(
            "projectSyncErrors",
            errName,
            {
              scope: args.syncScope ?? "projectSyncErrors",
              rows: errors,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    // --- Company settings reconcile (invoiceninja-company-settings.spec sec 3/sec 5) --
    reconcileCompanySettings: {
      description:
        "Declarative, dry-by-default reconcile of company settings. Diffs a " +
        "desired set (custom-field labels + currency/date-format ids) vs the " +
        "LIVE company per-field; only fields the caller marks are ever touched. " +
        "Strict relabel-only: an empty live custom-field slot is never populated " +
        "(recorded as a skipped row). dryRun (default cfg.dryRun=true) -> " +
        "would-update rows, NO write. dryRun=false -> round-trips the FULL live " +
        "settings/custom_fields objects (mutating ONLY changed keys) back via " +
        "PUT /companies/{id}; top-level company columns are omitted (IN MERGES " +
        "top-level via Laravel fill()), while settings/custom_fields are sent " +
        "whole (IN REPLACES those JSON columns). -> companySettingsSync (+ " +
        "companySettingsSyncErrors, flushed even empty).",
      arguments: z.object({
        desired: z.object({
          customFields: z.object({
            task: z.array(z.string().nullable()).optional(),
            invoice: z.array(z.string().nullable()).optional(),
            client: z.array(z.string().nullable()).optional(),
            product: z.array(z.string().nullable()).optional(),
          }).optional().describe(
            "Desired custom-field LABELS per family (index 0 = slot 1). A null " +
              "array element leaves that slot unmanaged; an absent family is " +
              "unmanaged entirely.",
          ),
          currencyId: z.string().optional(),
          dateFormatId: z.string().optional(),
        }).default({}).describe(
          "Desired company settings. Only keys PRESENT are reconciled; an absent " +
            "key is unmanaged and never diffed or written.",
        ),
        companyId: z.string().regex(
          /^[A-Za-z0-9]+$/,
          "IN hashid must be alphanumeric (no path separators)",
        ).optional().describe(
          "Optional; auto-resolves via GET /companies when absent. Charset-gated.",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true).",
        ),
        syncScope: z.string().min(1).optional().describe(
          "Caller scope key; names companySettingsSync--<scope> / " +
            "companySettingsSyncErrors--<scope> (absent -> bare names).",
        ),
      }),
      execute: async (
        args: {
          desired?: {
            customFields?: {
              task?: Array<string | null>;
              invoice?: Array<string | null>;
              client?: Array<string | null>;
              product?: Array<string | null>;
            };
            currencyId?: string;
            dateFormatId?: string;
          };
          companyId?: string;
          dryRun?: boolean;
          syncScope?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        const desired = args.desired ?? {};
        const now = () => new Date().toISOString();
        // Diff rows carry the pure `changed`; `action` is resolved at flush time
        // from whether a PUT actually committed (`applied`).
        const diffs: Array<
          {
            path: string;
            current: string | null;
            desired: string;
            changed: boolean;
            skipReason?: string;
          }
        > = [];
        const errors: Array<
          { error: string; attemptedAt: string; dryRun: boolean }
        > = [];
        let applied = false;
        let companyId: string | null = null;
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        try {
          companyId = await resolveCompanyId(cfg, args.companyId, args._fetch);
          // Single GET (single-writer + per-model lock closes the check-then-
          // write TOCTOU, repo rule 6).
          const json = await inFetch(
            cfg,
            "GET",
            `companies/${companyId}`,
            {},
            args._fetch,
          );
          const raw = (json.data ?? {}) as Record<string, unknown>;
          // CS-REV-1: the endpoint acts on the token-bound company regardless of
          // the path id. Assert the returned id is the one we targeted (throw on
          // mismatch) and record the ACTUAL id as the audit ground truth.
          companyId = assertCompanyIdMatch(raw, companyId);
          const live = normalizeCompanySettings(raw);
          // Round-trip the FULL live objects; mutate ONLY changed target keys.
          // IN is expected to REPLACE settings/custom_fields wholesale (not deep-
          // merge), so a partial body would silently wipe unmanaged keys -
          // analogous to the timer time_log round-trip (TMR-SEC-2).
          const nextSettings: Record<string, unknown> = {
            ...((raw.settings ?? {}) as Record<string, unknown>),
          };
          const nextCustom: Record<string, unknown> = {
            ...((raw.custom_fields ?? {}) as Record<string, unknown>),
          };
          let anyChanged = false;

          // Custom-field label diffs (type preserved from the live slot).
          if (desired.customFields) {
            for (const fam of CUSTOM_FIELD_FAMILIES) {
              const arr = desired.customFields[fam];
              if (!arr) continue; // absent family = unmanaged
              for (let i = 0; i < arr.length && i < 4; i++) {
                const want = arr[i];
                if (want === null || want === undefined) continue; // slot unmanaged
                // CS-REV-5: IN encodes each slot as `Label` or `Label|type`, so a
                // literal "|" in a desired label would corrupt the encoding (the
                // tail would be parsed as a field type). Reject loudly.
                if (want.includes("|")) {
                  throw new Error(
                    `reconcileCompanySettings: desired ${fam} slot ${i + 1} ` +
                      `label ${JSON.stringify(want)} contains "|", which IN ` +
                      `reserves as the label|type delimiter - refusing to write ` +
                      `a corrupted custom-field.`,
                  );
                }
                const slot = live.customFields[fam][i];
                const path = `custom_fields.${fam}${i + 1}`;
                // CS-REV-6: strict relabel-only. An empty live slot means the
                // field is disabled in IN; writing a label there would CREATE a
                // field (out of scope). Skip it and record why - never populate.
                if (slot.label === null || slot.label === "") {
                  diffs.push({
                    path,
                    current: slot.label,
                    desired: want,
                    changed: false,
                    skipReason: "slot empty; relabel-only scope (CS-REV-6)",
                  });
                  continue;
                }
                const changed = slot.label !== want;
                diffs.push({
                  path,
                  current: slot.label,
                  desired: want,
                  changed,
                });
                if (changed) {
                  anyChanged = true;
                  nextCustom[`${fam}${i + 1}`] = encodeCustomField(
                    want,
                    slot.type,
                  );
                }
              }
            }
          }

          // Scalar settings diffs.
          const scalarDiff = (
            settingsKey: string,
            path: string,
            want: string | undefined,
            current: string | null,
          ) => {
            if (want === undefined) return; // absent key = unmanaged
            const changed = current !== want;
            diffs.push({ path, current, desired: want, changed });
            if (changed) {
              anyChanged = true;
              nextSettings[settingsKey] = want;
            }
          };
          scalarDiff(
            "currency_id",
            "settings.currency_id",
            desired.currencyId,
            live.currencyId,
          );
          scalarDiff(
            "date_format_id",
            "settings.date_format_id",
            desired.dateFormatId,
            live.dateFormatId,
          );

          if (anyChanged && !dryRun) {
            // ONE PUT of the whole (round-tripped) JSON columns - all-or-nothing.
            // Two distinct live-verified semantics govern this body (FakeCorp
            // sandbox Wpmbk5ezJn, your-instance.example, IN v5, 2026-09-21):
            //   * settings / custom_fields are cast JSON columns that IN REPLACES
            //     wholesale when present, so we MUST send the FULL round-tripped
            //     objects (mutating only target keys) or unmanaged siblings are
            //     silently wiped (analogous to the timer time_log round-trip).
            //   * TOP-LEVEL company columns are MERGED (Laravel fill() only sets
            //     attributes present in the payload). PROBE: applied a settings-
            //     only PUT (date_format_id 1->2, no top-level keys) and re-GET
            //     showed is_large / default_quantity / enabled_modules /
            //     first_month_of_year / subdomain all UNCHANGED. So omitting the
            //     top-level columns here is safe - do NOT round-trip them (that
            //     would also risk 400s on read-only/relation columns).
            await inFetch(
              cfg,
              "PUT",
              `companies/${companyId}`,
              { body: { settings: nextSettings, custom_fields: nextCustom } },
              args._fetch,
            );
            applied = true;
          }
          context.logger.info(
            "reconcileCompanySettings {id}: {changed}/{total} field(s) changed " +
              "(dryRun={dryRun}, applied={applied})",
            {
              id: companyId,
              changed: diffs.filter((d) => d.changed).length,
              total: diffs.length,
              dryRun,
              applied,
            },
          );
        } catch (e) {
          context.logger.warning("reconcileCompanySettings failed: {msg}", {
            msg: e instanceof Error ? e.message : String(e),
          });
          errors.push({
            error: e instanceof Error ? e.message : String(e),
            attemptedAt: now(),
            dryRun,
          });
        } finally {
          // Resolve each row's outcome action: unchanged -> in-sync; changed ->
          // updated when a PUT committed, else would-update (dry run, or an
          // apply whose PUT threw before committing).
          const rows = diffs.map((d) => ({
            path: d.path,
            current: d.current,
            desired: d.desired,
            changed: d.changed,
            action: (d.skipReason
              ? "skipped"
              : !d.changed
              ? "in-sync"
              : applied
              ? "updated"
              : "would-update") as
                | "in-sync"
                | "would-update"
                | "updated"
                | "skipped",
            reason: d.skipReason ?? null,
          }));
          const syncName = args.syncScope
            ? `companySettingsSync--${args.syncScope}`
            : "companySettingsSync";
          const errName = args.syncScope
            ? `companySettingsSyncErrors--${args.syncScope}`
            : "companySettingsSyncErrors";
          syncHandle = await context.writeResource(
            "companySettingsSync",
            syncName,
            {
              scope: args.syncScope ?? "companySettingsSync",
              companyId,
              rows,
              applied,
              dryRun,
              retrievedAt: now(),
            },
          );
          errHandle = await context.writeResource(
            "companySettingsSyncErrors",
            errName,
            {
              scope: args.syncScope ?? "companySettingsSyncErrors",
              companyId,
              rows: errors,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: [syncHandle, errHandle] };
      },
    },
    // --- Task CRUD (design/invoiceninja-entity-crud.md §3) ---
    // Reads (listTasks/getTask) + a gated fan-out write (upsertTasks, dedup on
    // `number`). NO timer here — start/stop over time_log is a separate surface.
    listTasks: {
      description:
        "GET /tasks (paginated, include=client,project,status; optional " +
        "client_id/project_id filters) → tasks snapshot with parsed timeLog + " +
        "derived isRunning.",
      arguments: z.object({
        clientId: z.string().optional(),
        projectId: z.string().optional(),
      }),
      execute: async (
        args: { clientId?: string; projectId?: string; _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const query: Array<[string, string]> = [
          ["include", "client,project,status"],
        ];
        if (args.clientId) query.push(["client_id", args.clientId]);
        if (args.projectId) query.push(["project_id", args.projectId]);
        context.logger.info("Fetching tasks");
        const rows = await inFetchAll(
          cfg,
          "tasks",
          query,
          args._fetch,
          context.logger,
        );
        const items = rows.map((r) => normalizeTask(r));
        context.logger.info("{count} tasks", { count: items.length });
        const name = scopeName("tasks", [
          args.clientId && `client=${encodeURIComponent(args.clientId)}`,
          args.projectId && `project=${encodeURIComponent(args.projectId)}`,
        ]);
        return writeSnapshot(context, "tasks", name, items);
      },
    },
    getTask: {
      description:
        "GET /tasks/{id}?include=client,project,status → normalized task row " +
        "(same shape as the list).",
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
        context.logger.info("Fetching task {id}", { id: args.id });
        const json = await inFetch(
          cfg,
          "GET",
          `tasks/${args.id}`,
          { query: [["include", "client,project,status"]] },
          args._fetch,
        );
        const raw = (json.data ?? {}) as Record<string, unknown>;
        const handle = await context.writeResource(
          "task",
          `task:${args.id}`,
          normalizeTask(raw),
        );
        return { dataHandles: [handle] };
      },
    },
    // Fan-out; single-writer; dedup on `custom_value1`; dryRun default; NEVER time_log.
    upsertTasks: {
      description:
        "Check-then-create tasks for a TaskInput[] (dedup on `custom_value1`; " +
        "the caller's key goes there because IN auto-manages the task number). " +
        "Single-writer fan-out; dryRun default true; NEVER sets time_log " +
        "(timing is the timer surface's job). → taskSync (+ taskSyncErrors for " +
        "failed/rejected attempts).",
      arguments: z.object({
        tasks: z.array(z.record(z.string(), z.unknown())).describe(
          "TaskInput[]: {number (dedup key), description, clientId?, " +
            "projectId?, rate?} (design/invoiceninja-entity-crud.md §3).",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true).",
        ),
        syncScope: z.string().min(1).optional().describe(
          "Caller scope key; names taskSync--<scope> / taskSyncErrors--<scope> " +
            "(absent → bare names). Mirrors upsertInvoices.",
        ),
      }),
      execute: async (
        args: {
          tasks: Array<Record<string, unknown>>;
          dryRun?: boolean;
          syncScope?: string;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        // Single-writer: iterate SEQUENTIALLY (the check-then-create TOCTOU
        // window is closed only by single-writer discipline + the per-model
        // lock — repo rule 6). No atomic upsert exists in IN.
        const seen = new Set<string>();
        const rows: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];
        const now = () => new Date().toISOString();
        let syncHandle!: { name: string };
        let errHandle!: { name: string };
        try {
          for (const task of args.tasks) {
            const number = strOrNull(task.number);
            try {
              const r = await upsertTask(
                cfg,
                task,
                dryRun,
                args._fetch,
                seen,
                context.logger,
              );
              rows.push({
                dedupKey: number ?? "",
                action: r.action,
                reason: r.reason ?? null,
                taskId: r.taskId,
                clientId: strOrNull(task.clientId),
                projectId: strOrNull(task.projectId),
              });
              // A blank OR invalid input is a skip AND a surfaced error, so the
              // rejection is queryable (not just a low-signal skip row).
              if (r.reason === "blank-dedup-key" || r.reason === "invalid") {
                errors.push({
                  dedupKey: number ?? "",
                  clientId: strOrNull(task.clientId),
                  error: r.reason,
                  attemptedAt: now(),
                  dryRun,
                });
              }
            } catch (e) {
              // A single failure MUST NOT abort the batch.
              context.logger.warning("upsertTask failed for {number}", {
                number,
              });
              errors.push({
                dedupKey: number ?? "",
                clientId: strOrNull(task.clientId),
                error: e instanceof Error ? e.message : String(e),
                attemptedAt: now(),
                dryRun,
              });
            }
          }
        } finally {
          // Flush BOTH, even on an unexpected throw, so every real create keeps
          // its audit row and every failure keeps a durable, queryable row.
          // taskSyncErrors is flushed ALWAYS (even empty) so a consumer can tell
          // "0 errors this run" from "never ran". Per-scope resource NAMES
          // mirror upsertInvoices so a multi-source run doesn't collapse to the
          // last writer.
          const syncName = args.syncScope
            ? `taskSync--${args.syncScope}`
            : "taskSync";
          const errName = args.syncScope
            ? `taskSyncErrors--${args.syncScope}`
            : "taskSyncErrors";
          syncHandle = await context.writeResource("taskSync", syncName, {
            scope: args.syncScope ?? "taskSync",
            rows,
            dryRun,
            retrievedAt: now(),
          });
          errHandle = await context.writeResource("taskSyncErrors", errName, {
            scope: args.syncScope ?? "taskSyncErrors",
            rows: errors,
            retrievedAt: now(),
          });
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
        "is unresolved (a Mapping with no fallback is unusable). When dryRun=true " +
        "(default cfg.dryRun), additionally unions would-create vendor/category " +
        "names from vendorSync/categorySync into the emitted tables bound to the " +
        "DRYRUN_SENTINEL id (§7.6 dry-run mapping projection) so an all-dryRun " +
        "preview doesn't misreport a to-be-created vendor/category as unmatched; " +
        "the dryRun=false path is byte-for-byte unchanged.",
      arguments: z.object({
        currencyId: z.string().describe(
          "IN currency hashid (USD-only v1, §12.4).",
        ),
        fallbackCategoryName: z.string().optional().describe(
          "Category whose id becomes fallbackCategoryId; default 'Uncategorized'.",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true). Gates the §7.6 " +
            "dry-run mapping projection — ONLY when true does this method read " +
            "vendorSync/categorySync and union would-create names bound to " +
            "DRYRUN_SENTINEL. false ⇒ byte-for-byte unchanged (no sentinel, no " +
            "*Sync reads).",
        ),
      }),
      execute: async (
        args: {
          currencyId: string;
          fallbackCategoryName?: string;
          dryRun?: boolean;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
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
        let vendors: Record<string, string> = {
          ...rawNameIndex(vendorItems),
          ...overlayAliases(
            Object.keys(vendorOverlay),
            vendorOverlay,
            vendorItems,
            context.logger,
          ),
        };
        let categories: Record<string, string> = {
          ...rawNameIndex(catItems),
          ...overlayAliases(
            Object.keys(categoryOverlay),
            categoryOverlay,
            catItems,
            context.logger,
          ),
        };
        // HARD-OVERRIDE tier (§7.5): counterparty → target-category id, consulted
        // by mapTxnToExpense BEFORE `categories`. Unresolved target dropped with a
        // warning inside overlayAliases (never a bad bind). Untouched by the §7.6
        // projection below — the sentinel is unioned into vendors/categories only.
        const vendorCategories = overlayAliases(
          Object.keys(vendorCategoryOverlay),
          vendorCategoryOverlay,
          catItems,
          context.logger,
        );
        // §7.6 dry-run mapping projection (faithful preview) — STRUCTURALLY
        // GATED on dryRun: this whole block, including the vendorSync/
        // categorySync reads, only runs when dryRun === true. The dryRun ===
        // false path above/below never executes it, so the sentinel is
        // unreachable in a live run even under a future refactor mistake.
        if (dryRun) {
          const vendorSyncSnap = await read("vendorSync");
          const categorySyncSnap = await read("categorySync");
          const vendorSyncRows = Array.isArray(vendorSyncSnap?.rows)
            ? vendorSyncSnap.rows as Array<Record<string, unknown>>
            : [];
          const categorySyncRows = Array.isArray(categorySyncSnap?.rows)
            ? categorySyncSnap.rows as Array<Record<string, unknown>>
            : [];
          // Accumulate additions in a Map, then merge via Object.fromEntries —
          // [[DefineOwnProperty]] semantics — so a would-create entity literally
          // named "__proto__" becomes a real own data property (a plain
          // `vendors[name] = …` would hit the legacy __proto__ accessor on some
          // runtimes and silently drop the entry while still counting it). Same
          // discipline as rawNameIndex/overlayAliases (DRP-02).
          const vendorAdds = new Map<string, string>();
          for (const row of vendorSyncRows) {
            if (row.action !== "would-create") continue;
            const name = strOrNull(row.name);
            // A real bind (exact OR normName match) ALWAYS wins over the
            // sentinel — never overwrite an existing entry.
            if (name === null || ownLookupNorm(vendors, name) !== undefined) {
              continue;
            }
            vendorAdds.set(name, DRYRUN_SENTINEL);
          }
          const categoryAdds = new Map<string, string>();
          for (const row of categorySyncRows) {
            if (row.action !== "would-create") continue;
            const name = strOrNull(row.name);
            if (
              name === null || ownLookupNorm(categories, name) !== undefined
            ) {
              continue;
            }
            categoryAdds.set(name, DRYRUN_SENTINEL);
          }
          // Rebuild via Object.fromEntries (define semantics, not [[Set]]) so a
          // "__proto__" key lands as a real own data property — Object.assign /
          // bracket-set would hit the accessor and drop it (DRP-02).
          vendors = Object.fromEntries([
            ...Object.entries(vendors),
            ...vendorAdds,
          ]) as Record<string, string>;
          categories = Object.fromEntries([
            ...Object.entries(categories),
            ...categoryAdds,
          ]) as Record<string, string>;
          const vendorsProjected = vendorAdds.size;
          const categoriesProjected = categoryAdds.size;
          if (vendorsProjected > 0 || categoriesProjected > 0) {
            context.logger.info(
              "buildMapping (dryRun): projected {vendorsProjected} would-create " +
                "vendor(s) + {categoriesProjected} would-create category(ies) " +
                "onto the sentinel id (§7.6)",
              { vendorsProjected, categoriesProjected },
            );
          }
        }
        const handle = await context.writeResource("mapping", "mapping", {
          scope: "mapping",
          currencyId: args.currencyId,
          fallbackCategoryId,
          vendors,
          categories,
          vendorCategories,
          retrievedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    // --- Presentation (design/finops-digest.md) ---
    finopsDigest: {
      description:
        "Render the daily dry-run into swamp-owned views: summary/detailed " +
        "markdown resources + an email-ready HTML file. Reads the per-scope " +
        "expenseSync resources via the shared finops aggregator (same code path " +
        "as the finops-review report). Pure presentation — no writes to IN.",
      arguments: z.object({
        format: z.enum(["summary", "detailed", "html", "all"]).default("all")
          .describe(
            "Which view(s) to write. 'all' (default) writes all three: " +
              "finops-summary.md, finops-detailed.md, finops-digest.html.",
          ),
      }),
      execute: async (
        args: { format?: "summary" | "detailed" | "html" | "all" },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const format = args.format ?? "all";
        const repo = context.dataRepository;
        if (!repo) {
          throw new Error(
            "finopsDigest: context.dataRepository is unavailable — cannot read " +
              "the expenseSync resources.",
          );
        }
        const agg = await aggregateFinops(
          repo,
          context.modelType,
          context.modelId ?? "",
          context.globalArgs as unknown as Record<string, unknown>,
        );
        const meta = {
          generatedAt: agg.generatedAt,
          dryRun: agg.anyDryRun,
          window: { start: agg.windowStart, end: agg.windowEnd },
          newCount: agg.overall.new.n,
          syncedCount: agg.overall.synced.n,
        };
        const handles: Array<{ name: string }> = [];
        const wantSummary = format === "summary" || format === "all";
        const wantDetailed = format === "detailed" || format === "all";
        const wantHtml = format === "html" || format === "all";

        if (wantSummary) {
          handles.push(
            await context.writeResource("finopsDigest", "finops-summary.md", {
              format: "summary",
              markdown: renderSummaryMarkdown(agg),
              ...meta,
            }),
          );
        }
        if (wantDetailed) {
          handles.push(
            await context.writeResource("finopsDigest", "finops-detailed.md", {
              format: "detailed",
              markdown: renderDetailedMarkdown(agg),
              ...meta,
            }),
          );
        }
        if (wantHtml) {
          if (!context.createFileWriter) {
            throw new Error(
              "finopsDigest: context.createFileWriter is unavailable — cannot " +
                "emit the HTML file.",
            );
          }
          const w = context.createFileWriter(
            "finopsHtml",
            "finops-digest.html",
          );
          handles.push(await w.writeText(renderEmailHtml(agg)));
        }
        context.logger.info(
          "finopsDigest wrote {n} view(s) [{fmt}]: {new} new / {synced} synced",
          {
            n: handles.length,
            fmt: format,
            new: agg.overall.new.n,
            synced: agg.overall.synced.n,
          },
        );
        return { dataHandles: handles };
      },
    },
    // --- Maintenance: clean up mis-synced rows (design/finops-digest.md follow-up) ---
    archiveExpenses: {
      description:
        "Archive (default, reversible) or delete expenses by hashid via " +
        "POST /expenses/bulk — cleanup for non-business rows the bank feed " +
        "mis-swept into IN (e.g. a personal wire + fee). Honors cfg.dryRun: " +
        "preview by default; pass dryRun=false for the authorized live mutation.",
      arguments: z.object({
        ids: z.array(z.string().min(1)).min(1).describe(
          "Expense hashids to act on.",
        ),
        action: z.enum(["archive", "delete"]).default("archive").describe(
          "archive (reversible) or delete (permanent).",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true) → preview only.",
        ),
      }),
      execute: async (
        args: {
          ids: string[];
          action?: "archive" | "delete";
          dryRun?: boolean;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        const action = args.action ?? "archive";
        if (dryRun) {
          context.logger.info(
            "archiveExpenses DRY-RUN — would {action} {n} expense(s): {ids}",
            { action, n: args.ids.length, ids: args.ids.join(",") },
          );
          return { dataHandles: [] };
        }
        const resp = await inFetch(
          cfg,
          "POST",
          "expenses/bulk",
          { body: { action, ids: args.ids } },
          args._fetch,
        );
        const affected = Array.isArray(resp.data) ? resp.data.length : 0;
        context.logger.info(
          "archiveExpenses LIVE — {action}d {n}/{req} expense(s)",
          { action, n: affected, req: args.ids.length },
        );
        return { dataHandles: [] };
      },
    },
    // --- Maintenance: archive/delete tasks (mirrors archiveExpenses) ---
    archiveTasks: {
      description:
        "Archive (default, reversible) or delete tasks by hashid via " +
        "POST /tasks/bulk — cleanup for probe/test or mis-created tasks. Honors " +
        "cfg.dryRun: preview by default; pass dryRun=false for the authorized " +
        "live mutation. ids act on the IN task hashid (t.id), not the dedup key.",
      arguments: z.object({
        ids: z.array(z.string().min(1)).min(1).describe(
          "Task hashids (t.id) to act on.",
        ),
        action: z.enum(["archive", "delete"]).default("archive").describe(
          "archive (reversible) or delete (permanent).",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true) → preview only.",
        ),
      }),
      execute: async (
        args: {
          ids: string[];
          action?: "archive" | "delete";
          dryRun?: boolean;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        const action = args.action ?? "archive";
        if (dryRun) {
          context.logger.info(
            "archiveTasks DRY-RUN — would {action} {n} task(s): {ids}",
            { action, n: args.ids.length, ids: args.ids.join(",") },
          );
          return { dataHandles: [] };
        }
        const resp = await inFetch(
          cfg,
          "POST",
          "tasks/bulk",
          { body: { action, ids: args.ids } },
          args._fetch,
        );
        const affected = Array.isArray(resp.data) ? resp.data.length : 0;
        context.logger.info(
          "archiveTasks LIVE — {action}d {n}/{req} task(s)",
          { action, n: affected, req: args.ids.length },
        );
        return { dataHandles: [] };
      },
    },
    // --- Maintenance: archive/delete clients (mirrors archiveTasks) ---
    archiveClients: {
      description:
        "Archive (default, reversible) or delete clients by hashid via " +
        "POST /clients/bulk — cleanup for duplicate or mis-created client " +
        "records (e.g. empty duplicate client rows left by an import). Honors " +
        "cfg.dryRun: preview by default; pass dryRun=false for the authorized " +
        "live mutation. ids act on the IN client hashid (c.id), not the number. " +
        "BLAST RADIUS: unlike the leaf-record archiveExpenses/archiveTasks, a " +
        "client is a parent — IN cascades archive/delete to its invoices, " +
        "quotes, payments, credits, and documents. Prefer 'archive' (reversible " +
        "in the IN UI); reserve 'delete' for clients you have confirmed carry no " +
        "financial history, and verify ids first.",
      arguments: z.object({
        ids: z.array(z.string().min(1)).min(1).describe(
          "Client hashids (c.id) to act on.",
        ),
        action: z.enum(["archive", "delete"]).default("archive").describe(
          "archive (reversible) or delete (permanent, cascades to children).",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true) → preview only.",
        ),
      }),
      execute: async (
        args: {
          ids: string[];
          action?: "archive" | "delete";
          dryRun?: boolean;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        const action = args.action ?? "archive";
        if (dryRun) {
          context.logger.info(
            "archiveClients DRY-RUN — would {action} {n} client(s): {ids}",
            { action, n: args.ids.length, ids: args.ids.join(",") },
          );
          return { dataHandles: [] };
        }
        const resp = await inFetch(
          cfg,
          "POST",
          "clients/bulk",
          { body: { action, ids: args.ids } },
          args._fetch,
        );
        const affected = Array.isArray(resp.data) ? resp.data.length : 0;
        context.logger.info(
          "archiveClients LIVE — {action}d {n}/{req} client(s)",
          { action, n: affected, req: args.ids.length },
        );
        return { dataHandles: [] };
      },
    },
    // --- Maintenance: merge/consolidate expense categories ----------------
    // (design/specs/invoiceninja-category-merge.spec.md) Single-writer, dryRun-
    // gated. IN has NO native category-merge API, so this reassigns expenses off
    // each redundant source onto a canonical target (PUT /expenses/{id}), then
    // archives the emptied sources (POST /expense_categories/bulk). Reuses the
    // frozen inFetch (GET|POST|PUT) + inFetchAll seams and the archiveExpenses
    // bulk pattern — no new HTTP verb, no DELETE seam.
    mergeExpenseCategories: {
      description:
        "Consolidate redundant expense categories: reassign every non-deleted " +
        "expense off each merge group's fromIds onto its toId (PUT /expenses/" +
        "{id}), then archive the emptied sources (POST /expense_categories/bulk " +
        "action:archive). Honors cfg.dryRun (preview by default; ZERO writes). A " +
        "source that still holds a live expense post-reassign is NOT archived " +
        "(skipped:still-has-live-expenses). NEVER touches the buildMapping " +
        "fallback category (V2) or a merge target. Emits the categoryMerge audit.",
      arguments: z.object({
        merges: z.array(z.object({
          fromIds: z.array(z.string().min(1)).min(1).describe(
            "Source category hashids whose expenses reassign onto toId.",
          ),
          toId: z.string().min(1).describe(
            "Canonical target category hashid (kept).",
          ),
        })).default([]).describe(
          "Merge groups: reassign fromIds → toId. Default [].",
        ),
        deleteIds: z.array(z.string().min(1)).default([]).describe(
          "Categories to archive outright once they hold zero live expenses. " +
            "Default [].",
        ),
        deleteEmptied: z.boolean().default(true).describe(
          "After a group's reassignments, also archive the emptied fromIds. " +
            "Default true.",
        ),
        fallbackName: z.string().default("None").describe(
          "The buildMapping-ensured fallback category NAME — its id is guarded " +
            "out of every fromIds/deleteIds (V2). Resolved over LIVE categories " +
            "only; if it does not resolve the method REFUSES to run. Default " +
            "'None'. Ignored when fallbackId is passed.",
        ),
        fallbackId: z.string().optional().describe(
          "Explicit hashid of the protected fallback category — bypasses the " +
            "fallbackName lookup and guards it unambiguously (pass the prod " +
            "'None' id here for a fail-closed go-live). Validated to exist.",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true) → preview, no writes.",
        ),
      }),
      execute: async (
        args: {
          merges?: Array<{ fromIds: string[]; toId: string }>;
          deleteIds?: string[];
          deleteEmptied?: boolean;
          fallbackName?: string;
          fallbackId?: string;
          dryRun?: boolean;
          _fetch?: FetchLike;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const dryRun = args.dryRun ?? cfg.dryRun;
        const merges = args.merges ?? [];
        const deleteIds = args.deleteIds ?? [];
        const deleteEmptied = args.deleteEmptied ?? true;
        const fallbackName = args.fallbackName ?? "None";
        const now = () => new Date().toISOString();

        // (1) Refresh inputs. with_trashed=true is REQUIRED: archived expenses
        // must count against a source so it can fully empty, and already-archived
        // categories must be visible so a re-run is a clean no-op (idempotency)
        // rather than a V1 "unknown id" error. inFetchAll spreads this query pair
        // ahead of its own per_page/page, and IN honors the later value if
        // cfg.withTrashed also set it — harmless.
        const catRows = await inFetchAll(
          cfg,
          "expense_categories",
          [["with_trashed", "true"]],
          args._fetch,
          context.logger,
        );
        const cats = catRows.map((r) => normalizeMapItem(r));
        const expRows = await inFetchAll(
          cfg,
          "expenses",
          [["include", "category"], ["with_trashed", "true"]],
          args._fetch,
          context.logger,
        );
        const exps = expRows.map((r) => normalizeExpense(r));
        const catById = new Map(cats.map((c) => [c.id, c]));

        // ---- Validation (throw BEFORE any write; never partial-guess) --------
        const referenced = new Set<string>();
        // fromId → toId; a source routed to two different targets is ambiguous.
        const fromToMap = new Map<string, string>();
        for (const g of merges) {
          referenced.add(g.toId);
          if (g.fromIds.includes(g.toId)) {
            throw new Error(
              `mergeExpenseCategories: toId ${g.toId} appears in its own ` +
                `fromIds (V3) — a category cannot merge into itself.`,
            );
          }
          for (const f of g.fromIds) {
            referenced.add(f);
            const prev = fromToMap.get(f);
            if (prev && prev !== g.toId) {
              throw new Error(
                `mergeExpenseCategories: source ${f} is routed to two targets ` +
                  `(${prev} and ${g.toId}) — ambiguous, no writes.`,
              );
            }
            fromToMap.set(f, g.toId);
          }
        }
        for (const d of deleteIds) referenced.add(d);

        // Forbid CHAINED / transitive merges: a category that is a merge target
        // must not also be a merge source in another group (e.g. X→Y and Y→Z).
        // We reassign in one hop only, so X's expenses would land on Y (not Z)
        // and silently strand there. Reject up front rather than half-apply —
        // split into sequential calls. Also keeps every merge target structurally
        // un-archivable (it can never become a deletion candidate).
        for (const g of merges) {
          if (fromToMap.has(g.toId)) {
            throw new Error(
              `mergeExpenseCategories: chained/transitive merge not supported — ` +
                `category ${g.toId} is both a merge target and a merge source. ` +
                `Split into sequential calls. No writes performed.`,
            );
          }
        }

        // (V1) every referenced id must exist in the snapshot.
        for (const id of referenced) {
          if (!catById.has(id)) {
            throw new Error(
              `mergeExpenseCategories: category id ${id} is not in the ` +
                `expenseCategories snapshot (V1) — no writes performed.`,
            );
          }
        }
        // A merge target must never also be scheduled for deletion.
        const deleteSet = new Set(deleteIds);
        for (const g of merges) {
          if (deleteSet.has(g.toId)) {
            throw new Error(
              `mergeExpenseCategories: target ${g.toId} is also in deleteIds — ` +
                `refusing to delete a merge target.`,
            );
          }
        }
        // (V2) FALLBACK GUARD — buildMapping depends on the ensured fallback, so
        // it must NEVER be merged away or archived. Resolve fail-CLOSED: an
        // explicit fallbackId wins (validated to exist); otherwise resolve
        // fallbackName over LIVE categories only (non-deleted AND non-archived),
        // so a stale or archived duplicate sharing the name can't hijack the
        // guard onto a dead id. NOTE this is intentionally STRICTER than
        // buildMapping's notDeleted filter (isDeleted-only, which keeps archived-
        // but-not-deleted rows): if the ensured fallback is itself archived, this
        // guard fails closed rather than binding an archived id — pass an explicit
        // fallbackId to protect an archived fallback. If neither branch yields a
        // live id, REFUSE to run — a merge with an unresolved fallback guard is
        // unsafe.
        let fallbackId: string;
        if (args.fallbackId !== undefined) {
          if (!catById.has(args.fallbackId)) {
            throw new Error(
              `mergeExpenseCategories: fallbackId ${args.fallbackId} is not in ` +
                `the expenseCategories snapshot — cannot guard it. No writes.`,
            );
          }
          fallbackId = args.fallbackId;
        } else {
          const liveCats = cats.filter(
            (c) => c.isDeleted !== true && c.archivedAt === null,
          );
          const resolved = resolveByNorm(liveCats, fallbackName);
          if (resolved === null) {
            throw new Error(
              `mergeExpenseCategories: fallback category "${fallbackName}" not ` +
                `found among live expense categories; pass fallbackId to protect ` +
                `it explicitly — refusing to run a merge without a resolved ` +
                `fallback guard. No writes performed.`,
            );
          }
          fallbackId = resolved;
        }
        if (fromToMap.has(fallbackId) || deleteSet.has(fallbackId)) {
          throw new Error(
            `mergeExpenseCategories: fallback category (${fallbackId}) must not ` +
              `appear in any fromIds/deleteIds (V2) — buildMapping's ensured ` +
              `fallback. No writes performed.`,
          );
        }

        // ---- Plan ------------------------------------------------------------
        // Non-deleted expenses (archived INCLUDED) indexed by category id. A
        // source empties only when its archived rows move too.
        const liveByCat = new Map<string, typeof exps>();
        for (const e of exps) {
          if (e.isDeleted === true) continue;
          if (e.categoryId === null) continue;
          const arr = liveByCat.get(e.categoryId) ?? [];
          arr.push(e);
          liveByCat.set(e.categoryId, arr);
        }

        const reassignments: Array<{
          expenseId: string;
          fromId: string;
          toId: string;
          amount: number | null;
          archived: boolean;
        }> = [];
        for (const [fromId, toId] of fromToMap) {
          for (const e of liveByCat.get(fromId) ?? []) {
            reassignments.push({
              expenseId: e.id,
              fromId,
              toId,
              amount: e.amount,
              archived: e.archivedAt !== null,
            });
          }
        }

        // Deletion candidates = deleteIds ∪ (deleteEmptied ? all fromIds : []).
        const candidates = new Set<string>(deleteIds);
        if (deleteEmptied) {
          for (const f of fromToMap.keys()) {
            candidates.add(f);
          }
        }
        const allToIds = new Set(fromToMap.values());

        const skipped: Array<
          { categoryId: string; reason: string; remaining: number }
        > = [];
        const errors: Array<{
          expenseId: string;
          fromId: string;
          toId: string;
          error: string;
          attemptedAt: string;
        }> = [];

        // A candidate is archivable ONLY when it ends with zero live expenses
        // (accounting for reassignments that actually SUCCEEDED — in live mode a
        // failed PUT leaves its expense in the source, so the source is NOT
        // emptied and must not be archived). Already-archived/deleted categories,
        // the fallback, and any merge target are excluded defensively.
        const computeDeletable = (
          successAway: Map<string, number>,
        ): string[] => {
          const del: string[] = [];
          for (const cat of candidates) {
            const c = catById.get(cat)!;
            if (c.archivedAt !== null || c.isDeleted === true) {
              // Already gone — re-running is a clean no-op, not a re-archive.
              skipped.push({
                categoryId: cat,
                reason: "already-archived",
                remaining: 0,
              });
              continue;
            }
            if (cat === fallbackId) continue; // defensive (V2 already threw)
            if (allToIds.has(cat)) continue; // never archive a merge target
            const remaining = Math.max(
              0,
              (liveByCat.get(cat)?.length ?? 0) - (successAway.get(cat) ?? 0),
            );
            if (remaining > 0) {
              skipped.push({
                categoryId: cat,
                reason: "still-has-live-expenses",
                remaining,
              });
              continue;
            }
            del.push(cat);
          }
          return del;
        };

        // ---- DRY-RUN: preview only, ZERO writes on the wire ------------------
        if (dryRun) {
          const successAway = new Map<string, number>();
          for (const r of reassignments) {
            successAway.set(r.fromId, (successAway.get(r.fromId) ?? 0) + 1);
          }
          const deletions = computeDeletable(successAway);
          context.logger.info(
            "mergeExpenseCategories DRY-RUN — would reassign {r} expense(s) " +
              "and archive {d} categor(ies)",
            { r: reassignments.length, d: deletions.length },
          );
          const handle = await context.writeResource(
            "categoryMerge",
            "categoryMerge",
            {
              scope: "categoryMerge",
              dryRun: true,
              reassignments,
              deletions,
              skipped,
              errors,
              archiveError: null,
              retrievedAt: now(),
            },
          );
          return { dataHandles: [handle] };
        }

        // ---- LIVE (dryRun=false) --------------------------------------------
        let reassignedCount = 0;
        let deletions: string[] = [];
        let archiveError:
          | { ids: string[]; error: string; attemptedAt: string }
          | null = null;
        let liveHandle: { name: string } | null = null;
        const successAway = new Map<string, number>();
        try {
          // Reassign SEQUENTIALLY (single-writer, repo rule 6). A single PUT
          // failure is captured and MUST NOT abort the batch.
          for (const r of reassignments) {
            try {
              await inFetch(
                cfg,
                "PUT",
                `expenses/${r.expenseId}`,
                { body: { category_id: r.toId } },
                args._fetch,
              );
              reassignedCount += 1;
              successAway.set(
                r.fromId,
                (successAway.get(r.fromId) ?? 0) + 1,
              );
            } catch (e) {
              errors.push({
                expenseId: r.expenseId,
                fromId: r.fromId,
                toId: r.toId,
                error: e instanceof Error ? e.message : String(e),
                attemptedAt: now(),
              });
            }
          }
          // Only archive categories that ended EMPTY given the reassigns that
          // actually landed. The archive POST is wrapped: if it fails, NOTHING
          // was archived, so `deletions` stays [] (never a lie) and the attempt
          // is recorded in archiveError — the reassignments already succeeded and
          // must not be lost to an archive-step throw.
          const toArchive = computeDeletable(successAway);
          if (toArchive.length > 0) {
            try {
              await inFetch(
                cfg,
                "POST",
                "expense_categories/bulk",
                { body: { action: "archive", ids: toArchive } },
                args._fetch,
              );
              deletions = toArchive;
            } catch (e) {
              archiveError = {
                ids: toArchive,
                error: e instanceof Error ? e.message : String(e),
                attemptedAt: now(),
              };
            }
          }
          context.logger.info(
            "mergeExpenseCategories LIVE — reassigned {r}/{p} expense(s), " +
              "archived {d} categor(ies), {e} PUT error(s){a}",
            {
              r: reassignedCount,
              p: reassignments.length,
              d: deletions.length,
              e: errors.length,
              a: archiveError !== null ? " [archive POST FAILED]" : "",
            },
          );
        } finally {
          // FLUSH the audit even on a mid-batch throw, so what actually hit the
          // wire is durable and queryable. Capture the handle so a workflow can
          // wire off this method's dataHandles on the REAL run too, not just the
          // dry-run.
          liveHandle = await context.writeResource(
            "categoryMerge",
            "categoryMerge",
            {
              scope: "categoryMerge",
              dryRun: false,
              reassignments,
              deletions,
              skipped,
              errors,
              archiveError,
              retrievedAt: now(),
            },
          );
        }
        return { dataHandles: liveHandle !== null ? [liveHandle] : [] };
      },
    },
    // --- Task timer (§4) — stateful start/stop over a task's `time_log`. ---
    startTask: {
      description:
        "Start a task's timer: GET /tasks/{id}, and if no open time_log pair " +
        "exists append [now(sec), 0] and PUT /tasks/{id} → {running:true, " +
        "action:'started'}. An already-open pair is an idempotent no-op " +
        "(action:'already-running', no PUT). dryRun (default true) returns the " +
        "would-be state and does NOT PUT. → taskTimer.",
      arguments: z.object({
        // Same path-safety boundary as getInvoice: a full-account token makes an
        // unvalidated id in the URL path dangerous.
        id: z.string().regex(
          /^[A-Za-z0-9]+$/,
          "IN hashid must be alphanumeric (no path separators)",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true) → no PUT.",
        ),
      }),
      execute: (
        args: {
          id: string;
          dryRun?: boolean;
          _fetch?: FetchLike;
          _nowMs?: () => number;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => runTaskTimer("start", args, context),
    },
    stopTask: {
      description:
        "Stop a task's timer: GET /tasks/{id}, and if an open time_log pair " +
        "exists set the LATEST open pair's stop to now(sec) and PUT /tasks/{id} " +
        "→ {running:false, action:'stopped'}. No open pair is an idempotent " +
        "no-op (action:'not-running', no PUT). dryRun (default true) returns the " +
        "would-be state and does NOT PUT. → taskTimer.",
      arguments: z.object({
        id: z.string().regex(
          /^[A-Za-z0-9]+$/,
          "IN hashid must be alphanumeric (no path separators)",
        ),
        dryRun: z.boolean().optional().describe(
          "Overrides cfg.dryRun; default cfg.dryRun (true) → no PUT.",
        ),
      }),
      execute: (
        args: {
          id: string;
          dryRun?: boolean;
          _fetch?: FetchLike;
          _nowMs?: () => number;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => runTaskTimer("stop", args, context),
    },
  },
};

/**
 * Shared executor for startTask/stopTask (§4). Reads the task via the single
 * `inFetch` seam, parses `time_log`, applies the PURE {@link decideStart}/
 * {@link decideStop}, PUTs the rewritten `time_log` only when the decision
 * changed AND `dryRun` is false, and writes the outcome to `taskTimer`.
 *
 * The clock is injectable via `_nowMs` (defaults to `Date.now`) and converted
 * to the UNIX-SECONDS unit IN's `time_log` uses (`Math.floor(ms/1000)`).
 * Single-writer discipline (per-model lock) is what makes the read→PUT safe
 * against a concurrent flip corrupting `time_log` — no extra code here.
 */
async function runTaskTimer(
  mode: "start" | "stop",
  args: {
    id: string;
    dryRun?: boolean;
    _fetch?: FetchLike;
    _nowMs?: () => number;
  },
  context: ExecuteContext,
): Promise<ExecuteResult> {
  const cfg = context.globalArgs;
  const dryRun = args.dryRun ?? cfg.dryRun;
  // Defense-in-depth id guard: tests (and any non-zod caller) reach execute
  // directly, so re-assert the charset boundary here before it hits the path.
  if (!/^[A-Za-z0-9]+$/.test(args.id)) {
    throw new Error(
      `${mode}Task: task id "${args.id}" must be alphanumeric ` +
        "(no path separators)",
    );
  }
  const nowMs = (args._nowMs ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);

  const json = await inFetch(cfg, "GET", `tasks/${args.id}`, {}, args._fetch);
  const raw = (json.data ?? {}) as Record<string, unknown>;
  const log = parseTimeLogEntries(raw.time_log);
  const decision = mode === "start"
    ? decideStart(log, nowSec)
    : decideStop(log, nowSec);

  if (decision.changed && !dryRun) {
    // PUT the rewritten time_log as the JSON STRING IN returns/expects.
    await inFetch(
      cfg,
      "PUT",
      `tasks/${args.id}`,
      { body: { time_log: JSON.stringify(decision.newLog) } },
      args._fetch,
    );
  }
  context.logger.info(
    "{mode}Task {id}: {action} (running={running}, dryRun={dryRun})",
    {
      mode,
      id: args.id,
      action: decision.action,
      running: decision.running,
      dryRun,
    },
  );
  const handle = await context.writeResource(
    "taskTimer",
    `taskTimer:${args.id}`,
    {
      taskId: args.id,
      running: decision.running,
      action: decision.action,
      dryRun,
      timeLog: decision.newLog,
      at: new Date().toISOString(),
    },
  );
  return { dataHandles: [handle] };
}
