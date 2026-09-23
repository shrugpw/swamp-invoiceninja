/**
 * `@shrug/invoiceninja/snapshot-drift` — desired (tracked YAML) vs observed (IN).
 *
 * The plan/diff leg of snapshot-sync (design/invoiceninja-snapshot-sync.md §5.2).
 * Workflow-scope: it reads the run's own data handles and classifies each managed
 * entity per the §5.2 table:
 *
 *   | verdict       | meaning                                        |
 *   |---------------|------------------------------------------------|
 *   | in-sync       | declared + exists (an upsert `already-exists`) |
 *   | would-create  | declared, absent in IN (an upsert would-create)|
 *   | in-only       | observed in scope, not declared in the YAML    |
 *   | diverged      | declared + exists but a swamp-authoritative     |
 *   |               | field differs (V1: flagged; needs field data)  |
 *
 * DATA FLOW (§5.2): the desired side arrives as the `would-create` / `skip`
 * (already-exists) rows the `upsert*` methods emit in `dryRun` — sourced from the
 * tracked `reconcile/*.yaml` fed through the apply workflow, NOT an ad-hoc
 * `--input`. The observed side is the `clients` / `projects` / `invoices` read
 * snapshots. Classification is SEMANTIC (join on the `number` dedup key, §7.2 —
 * never a text diff), delegating the join/verdict to the pure, unit-tested
 * `classifyScope` helper.
 *
 * `diverged` requires comparing swamp-authoritative FIELD values. V1's `*Sync`
 * audit rows are deliberately PII-free (dedupKey = `number` + ids only), so
 * field-level divergence is NOT evaluated here; the pure `classifyEntity` helper
 * implements it and is exercised when a desired-field snapshot is available
 * (materialize round-trip / V2). This is the design's "V1 flags, V2 reconciles".
 *
 * Pure aggregation over run data — no API calls (repo rules 3 & 8). Detects its
 * inputs by resource name with a shape fallback, so a run missing an input
 * degrades to a clear "no data yet" rather than failing.
 *
 * @module
 */

import {
  type DataRepository,
  mdCell,
  parseSnapshot,
} from "./_lib/snapshots.ts";
import { classifyScope, type DriftRow } from "./_lib/snapshot_sync.ts";

/** One `*Sync` audit row (Client/Project/InvoiceSyncSchema). */
interface SyncRow {
  dedupKey: string;
  action: "skip" | "would-create" | "created";
  reason?: string;
  [k: string]: unknown;
}

interface SyncEnvelope {
  scope: string;
  rows: SyncRow[];
  dryRun: boolean;
}

/** One workflow step execution (structural slice of the workflow report ctx). */
interface StepExecution {
  modelType: unknown;
  modelId: string;
  modelName: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: Array<{ name: string; version?: number }>;
}

interface WorkflowReportCtx {
  scope: string;
  workflowName: string;
  workflowStatus: "succeeded" | "failed";
  dataRepository: DataRepository;
  stepExecutions: StepExecution[];
}

type Entity = "client" | "project" | "invoice";

/** Bucket a resource handle name to its entity + whether it is a sync or observed feed. */
function classifyHandle(
  name: string,
): { entity: Entity; kind: "sync" | "observed" } | null {
  const base = name.split("--")[0]; // strip scoped suffix (e.g. clientSync--foo)
  switch (base) {
    case "clientSync":
      return { entity: "client", kind: "sync" };
    case "projectSync":
      return { entity: "project", kind: "sync" };
    case "invoiceSync":
      return { entity: "invoice", kind: "sync" };
    case "clients":
      return { entity: "client", kind: "observed" };
    case "projects":
      return { entity: "project", kind: "observed" };
    case "invoices":
      return { entity: "invoice", kind: "observed" };
    default:
      return null;
  }
}

/** Structural check: does a parsed payload look like a `*Sync` envelope? */
function asSyncEnvelope(obj: unknown): SyncEnvelope | null {
  const o = obj as Record<string, unknown> | null;
  if (!o || !Array.isArray(o.rows) || typeof o.dryRun !== "boolean") {
    return null;
  }
  const r = o.rows[0] as Record<string, unknown> | undefined;
  if (
    o.rows.length > 0 &&
    (typeof r?.dedupKey !== "string" || !("action" in (r ?? {})))
  ) {
    return null;
  }
  return o as unknown as SyncEnvelope;
}

