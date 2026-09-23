/**
 * Unit tests for the `@shrug/invoiceninja/snapshot-drift` report.
 *
 * Workflow-scope: the seam is the run's `stepExecutions` + `dataRepository`. Each
 * case builds handles (named `clientSync` / `clients` / …) whose bytes are
 * encoded `*Sync` or list-snapshot envelopes, runs the report, and asserts the
 * verdict counts. No network, no filesystem.
 *
 * Run: `~/.deno/bin/deno test -A extensions/reports/snapshot_drift_test.ts`
 *
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./snapshot_drift.ts";

interface Handle {
  name: string;
  bytes: Uint8Array;
  status?: "succeeded" | "failed" | "skipped";
}
function enc(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}
function syncEnv(rows: unknown[], dryRun = true): Uint8Array {
  return enc({ scope: "apply", rows, dryRun });
}
function snap(items: unknown[]): Uint8Array {
  return enc({
    scope: "model",
    count: items.length,
    items,
    retrievedAt: "2026-09-10T00:00:00Z",
  });
}

// deno-lint-ignore no-explicit-any
function run(handles: Handle[]): Promise<any> {
  const store = new Map<string, Uint8Array>();
  const stepExecutions = handles.map((h, i) => {
    const modelId = `m${i}`;
    store.set(`${modelId}::${h.name}`, h.bytes);
    return {
      modelType: null,
      modelId,
      modelName: `model-${i}`,
      methodName: "run",
      status: h.status ?? "succeeded",
      dataHandles: [{ name: h.name }],
    };
  });
  const ctx = {
    scope: "workflow",
    workflowName: "invoiceninja-snapshot-apply",
    workflowStatus: "succeeded" as const,
    stepExecutions,
    dataRepository: {
      getContent: (_t: unknown, modelId: string, name: string) =>
        Promise.resolve(store.get(`${modelId}::${name}`) ?? null),
    },
  };
  return report.execute(ctx);
}

Deno.test("drift: would-create when declared client is absent in IN", async () => {
  const out = await run([
    {
      name: "clientSync",
      bytes: syncEnv([
        { dedupKey: "0007", action: "would-create", clientId: null },
      ]),
    },
    { name: "clients", bytes: snap([]) },
  ]);
  assertEquals(out.json.totals["would-create"], 1);
  assertEquals(out.json.totals["in-sync"], 0);
  assertEquals(out.json.inSync, false);
});

Deno.test("drift: in-sync when declared client already-exists and is observed", async () => {
  const out = await run([
    {
      name: "clientSync",
      bytes: syncEnv([
        { dedupKey: "0007", action: "skip", reason: "already-exists", clientId: "abc" },
      ]),
    },
    { name: "clients", bytes: snap([{ id: "abc", number: "0007", name: "X" }]) },
  ]);
  assertEquals(out.json.totals["in-sync"], 1);
  assertEquals(out.json.totals["would-create"], 0);
  assertEquals(out.json.totals["in-only"], 0);
});

Deno.test("drift: in-only when IN has a scoped entity the YAML doesn't declare", async () => {
  const out = await run([
    { name: "clientSync", bytes: syncEnv([]) },
    {
      name: "clients",
      bytes: snap([{ id: "zzz", number: "0099", name: "Undeclared" }]),
    },
  ]);
  assertEquals(out.json.totals["in-only"], 1);
  const clientRows = out.json.entities.client.rows;
  assertEquals(clientRows[0].verdict, "in-only");
  assertEquals(clientRows[0].observedId, "zzz");
});

Deno.test("drift: malformed declaration (blank-dedup-key) is bucketed as an error, not managed", async () => {
  const out = await run([
    {
      name: "clientSync",
      bytes: syncEnv([
        { dedupKey: "", action: "skip", reason: "blank-dedup-key", clientId: null },
        { dedupKey: "0007", action: "would-create", clientId: null },
      ]),
    },
    { name: "clients", bytes: snap([]) },
  ]);
  assertEquals(out.json.entities.client.declaredErrors, 1);
  assertEquals(out.json.totals["would-create"], 1);
  assertStringIncludes(out.markdown, "malformed");
});

Deno.test("drift: projects + invoices bucket independently via scoped resource names", async () => {
  const out = await run([
    {
      name: "projectSync--myscope",
      bytes: syncEnv([
        { dedupKey: "P1", action: "would-create", projectId: null, clientId: "c" },
      ]),
    },
    {
      name: "invoiceSync",
      bytes: syncEnv([
        { dedupKey: "0073", action: "skip", reason: "already-exists", clientId: "c" },
      ], false),
    },
    { name: "invoices", bytes: snap([{ id: "i1", number: "0073", clientId: "c" }]) },
  ]);
  assertEquals(out.json.entities.project.counts["would-create"], 1);
  assertEquals(out.json.entities.invoice.counts["in-sync"], 1);
  // a real (dryRun=false) invoice apply is surfaced
  assertEquals(out.json.appliedForReal.invoice, true);
  assertEquals(out.json.appliedForReal.project, false);
});

Deno.test("drift: no inputs → honest 'nothing to diff', never throws", async () => {
  const out = await run([]);
  assertEquals(out.json.inSync, false);
  assertStringIncludes(out.markdown, "No snapshot-sync inputs detected");
});

Deno.test("drift: clean all in-sync sets inSync=true", async () => {
  const out = await run([
    {
      name: "clientSync",
      bytes: syncEnv([
        { dedupKey: "0007", action: "skip", reason: "already-exists", clientId: "abc" },
      ]),
    },
    { name: "clients", bytes: snap([{ id: "abc", number: "0007" }]) },
  ]);
  assertEquals(out.json.inSync, true);
  assert(out.markdown.includes("In sync"));
});
