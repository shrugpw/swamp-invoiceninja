/**
 * `@shrug/invoiceninja/snapshot` — the materialize report (IN → committable YAML).
 *
 * The "return leg" of declarative Invoice Ninja management
 * (design/invoiceninja-snapshot-sync.md §5.1). Model methods write datastore
 * resources, not the repo tree; a REPORT is swamp's "render committable output"
 * primitive (repo rule 8). This report reads the latest read-method snapshots
 * over the DECLARED scope (`clients` / `projects` / `invoices` — §3: the tracked
 * files ARE the scope, no blanket dump) and renders:
 *
 *   1. the observed `*.state.yaml` docs — canonical, PII-free for clients
 *      (§4: `id, number, balance, archivedAt` — NAME/CONTACTS are NEVER written
 *      to a committed state file), machine-generated, never an `apply` input; and
 *   2. a round-trippable DESIRED subset preview (§7.3) — exactly what `apply`
 *      would re-apply as an all-skip no-op. The client desired subset carries
 *      `name` (required by upsertClient's create path) and is therefore flagged
 *      as PII in the output — a human chooses whether to commit it to
 *      `reconcile/clients.yaml`.
 *
 * Pure rendering over persisted snapshots — no API calls (repo rules 3 & 8). The
 * report emits `{markdown, json}`; a human redirects the YAML into the tracked
 * file and commits (swamp does not write the working tree).
 *
 * @module
 */

import { parseSnapshot, type ReportCtx } from "./_lib/snapshots.ts";
import {
  canonicalizeYaml,
  type ObservedClient,
  type ObservedProject,
  renderStateDoc,
  toDesiredClient,
  toDesiredProject,
} from "./_lib/snapshot_sync.ts";

/** Observed client row (model `ClientSchema`; carries PII in name/contacts). */
interface ClientRow extends ObservedClient {
  id: string;
  number: string | null;
  name: string | null;
  balance: number | null;
  paidToDate: number | null;
  isDeleted: boolean | null;
  archivedAt: number | null;
}

/** Observed project row (model `ProjectSchema`; low-PII). */
interface ProjectRow extends ObservedProject {
  id: string;
  number: string | null;
  name: string | null;
  clientId: string | null;
  taskRate: number | null;
  budgetedHours: number | null;
  dueDate: string | null;
  isDeleted: boolean | null;
  archivedAt: number | null;
}

/** Observed invoice row (model `InvoiceSchema`). */
interface InvoiceRow {
  id: string;
  number: string | null;
  clientId: string | null;
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

/** Read the latest snapshot's `items[]` for a resource (never throws). */
async function readItems<T>(
  ctx: ReportCtx,
  resource: string,
): Promise<{ items: T[]; retrievedAt: string | null }> {
  const bytes = await ctx.dataRepository.getContent(
    ctx.modelType,
    ctx.modelId,
    resource,
  );
  return parseSnapshot<T>(bytes);
}

/** PII-FREE observed client state row for `clients.state.yaml` (§4). */
function clientStateRow(c: ClientRow): Record<string, unknown> {
  return {
    id: c.id,
    number: c.number,
    balance: c.balance,
    paidToDate: c.paidToDate,
    isDeleted: c.isDeleted ?? false,
    archivedAt: c.archivedAt,
  };
}

/** Observed project state row for `projects.state.yaml`. */
function projectStateRow(p: ProjectRow): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    name: p.name,
    clientId: p.clientId,
    taskRate: p.taskRate,
    budgetedHours: p.budgetedHours,
    dueDate: p.dueDate,
    isDeleted: p.isDeleted ?? false,
    archivedAt: p.archivedAt,
  };
}

/** Observed invoice state row for `invoices.state.yaml` (status observed-only, §7.5). */
function invoiceStateRow(inv: InvoiceRow): Record<string, unknown> {
  return {
    id: inv.id,
    number: inv.number,
    clientId: inv.clientId,
    status: inv.computedStatus ?? inv.statusLabel,
    amount: inv.amount,
    balance: inv.balance,
    paidToDate: inv.paidToDate,
    date: inv.date,
    dueDate: inv.dueDate,
    isDeleted: inv.isDeleted ?? false,
    archivedAt: inv.archivedAt,
  };
}

function fence(lang: string, body: string): string[] {
  return ["```" + lang, body.replace(/\n$/, ""), "```", ""];
}

