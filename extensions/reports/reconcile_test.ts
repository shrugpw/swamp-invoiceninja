/**
 * Unit tests for the `@shrug/invoiceninja/reconcile` WORKFLOW-scope report
 * (Phase 3, the money-path "am I caught up?" report).
 *
 * The seam is the workflow report context: each case hand-builds
 * `stepExecutions` (one succeeded step per input handle) plus a fake
 * `dataRepository.getContent` keyed by (modelId, name) that returns encoded
 * bytes — an expenseSync envelope, a BankTxn list snapshot, or an IN `expenses`
 * list snapshot. Inputs are detected STRUCTURALLY (RECON-003), so the tests
 * exercise the shape sniffers, the gap/mismatch/duplicate classification, the
 * RECON-002 blank-key guards, SUM-3 per-currency isolation, dryRun, the
 * no-data degradation, and null-counterparty + mdCell escaping. No network, no
 * filesystem.
 *
 * Run with: `~/.swamp/deno/deno test -A extensions/reports/reconcile_test.ts`
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { report } from "./reconcile.ts";

interface Handle {
  name: string;
  bytes: Uint8Array;
  status?: "succeeded" | "failed" | "skipped";
}

function enc(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/** A list-snapshot envelope (BankTxn or expenses): parseSnapshot reads `items`. */
function snapshot(items: unknown[]): Uint8Array {
  return enc({
    scope: "model",
    count: items.length,
    items,
    retrievedAt: "2026-07-16T00:00:00Z",
  });
}

/** An expenseSync envelope: `rows`, not `items`. */
function expenseSync(rows: unknown[], dryRun = false): Uint8Array {
  return enc({
    scope: "workflow",
    rows,
    dryRun,
    retrievedAt: "2026-07-16T00:00:00Z",
  });
}

/** A posted USD debit; override any field. */
function bt(p: Record<string, unknown> = {}) {
  return {
    id: "t1",
    source: "csv",
    postedDate: "2026-06-15",
    amount: 100,
    direction: "debit",
    currency: "USD",
    counterparty: "Acme",
    description: "svc",
    status: "posted",
    ...p,
  };
}

/** An expenseSync row. */
function syncRow(p: Record<string, unknown> = {}) {
  return {
    dedupKey: "t1",
    action: "created",
    expenseId: "exp-1",
    amount: 100,
    date: "2026-06-15",
    ...p,
  };
}

/** An IN expenses row (only id + customValue1 are read by the dup backstop). */
function inExpense(customValue1: string, id = "e") {
  return { id, customValue1 };
}

// deno-lint-ignore no-explicit-any
function ctxWith(handles: Handle[]): any {
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
  return {
    scope: "workflow",
    workflowName: "mercury-expense-sync",
    workflowStatus: "succeeded",
    stepExecutions,
    dataRepository: {
      getContent: (_t: unknown, modelId: string, name: string) =>
        Promise.resolve(store.get(`${modelId}::${name}`) ?? null),
    },
  };
}

// deno-lint-ignore no-explicit-any
async function run(handles: Handle[]): Promise<any> {
  return await report.execute(ctxWith(handles));
}

Deno.test("caught up: every posted debit is recorded with a matching amount", async () => {
  const out = await run([
    { name: "transactions", bytes: snapshot([bt({ id: "t1", amount: 100 })]) },
    {
      name: "expenseSync",
      bytes: expenseSync([syncRow({ dedupKey: "t1", amount: 100 })]),
    },
  ]);
  assertEquals(out.json.caughtUp, true);
  assertEquals(out.json.candidateDebits, 1);
  assertEquals(out.json.matched, 1);
  assertEquals(out.json.gap.count, 0);
  assertEquals(out.markdown.includes("✅ **Caught up.**"), true);
});

