/**
 * Unit tests for the `@shrug/invoiceninja/snapshot` (materialize) report.
 *
 * The report is pure rendering over the latest `clients`/`projects`/`invoices`
 * snapshots, so the seam is `ReportCtx.dataRepository.getContent`: each case
 * builds a ctx whose repo returns encoded `Snapshot` envelopes and asserts on the
 * rendered YAML / json. No network, no filesystem.
 *
 * Run: `~/.deno/bin/deno test -A extensions/reports/snapshot_test.ts`
 *
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./snapshot.ts";

function enc(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
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
function ctx(store: Record<string, Uint8Array | undefined>): any {
  return {
    scope: "model",
    modelType: null,
    modelId: "m1",
    executionStatus: "succeeded",
    dataRepository: {
      getContent: (_t: unknown, _id: string, name: string) =>
        Promise.resolve(store[name] ?? null),
    },
  };
}

// deno-lint-ignore no-explicit-any
function run(store: Record<string, Uint8Array | undefined>): Promise<any> {
  return report.execute(ctx(store));
}

const CLIENT = {
  id: "VWPe9rxaLy",
  number: "0007",
  name: "Confidential Client Co", // PII — must NOT reach the state file
  balance: 300,
  paidToDate: 270,
  contacts: [{ firstName: "Pat", lastName: "Doe", email: "pat@example.com" }],
  isDeleted: false,
  archivedAt: null,
};
const PROJECT = {
  id: "prj1",
  number: "P1",
  name: "Website",
  clientId: "VWPe9rxaLy",
  taskRate: 90,
  budgetedHours: 10,
  dueDate: "2026-12-01",
  isDeleted: false,
  archivedAt: null,
};
const INVOICE = {
  id: "inv1",
  number: "0073",
  clientId: "VWPe9rxaLy",
  statusLabel: "Sent",
  computedStatus: "Overdue",
  amount: 300,
  balance: 300,
  paidToDate: 0,
  date: "2025-09-22",
  dueDate: "2025-10-01",
  isDeleted: false,
  archivedAt: null,
};

Deno.test("materialize: clients.state.yaml is PII-free (no name / no contact email)", async () => {
  const out = await run({ clients: snap([CLIENT]) });
  const clientsState = out.json.state.clients as string;
  assertStringIncludes(clientsState, "number: \"0007\"");
  assertStringIncludes(clientsState, "id: VWPe9rxaLy");
  assertStringIncludes(clientsState, "balance: 300");
  // The PII must never appear in the committed observed state file.
  assert(!clientsState.includes("Confidential Client Co"));
  assert(!clientsState.includes("pat@example.com"));
  assertStringIncludes(clientsState, "DO NOT EDIT");
});

Deno.test("materialize: desired client subset carries name (round-trip) under a PII warning", async () => {
  const out = await run({ clients: snap([CLIENT]) });
  const desired = out.json.desired.clients as string;
  // The round-trip subset needs name (upsertClient requires it).
  assertStringIncludes(desired, "name: Confidential Client Co");
  assertStringIncludes(desired, "number: \"0007\"");
  assert(!desired.includes("balance")); // IN-derived excluded from desired
  // markdown carries the explicit PII warning banner around it.
  assertStringIncludes(out.markdown, "carries client NAME/contact PII");
});

Deno.test("materialize: projects state + desired render; invoice status observed-only", async () => {
  const out = await run({ projects: snap([PROJECT]), invoices: snap([INVOICE]) });
  const projState = out.json.state.projects as string;
  assertStringIncludes(projState, "number: P1");
  assertStringIncludes(projState, "clientId: VWPe9rxaLy");
  const desiredProj = out.json.desired.projects as string;
  assertStringIncludes(desiredProj, "budgetedHours: 10");
  const invState = out.json.state.invoices as string;
  // status is observed (computed), never fed back into a desired invoice.
  assertStringIncludes(invState, "status: Overdue");
  assertEquals(out.json.scope.invoices, 1);
});

Deno.test("materialize: reads scoped snapshots when methodArgs.scope is set [SCOPE-RPT]", async () => {
  // getClients wrote clients--snapshot-apply (etc.); the report must read the
  // SAME scope from methodArgs — never the bare names, which here hold DIFFERENT
  // (foreign) data belonging to another workflow.
  const store: Record<string, Uint8Array | undefined> = {
    "clients--snapshot-apply": snap([CLIENT]),
    "projects--snapshot-apply": snap([PROJECT]),
    "invoices--snapshot-apply": snap([INVOICE]),
    clients: snap([]),
    projects: snap([]),
    invoices: snap([]),
  };
  // deno-lint-ignore no-explicit-any
  const scopedCtx: any = {
    scope: "model",
    modelType: null,
    modelId: "m1",
    executionStatus: "succeeded",
    methodArgs: { scope: "snapshot-apply" },
    dataRepository: {
      getContent: (_t: unknown, _id: string, name: string) =>
        Promise.resolve(store[name] ?? null),
    },
  };
  // deno-lint-ignore no-explicit-any
  const out: any = await report.execute(scopedCtx);
  // Reads the SCOPED data (1/1/1), not the empty bare snapshots (0/0/0).
  assertEquals(out.json.scope, { clients: 1, projects: 1, invoices: 1 });
  assertStringIncludes(out.json.state.projects as string, "number: P1");
});

Deno.test("materialize: deterministic — same scope renders byte-identical", async () => {
  const a = await run({ clients: snap([CLIENT]) });
  const b = await run({ clients: snap([CLIENT]) });
  assertEquals(a.json.state.clients, b.json.state.clients);
  assertEquals(a.json.desired.clients, b.json.desired.clients);
});

Deno.test("materialize: soft-deleted client is excluded from the desired subset", async () => {
  const deleted = { ...CLIENT, number: "0099", isDeleted: true };
  const out = await run({ clients: snap([CLIENT, deleted]) });
  const desired = out.json.desired.clients as string;
  assert(!desired.includes("0099"));
  // ...but it still appears in the observed state file (observed = truth).
  assertStringIncludes(out.json.state.clients as string, "number: \"0099\"");
});

Deno.test("materialize: empty / missing snapshots degrade to empty scope, never throw", async () => {
  const out = await run({});
  assertEquals(out.json.scope, { clients: 0, projects: 0, invoices: 0 });
  assertStringIncludes(out.json.state.clients as string, "clients: []");
});