export const report = {
  name: "@shrug/invoiceninja/snapshot",
  description:
    "Materialize live Invoice Ninja state (clients/projects/invoices over the declared scope) into canonical, committable *.state.yaml plus a round-trippable desired subset",
  scope: "model" as const,
  labels: ["invoiceninja", "snapshot-sync", "materialize"],
  execute: async (
    ctx: ReportCtx,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    // The triggering method (getClients) may have written scoped snapshots
    // (`clients--<scope>` etc.) so a pipeline's snapshots don't collide with
    // another workflow's bare-named ones. Read the SAME scope the method used;
    // absent (a plain getClients call) falls back to the historical bare names.
    const scope = typeof ctx.methodArgs?.scope === "string"
      ? ctx.methodArgs.scope
      : undefined;
    const sfx = scope ? `--${scope}` : "";
    const clients = await readItems<ClientRow>(ctx, `clients${sfx}`);
    const projects = await readItems<ProjectRow>(ctx, `projects${sfx}`);
    const invoices = await readItems<InvoiceRow>(ctx, `invoices${sfx}`);

    const at = clients.retrievedAt ?? projects.retrievedAt ??
      invoices.retrievedAt ?? new Date().toISOString();

    // An observed snapshot can carry the SAME entity more than once — the apply
    // workflow derives getClients' ids from one clientId per owning project, so a
    // client owning N projects is fetched N times and lands as N BYTE-IDENTICAL
    // rows in the `clients` snapshot. A materialized state file (and its
    // round-trip desired subset) must be ONE row per entity or the committed
    // *.state.yaml is non-deterministic and re-applying it looks like duplicate
    // declarations. Collapse only genuinely identical rows (first occurrence
    // wins) — two distinct rows that merely share an id (e.g. an active + a
    // soft-deleted record) are both preserved. The list-read snapshots
    // (projects/invoices) are already unique, so this is a no-op there; it only
    // defends the by-id fan-out feed.
    // WIR-1: the dedup key is `JSON.stringify(r)`, so this collapses ONLY
    // byte-identical rows. That is correct today because the row types
    // (ClientRow/ProjectRow/InvoiceRow) carry no per-fetch-varying field — but the
    // guarantee is an unchecked assumption: if a future field with per-fetch
    // variance (a fetch timestamp, a non-deterministically ordered array/object)
    // is ever added to a row, two logical duplicates would serialize differently,
    // survive this filter, and reintroduce exactly the non-determinism it exists
    // to prevent — silently, with no error. Keep row normalization deterministic.
    const dedupExact = <T>(rows: T[]): T[] => {
      const seen = new Set<string>();
      const out: T[] = [];
      for (const r of rows) {
        const key = JSON.stringify(r);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
      return out;
    };

    // Sort by number (stable, human-diffable) so re-materializing the same scope
    // yields byte-identical output — the whole point of a committed state file.
    const byNumber = <T extends { number: string | null }>(rows: T[]): T[] =>
      [...rows].sort((a, b) => (a.number ?? "").localeCompare(b.number ?? ""));

    const clientRows = byNumber(dedupExact(clients.items));
    const projectRows = byNumber(dedupExact(projects.items));
    const invoiceRows = byNumber(dedupExact(invoices.items));

    // ── observed *.state.yaml docs (canonical, PII-free clients) ──
    const clientsState = renderStateDoc(
      "clients",
      { clients: clientRows.map(clientStateRow) },
      at,
    );
    const projectsState = renderStateDoc(
      "projects",
      { projects: projectRows.map(projectStateRow) },
      at,
    );
    const invoicesState = renderStateDoc(
      "invoices",
      { invoices: invoiceRows.map(invoiceStateRow) },
      at,
    );

    // ── round-trippable DESIRED subset (§7.3) ──
    // Projects are low-PII → safe to render fully. Clients carry name/contacts
    // PII in the round-trip subset (name is required by upsertClient), so they
    // are rendered under an explicit PII warning; a human decides whether to
    // commit them into reconcile/clients.yaml.
    const desiredProjects = canonicalizeYaml({
      projects: projectRows
        .filter((p) => p.isDeleted !== true)
        .map((p) => toDesiredProject(p)),
    });
    const desiredClients = canonicalizeYaml({
      clients: clientRows
        .filter((c) => c.isDeleted !== true)
        .map((c) => toDesiredClient(c)),
    });

    const markdown = [
      "# Snapshot — materialize IN → committable YAML",
      "",
      `Declared scope: **${clientRows.length}** client(s) · **${projectRows.length}** project(s) · **${invoiceRows.length}** invoice(s). Observed at ${at}.`,
      "",
      "## `reconcile/clients.state.yaml` (observed — PII-free, DO NOT EDIT)",
      "",
      ...fence("yaml", clientsState),
      "## `reconcile/projects.state.yaml` (observed, DO NOT EDIT)",
      "",
      ...fence("yaml", projectsState),
      "## `reconcile/invoices.state.yaml` (observed, DO NOT EDIT)",
      "",
      ...fence("yaml", invoicesState),
      "## Desired round-trip subset — `reconcile/projects.yaml` (low-PII)",
      "",
      "Equal to what `apply` re-applies as an all-skip no-op (§7.3).",
      "",
      ...fence("yaml", desiredProjects),
      "## Desired round-trip subset — `reconcile/clients.yaml` (⚠️ carries client NAME/contact PII)",
      "",
      "> Only commit this into `reconcile/clients.yaml` if you accept tracking client name/contact data in git. The `*.state.yaml` above is PII-free.",
      "",
      ...fence("yaml", desiredClients),
    ].join("\n");

    return {
      markdown,
      json: {
        scope: {
          clients: clientRows.length,
          projects: projectRows.length,
          invoices: invoiceRows.length,
        },
        retrievedAt: at,
        state: {
          clients: clientsState,
          projects: projectsState,
          invoices: invoicesState,
        },
        desired: {
          clients: desiredClients,
          projects: desiredProjects,
        },
      },
    };
  },
};