Deno.test("gap: a posted debit with no recorded key", async () => {
  const out = await run([
    { name: "transactions", bytes: snapshot([bt({ id: "t1", amount: 100 })]) },
    { name: "expenseSync", bytes: expenseSync([]) }, // present but empty
  ]);
  assertEquals(out.json.caughtUp, false);
  assertEquals(out.json.gap.count, 1);
  assertEquals(out.json.gap.byCurrency, { USD: 100 });
});

Deno.test("§6.1: an inter-account transfer is excluded from the gap, reported separately", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([
        bt({ id: "t1", amount: 100, counterparty: "Acme" }), // a real gap
        bt({
          id: "x1",
          amount: 5000,
          counterparty: "Summit Bank",
          kind: "externalTransfer",
          isTransfer: true,
        }),
      ]),
    },
    { name: "expenseSync", bytes: expenseSync([]) }, // nothing recorded yet
  ]);
  // The transfer is NOT a candidate/gap; only the real debit is.
  assertEquals(out.json.candidateDebits, 1);
  assertEquals(out.json.gap.count, 1);
  assertEquals(out.json.gap.byCurrency, { USD: 100 }); // transfer's 5000 excluded
  assertEquals(out.json.transfers.count, 1);
  assertEquals(out.json.transfers.byCurrency, { USD: 5000 });
  assertEquals(out.json.transfers.txns[0].kind, "externalTransfer");
  assertEquals(out.markdown.includes("Transfers excluded"), true);
});

Deno.test("owner-draw: an owner draw is excluded from the gap, reported in its own bucket", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([
        bt({ id: "t1", amount: 100, counterparty: "Acme" }), // a real gap
        bt({
          id: "d1",
          amount: 200,
          counterparty: "Riverside Market",
          isOwnerDraw: true,
        }),
      ]),
    },
    { name: "expenseSync", bytes: expenseSync([]) }, // nothing recorded yet
  ]);
  // The owner draw is NOT a candidate/gap; only the real debit is.
  assertEquals(out.json.candidateDebits, 1);
  assertEquals(out.json.gap.count, 1);
  assertEquals(out.json.gap.byCurrency, { USD: 100 }); // owner draw's 200 excluded
  assertEquals(out.json.ownerDraws.count, 1);
  assertEquals(out.json.ownerDraws.byCurrency, { USD: 200 });
  assertEquals(out.json.ownerDraws.txns[0].counterparty, "Riverside Market");
  assertEquals(out.markdown.includes("Owner draws excluded"), true);
});

Deno.test("owner-draw: an absent isOwnerDraw is null-guarded (pre-feature snapshot unchanged)", async () => {
  const legacy = bt({ id: "t1", amount: 100 });
  delete (legacy as Record<string, unknown>).isOwnerDraw; // pre-feature row
  const out = await run([
    { name: "transactions", bytes: snapshot([legacy]) },
    {
      name: "expenseSync",
      bytes: expenseSync([syncRow({ dedupKey: "t1", amount: 100 })]),
    },
  ]);
  assertEquals(out.json.caughtUp, true); // still a normal candidate, matched
  assertEquals(out.json.ownerDraws.count, 0);
});

Deno.test("owner-draw: a row flagged BOTH transfer and owner-draw is counted once (transfer wins)", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([
        bt({
          id: "b1",
          amount: 300,
          counterparty: "Ambiguous",
          kind: "internalTransfer",
          isTransfer: true,
          isOwnerDraw: true,
        }),
      ]),
    },
    { name: "expenseSync", bytes: expenseSync([]) },
  ]);
  // Transfer precedence: bucketed as a transfer, NOT double-counted as an owner draw.
  assertEquals(out.json.transfers.count, 1);
  assertEquals(out.json.ownerDraws.count, 0);
  assertEquals(out.json.gap.count, 0);
});

