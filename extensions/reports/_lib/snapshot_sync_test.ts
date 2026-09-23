/**
 * Unit tests for the pure canonical-serialization + semantic-diff core
 * (`snapshot_sync.ts`). No I/O, no clock — every case is deterministic.
 *
 * Run: `~/.deno/bin/deno test -A extensions/reports/_lib/snapshot_sync_test.ts`
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  AUTHORITATIVE_FIELDS,
  canonicalizeYaml,
  canonicalNumber,
  canonicalString,
  classifyEntity,
  classifyScope,
  type DriftRow,
  renderStateDoc,
  semanticEqual,
  toDesiredClient,
  toDesiredProject,
} from "./snapshot_sync.ts";

// ── canonicalNumber ────────────────────────────────────────────────────────
Deno.test("canonicalNumber: integers have no decimal point", () => {
  assertEquals(canonicalNumber(300), "300");
  assertEquals(canonicalNumber(0), "0");
  assertEquals(canonicalNumber(-30), "-30");
});
Deno.test("canonicalNumber: finite fractionals round-trip; non-finite → null", () => {
  assertEquals(canonicalNumber(-7.5), "-7.5");
  assertEquals(canonicalNumber(37.5), "37.5");
  assertEquals(canonicalNumber(NaN), "null");
  assertEquals(canonicalNumber(Infinity), "null");
});

// ── canonicalString ────────────────────────────────────────────────────────
Deno.test("canonicalString: safe plain scalars stay unquoted", () => {
  assertEquals(canonicalString("Upwork - Hourly"), "Upwork - Hourly");
  assertEquals(canonicalString("VWPe9rxaLy"), "VWPe9rxaLy");
  assertEquals(canonicalString("a@b.com"), "a@b.com");
});
Deno.test("canonicalString: ambiguous/reserved/number-like/empty are quoted", () => {
  assertEquals(canonicalString(""), '""');
  assertEquals(canonicalString("true"), '"true"');
  assertEquals(canonicalString("null"), '"null"');
  assertEquals(canonicalString("0073"), '"0073"'); // leading zero — must not become 73
  assertEquals(canonicalString("300"), '"300"'); // number-like — quote so it stays a string
  assertEquals(canonicalString("key: value"), '"key: value"');
  assertEquals(canonicalString("line1\nline2"), '"line1\\nline2"');
  // A unicode em-dash forces quoting and is escaped deterministically.
  assert(canonicalString("a — b").startsWith('"'));
});
Deno.test("canonicalString: CANON-1 — YAML 1.1 bool/null literals quoted in ANY case", () => {
  // A client literally named "No"/"On"/"Off"/"Yes" must NOT re-parse to a boolean.
  for (
    const w of ["Yes", "No", "On", "Off", "ON", "OFF", "yes", "Y", "n", "Null"]
  ) {
    assertEquals(canonicalString(w), JSON.stringify(w), `unquoted reserved: ${w}`);
  }
  // ...but a word that merely CONTAINS one is still a safe plain scalar.
  assertEquals(canonicalString("Norway"), "Norway");
  assertEquals(canonicalString("Yesenia"), "Yesenia");
});
Deno.test("canonicalString: COR-2 — leading/trailing whitespace forces quoting (no silent trim)", () => {
  assertEquals(canonicalString("Bob "), '"Bob "');
  assertEquals(canonicalString(" Bob"), '" Bob"');
  assertEquals(canonicalString("Bob  Smith"), "Bob  Smith"); // interior space stays plain
});

// ── canonicalizeYaml: determinism + key sorting ─────────────────────────────
Deno.test("canonicalizeYaml: object keys are sorted regardless of insertion order", () => {
  const a = canonicalizeYaml({ b: 1, a: 2, c: 3 });
  const b = canonicalizeYaml({ c: 3, a: 2, b: 1 });
  assertEquals(a, b);
  assertEquals(a, "a: 2\nb: 1\nc: 3\n");
});
Deno.test("canonicalizeYaml: nested maps and arrays of maps", () => {
  const y = canonicalizeYaml({
    number: "0001",
    contacts: [{ email: "a@b.com", firstName: "A" }],
    name: "Acme",
  });
  assertEquals(
    y,
    [
      'contacts:',
      '  - email: a@b.com',
      '    firstName: A',
      'name: Acme',
      'number: "0001"',
      '',
    ].join("\n"),
  );
});
Deno.test("canonicalizeYaml: empty collections and null/bool scalars", () => {
  assertEquals(
    canonicalizeYaml({
      contacts: [],
      meta: {},
      archivedAt: null,
      isDeleted: true,
      shouldBeInvoiced: false,
    }),
    "archivedAt: null\ncontacts: []\nisDeleted: true\nmeta: {}\nshouldBeInvoiced: false\n",
  );
});
Deno.test("canonicalizeYaml: YAML-reserved single-letter keys are quoted (safe)", () => {
  // `n`/`y`/`on`/`off` are YAML 1.1 booleans; quoting them as keys is the safe
  // canonical choice so a re-parse never coerces them.
  assertEquals(canonicalizeYaml({ n: 1 }), '"n": 1\n');
});
Deno.test("canonicalizeYaml: array of scalars", () => {
  assertEquals(canonicalizeYaml(["a", "b"]), "- a\n- b\n");
});
Deno.test("canonicalizeYaml: never throws on hostile input", () => {
  // deno-lint-ignore no-explicit-any
  const weird: any = { s: Symbol("x"), b: 10n };
  const out = canonicalizeYaml(weird);
  assert(out.length > 0);
});

// ── renderStateDoc ──────────────────────────────────────────────────────────
Deno.test("renderStateDoc: banner + canonical body, marked DO NOT EDIT", () => {
  const doc = renderStateDoc(
    "clients",
    { items: [{ number: "0001", id: "abc" }] },
    "2026-09-10T00:00:00Z",
  );
  assert(doc.includes("GENERATED by @shrug/invoiceninja/snapshot"));
  assert(doc.includes("DO NOT EDIT"));
  assert(doc.includes("clients"));
  // Body is canonical (sorted keys inside items).
  assert(doc.includes("- id: abc\n    number: \"0001\""));
});

// ── round-trip projections ──────────────────────────────────────────────────
Deno.test("toDesiredClient: keeps swamp-authoritative subset, drops IN-derived + empties", () => {
  const desired = toDesiredClient({
    id: "abc",
    number: "0001",
    name: "Acme",
    balance: 500,
    paidToDate: 100,
    contacts: [
      { firstName: "Ada", lastName: "L", email: "ada@x.com" },
      { firstName: null, lastName: null, email: null },
    ],
  });
  assertEquals(desired, {
    number: "0001",
    name: "Acme",
    contacts: [{ firstName: "Ada", lastName: "L", email: "ada@x.com" }],
  });
  // No IN-authoritative fields leak into the desired subset.
  assert(!("balance" in desired));
  assert(!("id" in desired));
});
Deno.test("toDesiredProject: prunes null numerics/dates", () => {
  assertEquals(
    toDesiredProject({
      number: "P1",
      name: "Proj",
      clientId: "cid",
      taskRate: null,
      budgetedHours: 10,
      dueDate: null,
    }),
    { number: "P1", name: "Proj", clientId: "cid", budgetedHours: 10 },
  );
});

// ── semanticEqual ───────────────────────────────────────────────────────────
Deno.test("semanticEqual: whitespace-trim, null≡'' , key-order-insensitive", () => {
  assert(semanticEqual("Acme ", "Acme"));
  assert(semanticEqual("", null));
  assert(semanticEqual(undefined, null));
  assert(semanticEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
  assert(!semanticEqual("Acme", "Acme Inc"));
  assert(!semanticEqual(300, 300.5));
});

// ── classifyEntity ──────────────────────────────────────────────────────────
const CF = AUTHORITATIVE_FIELDS.client as unknown as string[];

Deno.test("classifyEntity: would-create (desired, no observed)", () => {
  const r = classifyEntity("0001", { number: "0001", name: "Acme" }, null, CF);
  assertEquals(r.verdict, "would-create");
  assertEquals(r.observedId, null);
});
Deno.test("classifyEntity: in-only (observed, no desired)", () => {
  const r = classifyEntity("0001", null, { id: "abc", number: "0001" }, CF);
  assertEquals(r.verdict, "in-only");
  assertEquals(r.observedId, "abc");
});
Deno.test("classifyEntity: in-sync when authoritative fields match", () => {
  const r = classifyEntity(
    "0001",
    { number: "0001", name: "Acme" },
    { id: "abc", number: "0001", name: "Acme", balance: 999 },
    CF,
  );
  assertEquals(r.verdict, "in-sync");
  assertEquals(r.changedFields, []);
});
Deno.test("classifyEntity: diverged names the changed authoritative field only", () => {
  const r = classifyEntity(
    "0001",
    { number: "0001", name: "Acme Inc" },
    { id: "abc", number: "0001", name: "Acme", balance: 999 },
    CF,
  );
  assertEquals(r.verdict, "diverged");
  assertEquals(r.changedFields, ["name"]);
});
Deno.test("classifyEntity: a field absent from desired is not a divergence", () => {
  // desired declares only number; name differs but is not managed here.
  const r = classifyEntity(
    "0001",
    { number: "0001" },
    { id: "abc", number: "0001", name: "Whatever" },
    CF,
  );
  assertEquals(r.verdict, "in-sync");
});
Deno.test("classifyEntity: IN-derived balance never affects the verdict", () => {
  const r = classifyEntity(
    "0001",
    { number: "0001", name: "Acme" },
    { id: "abc", number: "0001", name: "Acme", balance: 12345, paidToDate: 1 },
    CF,
  );
  assertEquals(r.verdict, "in-sync");
});

// ── classifyScope ───────────────────────────────────────────────────────────
Deno.test("classifyScope: joins on number, sorts, buckets all four verdicts", () => {
  const desired = [
    { number: "0001", name: "Acme" }, // in-sync
    { number: "0002", name: "Beta Renamed" }, // diverged
    { number: "0003", name: "Gamma" }, // would-create
  ];
  const observed = [
    { id: "a", number: "0001", name: "Acme" },
    { id: "b", number: "0002", name: "Beta" },
    { id: "z", number: "0009", name: "Zeta" }, // in-only
  ];
  const { rows, unkeyed } = classifyScope(desired, observed, CF);
  const byKey = new Map(rows.map((r: DriftRow) => [r.key, r]));
  assertEquals(byKey.get("0001")!.verdict, "in-sync");
  assertEquals(byKey.get("0002")!.verdict, "diverged");
  assertEquals(byKey.get("0002")!.changedFields, ["name"]);
  assertEquals(byKey.get("0003")!.verdict, "would-create");
  assertEquals(byKey.get("0009")!.verdict, "in-only");
  assertEquals(byKey.get("0009")!.observedId, "z");
  assertEquals(unkeyed, { desired: 0, observed: 0 });
  // rows are key-sorted
  assertEquals(rows.map((r) => r.key), ["0001", "0002", "0003", "0009"]);
});
Deno.test("classifyScope: blank/absent number rows are counted, never matched", () => {
  const { rows, unkeyed } = classifyScope(
    [{ number: "", name: "no-key" }, { name: "missing-key" }],
    [{ id: "x", number: "  " }],
    CF,
  );
  assertEquals(rows, []);
  assertEquals(unkeyed, { desired: 2, observed: 1 });
});
Deno.test("classifyScope: numeric number key coerces to string (0078 vs 78 stay distinct as authored)", () => {
  const { rows } = classifyScope(
    [{ number: 78, name: "Num" }],
    [{ id: "n", number: "78", name: "Num" }],
    CF,
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].verdict, "in-sync");
});
