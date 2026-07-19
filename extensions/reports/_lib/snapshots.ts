/**
 * Shared snapshot readers for the `@shrug/invoiceninja` reports.
 *
 * Reports are pure aggregation over the versioned snapshot resources the model's
 * read methods persist (§8 of design/invoiceninja-expense-sync.md) — they never
 * re-fetch from the Invoice Ninja API (repo rules 3 & 8). Every read method
 * writes a `{ scope, count, items[], retrievedAt }` envelope (see
 * `snapshotSchema` in extensions/models/invoiceninja.ts); these helpers pull the
 * latest such envelope out of the report's `dataRepository` and hand back the
 * normalized `items[]`.
 *
 * @module
 */

/**
 * Structural slice of swamp's `UnifiedDataRepository` — only the read surface a
 * report needs. `getContent` returns the latest version's bytes when `version`
 * is omitted (report-types.md → UnifiedDataRepository Methods).
 */
export interface DataRepository {
  getContent(
    type: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

/**
 * Structural slice of `ModelReportContext` (scope: "model"). A model-scope
 * report runs after every method-scope report on the same model, so the latest
 * snapshot of each resource is already persisted by the time we read.
 */
export interface ReportCtx {
  scope: string;
  modelType: unknown;
  modelId: string;
  dataRepository: DataRepository;
  executionStatus: "succeeded" | "failed";
  /** Resolved model global arguments — optional report-period keys read here. */
  globalArgs?: Record<string, unknown>;
}

/** The list-snapshot envelope every read method writes (`snapshotSchema`). */
export interface Snapshot<T> {
  scope: string;
  count: number;
  items: T[];
  retrievedAt: string;
}

/**
 * Parse a snapshot-envelope byte payload into its `items[]`. Never throws:
 * absent/empty/malformed bytes yield an empty result, so a report over
 * partially-populated data degrades to empty sections rather than failing the
 * run — a report `execute` throw is only advisory, but an empty result is the
 * honest "no data yet" signal. Shared by model-scope (`readItems`) and
 * workflow-scope (`reconcile`) readers.
 */
export function parseSnapshot<T>(
  bytes: Uint8Array | null,
): { items: T[]; retrievedAt: string | null } {
  if (!bytes || bytes.length === 0) return { items: [], retrievedAt: null };
  try {
    const snap = JSON.parse(new TextDecoder().decode(bytes)) as Snapshot<T>;
    // Drop non-object elements (null/scalar) so a partially-written or hostile
    // snapshot can't make a downstream `row.field` access throw — the aggregators
    // all assume object rows. Keeps the never-throw contract honest end to end.
    return {
      items: Array.isArray(snap.items)
        ? snap.items.filter((it): it is T =>
          typeof it === "object" && it !== null
        )
        : [],
      retrievedAt: typeof snap.retrievedAt === "string"
        ? snap.retrievedAt
        : null,
    };
  } catch {
    return { items: [], retrievedAt: null };
  }
}

/**
 * Read the latest snapshot envelope for `resourceName` (model scope) and return
 * its `items[]`. See {@link parseSnapshot} for the never-throw contract.
 */
export async function readItems<T>(
  ctx: ReportCtx,
  resourceName: string,
): Promise<{ items: T[]; retrievedAt: string | null }> {
  const bytes = await ctx.dataRepository.getContent(
    ctx.modelType,
    ctx.modelId,
    resourceName,
  );
  return parseSnapshot<T>(bytes);
}

// ---------------------------------------------------------------------------
// Normalized row shapes (mirror the frozen field sets in
// extensions/models/invoiceninja.ts — kept structural so the reports compile
// independently of the model module).
// ---------------------------------------------------------------------------

/** A normalized `invoices` row (§4.3). */
export interface InvoiceRow {
  id: string;
  number: string | null;
  clientId: string | null;
  statusId: number | null;
  statusLabel: string | null;
  computedStatus: string | null;
  amount: number | null;
  balance: number | null;
  paidToDate: number | null;
  date: string | null;
  dueDate: string | null;
  isDeleted: boolean | null;
  archivedAt: number | null;
}

/** A normalized `expenses` row (§4.3; carries the `customValue1` dedup mirror). */
export interface ExpenseRow {
  id: string;
  amount: number | null;
  date: string | null;
  paymentDate: string | null;
  categoryId: string | null;
  vendorId: string | null;
  clientId: string | null;
  invoiceId: string | null;
  currencyId: string | null;
  derivedStatus: string | null;
  shouldBeInvoiced: boolean | null;
  customValue1: string | null;
}

/** A `{ id, name }` mapping row (`vendors`, `expenseCategories`). */
export interface MapRow {
  id: string;
  name: string | null;
}

/** Build an `id → name` lookup from a mapping snapshot, for label enrichment. */
export function nameIndex(rows: MapRow[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const r of rows) {
    if (r.id) idx.set(r.id, r.name ?? r.id);
  }
  return idx;
}

/** Round to cents for stable money output. */
export function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Escape a value for a Markdown table cell. Two concerns, since the text is
 * snapshot-derived (client id, category/vendor name — untrusted, externally
 * editable in Invoice Ninja):
 *  - `|`/newline would break the table's column alignment for every later row;
 *  - `<`/`>`/`&` would inject markup if the rendered Markdown is ever passed
 *    through a raw-HTML renderer (defense-in-depth against stored XSS).
 * `&` is escaped first so the entities we introduce aren't double-escaped.
 * Accepts `unknown` and coerces defensively — a snapshot field that is absent or
 * a non-string JSON value must never make `.replace` throw and abort a report.
 */
export function mdCell(s: unknown): string {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}