Deno.test("§6.1: an absent isTransfer is null-guarded (pre-feature snapshot reconciles unchanged)", async () => {
  const legacy = bt({ id: "t1", amount: 100 });
  delete (legacy as Record<string, unknown>).isTransfer; // pre-§6.1 row
  const out = await run([
    { name: "transactions", bytes: snapshot([legacy]) },
    {
      name: "expenseSync",
      bytes: expenseSync([syncRow({ dedupKey: "t1", amount: 100 })]),
    },
  ]);
  assertEquals(out.json.caughtUp, true); // still a normal candidate, matched
  assertEquals(out.json.transfers.count, 0);
});

Deno.test("§6.1: a CREDIT transfer is dropped entirely, not bucketed as a transfer (COR-2)", async () => {
  // A transfer IN is a credit — it was never a candidate expense, and it is NOT
  // part of the transfers-excluded audit bucket (that bucket is posted debits).
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([
        bt({ id: "c1", direction: "credit", amount: 389.71, isTransfer: true }),
        bt({ id: "t1", amount: 100 }),
      ]),
    },
    {
      name: "expenseSync",
      bytes: expenseSync([syncRow({ dedupKey: "t1", amount: 100 })]),
    },
  ]);
  assertEquals(out.json.transfers.count, 0); // credit transfer not bucketed
  assertEquals(out.json.candidateDebits, 1);
  assertEquals(out.json.caughtUp, true);
});

Deno.test("§6.1: a blank-id transfer is bucketed harmlessly, excluded from the gap (COR-2)", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([
        bt({
          id: "",
          amount: 5000,
          isTransfer: true,
          counterparty: "Summit Bank",
        }),
        bt({ id: "t1", amount: 100 }),
      ]),
    },
    { name: "expenseSync", bytes: expenseSync([]) },
  ]);
  // The blank-id transfer is a transfer (not an unreconcilable debit); only the
  // real debit is a gap.
  assertEquals(out.json.transfers.count, 1);
  assertEquals(out.json.unreconcilableDebits, 0);
  assertEquals(out.json.gap.count, 1);
});

Deno.test("mismatch (RECON-001): recorded amount differs, or is null", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([
        bt({ id: "t1", amount: 100 }),
        bt({ id: "t2", amount: 50 }),
      ]),
    },
    {
      name: "expenseSync",
      bytes: expenseSync([
        syncRow({ dedupKey: "t1", action: "created", amount: 105 }), // 5 off
        syncRow({ dedupKey: "t2", action: "skip", amount: null }), // null recorded
      ]),
    },
  ]);
  assertEquals(out.json.matched, 0);
  assertEquals(out.json.mismatch.length, 2);
  const t1 = out.json.mismatch.find((m: { id: string }) => m.id === "t1");
  assertEquals(t1.recordedAmount, 105);
  assertEquals(t1.sourceAmount, 100);
});

Deno.test("a sub-cent difference still matches (RECON-001 tolerance)", async () => {
  const out = await run([
    { name: "transactions", bytes: snapshot([bt({ id: "t1", amount: 100 })]) },
    {
      name: "expenseSync",
      bytes: expenseSync([syncRow({ dedupKey: "t1", amount: 100.005 })]),
    },
  ]);
  assertEquals(out.json.matched, 1);
  assertEquals(out.json.mismatch.length, 0);
});

Deno.test("a would-create row is a dry-run projection, NOT recorded → gap", async () => {
  const out = await run([
    { name: "transactions", bytes: snapshot([bt({ id: "t1", amount: 100 })]) },
    {
      name: "expenseSync",
      bytes: expenseSync(
        [syncRow({ dedupKey: "t1", action: "would-create" })],
        true,
      ),
    },
  ]);
  assertEquals(out.json.gap.count, 1);
  assertEquals(out.json.dryRun, true);
  assertEquals(out.markdown.includes("dryRun"), true);
});

Deno.test("duplicate via the authoritative IN expenses snapshot", async () => {
  const out = await run([
    { name: "transactions", bytes: snapshot([bt({ id: "t1", amount: 100 })]) },
    {
      name: "expenseSync",
      bytes: expenseSync([syncRow({ dedupKey: "t1", amount: 100 })]),
    },
    {
      name: "expenses",
      bytes: snapshot([inExpense("t1", "e1"), inExpense("t1", "e2")]), // t1 twice
    },
  ]);
  assertEquals(out.json.duplicates, [{
    key: "t1",
    count: 2,
    source: "in-expenses",
  }]);
});