/**
 * Turn the `*Sync` rows for one entity into the DESIRED object list `classifyScope`
 * consumes. Each declared row contributes `{number}` (the tracked file's dedup
 * key). An already-exists `skip` and a `would-create`/`created` are all "declared";
 * an error `skip` (blank-dedup-key / invalid / in-batch-duplicate) is NOT a real
 * declaration and is collected separately.
 */
function desiredFromSync(
  rows: SyncRow[],
): {
  desired: Array<Record<string, unknown>>;
  errors: SyncRow[];
  wouldCreate: Set<string>;
} {
  const desired: Array<Record<string, unknown>> = [];
  const errors: SyncRow[] = [];
  const wouldCreate = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.action !== "string") continue;
    // An error skip (blank-dedup-key / invalid / in-batch-duplicate) is a
    // malformed declaration, not a managed entity — surfaced even when its key
    // is blank (that IS the defect).
    if (
      row.action === "skip" &&
      row.reason && row.reason !== "already-exists"
    ) {
      errors.push(row);
      continue;
    }
    if (typeof row.dedupKey !== "string" || row.dedupKey.trim() === "") {
      continue;
    }
    const key = row.dedupKey.trim();
    if (row.action === "would-create") wouldCreate.add(key);
    if (seen.has(key)) continue;
    seen.add(key);
    desired.push({ number: key });
  }
  return { desired, errors, wouldCreate };
}

export const report = {
  name: "@shrug/invoiceninja/snapshot-drift",
  description:
    "Classify each managed Invoice Ninja entity as in-sync / would-create / in-only / diverged by joining the tracked desired scope (upsert dryRun rows) against the observed read snapshots",
  scope: "workflow" as const,
  labels: ["invoiceninja", "snapshot-sync", "drift"],
  execute: async (
    ctx: WorkflowReportCtx,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const repo = ctx.dataRepository;

    // Collected per entity: sync rows (desired presence) + observed rows.
    const syncRows: Record<Entity, SyncRow[]> = {
      client: [],
      project: [],
      invoice: [],
    };
    const observed: Record<Entity, Array<Record<string, unknown>>> = {
      client: [],
      project: [],
      invoice: [],
    };
    const anyDryRunReal: Record<Entity, boolean> = {
      client: false,
      project: false,
      invoice: false,
    };
    const sawSync: Record<Entity, boolean> = {
      client: false,
      project: false,
      invoice: false,
    };
    const sawObserved: Record<Entity, boolean> = {
      client: false,
      project: false,
      invoice: false,
    };

    for (const step of ctx.stepExecutions) {
      if (step.status !== "succeeded") continue;
      for (const h of step.dataHandles) {
        const bucket = classifyHandle(h.name);
        if (!bucket) continue;
        const bytes = await repo.getContent(
          step.modelType,
          step.modelId,
          h.name,
          h.version,
        );
        if (!bytes || bytes.length === 0) continue;

        if (bucket.kind === "sync") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            continue;
          }
          const env = asSyncEnvelope(parsed);
          if (!env) continue;
          sawSync[bucket.entity] = true;
          if (env.dryRun === false) anyDryRunReal[bucket.entity] = true;
          for (const raw of env.rows ?? []) {
            if (raw && typeof raw === "object") {
              syncRows[bucket.entity].push(raw);
            }
          }
        } else {
          const { items } = parseSnapshot<Record<string, unknown>>(bytes);
          if (items.length > 0) sawObserved[bucket.entity] = true;
          for (const it of items) observed[bucket.entity].push(it);
        }
      }
    }

    // Classify each entity type via the pure semantic-join helper.
    const entities: Entity[] = ["client", "project", "invoice"];
    const perEntity: Record<string, {
      rows: DriftRow[];
      counts: Record<string, number>;
      declErrors: SyncRow[];
    }> = {};
    for (const e of entities) {
      const { desired, errors } = desiredFromSync(syncRows[e]);
      const { rows } = classifyScope(desired, observed[e], []);
      const counts: Record<string, number> = {
        "in-sync": 0,
        "would-create": 0,
        "in-only": 0,
        "diverged": 0,
      };
      for (const r of rows) counts[r.verdict]++;
      perEntity[e] = { rows, counts, declErrors: errors };
    }

    const grand = {
      "in-sync": 0,
      "would-create": 0,
      "in-only": 0,
      "diverged": 0,
    };
    for (const e of entities) {
      for (const k of Object.keys(grand) as Array<keyof typeof grand>) {
        grand[k] += perEntity[e].counts[k];
      }
    }
    const anyData = entities.some((e) => sawSync[e] || sawObserved[e]);
    const inSyncClean = anyData && grand["would-create"] === 0 &&
      grand["in-only"] === 0 && grand["diverged"] === 0;

    // ── notes ──
    const notes: string[] = [];
    for (const e of entities) {
      if (!sawSync[e]) {
        notes.push(
          `No \`${e}Sync\` output detected — run \`upsert${e[0].toUpperCase()}${
            e.slice(1)
          }s\` (dryRun) in the apply workflow so the desired \`reconcile\` scope is diffed.`,
        );
      }
      if (perEntity[e].declErrors.length > 0) {
        notes.push(
          `${
            perEntity[e].declErrors.length
          } declared ${e}(s) were skipped as malformed (blank/invalid dedup key) — fix the \`reconcile/${e}s.yaml\` before applying.`,
        );
      }
    }
    notes.push(
      "`diverged` (a swamp-authoritative field changed in IN vs the tracked YAML) is NOT evaluated in V1 — the PII-free `*Sync` rows carry only the `number` key. Field-level divergence is deferred to V2 (design §6); the pure `classifyEntity` helper implements it and is unit-tested.",
    );

    // ── markdown ──
    const section = (e: Entity): string[] => {
      const p = perEntity[e];
      if (p.rows.length === 0 && !sawSync[e] && !sawObserved[e]) return [];
      const title = e[0].toUpperCase() + e.slice(1);
      const rows = p.rows
        .filter((r) => r.verdict !== "in-sync") // in-sync is the boring majority
        .map((r) =>
          `| ${mdCell(r.key)} | ${r.verdict} | ${mdCell(r.observedId ?? "—")} |`
        );
      return [
        `## ${title}s — in-sync ${p.counts["in-sync"]} · would-create ${
          p.counts["would-create"]
        } · in-only ${p.counts["in-only"]} · diverged ${p.counts["diverged"]}`,
        "",
        ...(rows.length > 0
          ? [
            "| number | verdict | observed id |",
            "| --- | --- | --- |",
            ...rows,
            "",
          ]
          : ["_All declared entities are in-sync._", ""]),
      ];
    };

    const markdown = [
      "# Snapshot drift — desired (tracked YAML) vs observed (IN)",
      "",
      inSyncClean
        ? `✅ **In sync.** All declared entities exist in Invoice Ninja (in-sync: ${
          grand["in-sync"]
        }). No would-create, no in-only, no diverged.`
        : anyData
        ? `in-sync: **${grand["in-sync"]}** · would-create: **${
          grand["would-create"]
        }** · in-only: **${grand["in-only"]}** · diverged: **${
          grand["diverged"]
        }**.`
        : "No snapshot-sync inputs detected in this run yet — nothing to diff.",
      "",
      ...section("client"),
      ...section("project"),
      ...section("invoice"),
      ...notes.map((n) => `> ${n}`),
      "",
    ].join("\n");

    return {
      markdown,
      json: {
        workflow: ctx.workflowName,
        inSync: inSyncClean,
        totals: grand,
        appliedForReal: anyDryRunReal,
        entities: Object.fromEntries(
          entities.map((e) => [e, {
            counts: perEntity[e].counts,
            rows: perEntity[e].rows,
            declaredErrors: perEntity[e].declErrors.length,
            sawSync: sawSync[e],
            sawObserved: sawObserved[e],
          }]),
        ),
      },
    };
  },
};