Deno.test("duplicate falls back to expenseSync 'created' rows only when no expenses snapshot", async () => {
  const out = await run([
    { name: "transactions", bytes: snapshot([bt({ id: "t1", amount: 100 })]) },
    {
      name: "expenseSync",
      bytes: expenseSync([
        syncRow({ dedupKey: "t1", action: "created" }),
        syncRow({ dedupKey: "t1", action: "created" }), // created twice
      ]),
    },
  ]);
  assertEquals(out.json.duplicates, [
    { key: "t1", count: 2, source: "expenseSync-created" },
  ]);
});

Deno.test("in-expenses count is authoritative and not double-listed by the fallback", async () => {
  // When IN itself shows the duplicate, it is reported once via 'in-expenses';
  // the created-row fallback must not add a second row for the same key.
  const out = await run([
    { name: "transactions", bytes: snapshot([bt({ id: "t1", amount: 100 })]) },
    {
      name: "expenseSync",
      bytes: expenseSync([
        syncRow({ dedupKey: "t1", action: "created" }),
        syncRow({ dedupKey: "t1", action: "created" }),
      ]),
    },
    {
      name: "expenses",
      bytes: snapshot([inExpense("t1", "e1"), inExpense("t1", "e2")]), // IN shows 2
    },
  ]);
  assertEquals(out.json.duplicates, [
    { key: "t1", count: 2, source: "in-expenses" },
  ]);
});

Deno.test("RECON-002: blank-id posted debits and blank dedup keys are never reconciled", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([
        bt({ id: "", amount: 100 }),
        bt({ id: "t1", amount: 20 }),
      ]),
    },
    {
      name: "expenseSync",
      bytes: expenseSync([
        syncRow({ dedupKey: "", action: "created", amount: 100 }), // blank → ignored
        syncRow({ dedupKey: "t1", action: "created", amount: 20 }),
      ]),
    },
  ]);
  assertEquals(out.json.unreconcilableDebits, 1);
  assertEquals(out.json.candidateDebits, 1); // only t1
  assertEquals(out.json.matched, 1);
  assertEquals(out.json.caughtUp, false); // REC-2: unreconcilable money blocks ✅
  assertEquals(out.markdown.includes("blank id"), true);
});

Deno.test("SUM-3: gap totals are isolated per currency, never summed", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([
        bt({ id: "u1", amount: 100, currency: "USD" }),
        bt({ id: "e1", amount: 50, currency: "EUR" }),
      ]),
    },
    { name: "expenseSync", bytes: expenseSync([]) },
  ]);
  assertEquals(out.json.gap.byCurrency, { USD: 100, EUR: 50 });
});

Deno.test("only succeeded steps are read; a failed source step is ignored", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([bt({ id: "t1" })]),
      status: "failed",
    },
    { name: "expenseSync", bytes: expenseSync([syncRow()]) },
  ]);
  assertEquals(out.json.sawBankTxns, false);
  assertEquals(out.json.candidateDebits, 0);
});

Deno.test("no inputs → clear no-data notes, never throws", async () => {
  const out = await run([]);
  assertEquals(out.json.caughtUp, false);
  assertEquals(out.json.sawExpenseSync, false);
  assertEquals(out.json.sawBankTxns, false);
  assertEquals(out.markdown.includes("nothing to reconcile against yet"), true);
  assertEquals(out.markdown.includes("has not run in this workflow"), true);
});

Deno.test("REC-1: created-then-skip and skip-then-created classify identically (order-independent)", async () => {
  const txns = {
    name: "transactions",
    bytes: snapshot([bt({ id: "t1", amount: 100 })]),
  };
  const createdThenSkip = await run([
    txns,
    {
      name: "syncA",
      bytes: expenseSync([
        syncRow({ dedupKey: "t1", action: "created", amount: 100 }),
      ]),
    },
    {
      name: "syncB",
      bytes: expenseSync([
        syncRow({ dedupKey: "t1", action: "skip", amount: null }),
      ]),
    },
  ]);
  const skipThenCreated = await run([
    txns,
    {
      name: "syncB",
      bytes: expenseSync([
        syncRow({ dedupKey: "t1", action: "skip", amount: null }),
      ]),
    },
    {
      name: "syncA",
      bytes: expenseSync([
        syncRow({ dedupKey: "t1", action: "created", amount: 100 }),
      ]),
    },
  ]);
  // The null-amount 'skip' must never clobber the good 'created' amount either way.
  assertEquals(createdThenSkip.json.matched, 1);
  assertEquals(createdThenSkip.json.mismatch.length, 0);
  assertEquals(skipThenCreated.json.matched, 1);
  assertEquals(skipThenCreated.json.mismatch.length, 0);
});

Deno.test("REC-3: a pre-create (or empty) expenses snapshot does NOT hide a real double-create", async () => {
  const out = await run([
    { name: "transactions", bytes: snapshot([bt({ id: "t1", amount: 100 })]) },
    {
      name: "expenseSync",
      bytes: expenseSync([
        syncRow({ dedupKey: "t1", action: "created" }),
        syncRow({ dedupKey: "t1", action: "created" }), // genuine double-create this run
      ]),
    },
    { name: "expenses", bytes: snapshot([inExpense("t1", "e1")]) }, // stale: shows t1 once
  ]);
  // Union (not suppress): the created-row signal still flags the duplicate.
  assertEquals(out.json.duplicates, [
    { key: "t1", count: 2, source: "expenseSync-created" },
  ]);
});

Deno.test("REC-4a: a non-finite amount is unreconcilable, never silently matched", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([bt({ id: "t1", amount: "oops" })]), // hostile: non-numeric
    },
    {
      name: "expenseSync",
      bytes: expenseSync([syncRow({ dedupKey: "t1", amount: 100 })]),
    },
  ]);
  assertEquals(out.json.candidateDebits, 0);
  assertEquals(out.json.matched, 0);
  assertEquals(out.json.unreconcilableDebits, 1);
  assertEquals(out.json.caughtUp, false);
});

Deno.test("REC-SEC-1: a null row inside expenseSync.rows never throws", async () => {
  const bytes = enc({
    scope: "workflow",
    rows: [syncRow({ dedupKey: "t1", amount: 100 }), null, "garbage"],
    dryRun: false,
    retrievedAt: "2026-07-16T00:00:00Z",
  });
  const out = await run([
    { name: "transactions", bytes: snapshot([bt({ id: "t1", amount: 100 })]) },
    { name: "expenseSync", bytes },
  ]);
  assertEquals(out.json.matched, 1); // t1 still recorded; null/scalar rows skipped
});

Deno.test("REC-SEC-2: a non-string currency renders without throwing", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([bt({ id: "t1", amount: 100, currency: 5 })]), // hostile type
    },
    { name: "expenseSync", bytes: expenseSync([]) }, // → gap, renders the row
  ]);
  assertEquals(out.json.gap.count, 1); // no throw; row is rendered defensively
});

Deno.test("a null counterparty renders as — and a hostile one is escaped", async () => {
  const out = await run([
    {
      name: "transactions",
      bytes: snapshot([
        bt({ id: "t1", counterparty: null, amount: 100 }),
        bt({ id: "t2", counterparty: "A|B <script>", amount: 90 }),
      ]),
    },
    { name: "expenseSync", bytes: expenseSync([]) }, // both are gaps
  ]);
  const md = out.markdown;
  assertEquals(md.includes("| — |"), true); // null counterparty
  assertEquals(md.includes("A\\|B &lt;script&gt;"), true); // escaped
  assertEquals(md.includes("<script>"), false);
});
