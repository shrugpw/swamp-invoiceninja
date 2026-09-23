/**
 * Pure canonical-serialization + semantic-diff core for the
 * `@shrug/invoiceninja` YAML <-> IN snapshot-sync surfaces
 * (design/invoiceninja-snapshot-sync.md).
 *
 * Two jobs, both PURE (no I/O, no clock, no throw on hostile input) so they are
 * exhaustively unit-testable and reused verbatim by the `snapshot` (materialize)
 * and `snapshot-drift` reports:
 *
 *  1. CANONICAL SERIALIZATION (§7.1) — {@link canonicalizeYaml} renders a value
 *     to deterministic YAML: object keys sorted ascending, numbers normalized,
 *     strings quoted only when a plain scalar would be ambiguous. Hand-authored
 *     `reconcile/*.yaml` never matches a rendered dump byte-for-byte (key order,
 *     float formatting, block scalars), so the observed `*.state.yaml` is emitted
 *     canonically and the DIFF is done SEMANTICALLY, never textually.
 *
 *  2. SEMANTIC DIFF (§5.2) — {@link classifyEntity} / {@link classifyScope} parse
 *     both sides into normalized objects and compare only the swamp-authoritative
 *     field subset (§2), returning the four-verdict classification
 *     (in-sync | would-create | in-only | diverged). Never a text compare.
 *
 * The client dedup key is `number` (§7.2): `upsertClients` dedups exclusively on
 * client `number`, and `apply` reuses that write path unchanged, so the desired
 * YAML must key on `number` too. These helpers therefore key every entity on
 * `number`.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Canonical scalar normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a number to a canonical, round-trippable string. Integers render
 * without a decimal point; other finite numbers use JS's shortest round-trip
 * form. A non-finite number (NaN/±Infinity) has no YAML scalar form, so it is
 * rendered as `null` — the emitter never produces `NaN`/`.inf` (which would not
 * re-parse to a number). PURE.
 */
export function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) return "null";
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

// A plain (unquoted) YAML scalar is only safe for a conservative charset that
// cannot be mis-read as a number, boolean, null, or a structural token, AND has
// no leading/trailing whitespace (a YAML parser strips it from a plain scalar,
// silently losing it — COR-2). The trailing char class excludes space so a value
// like "Bob " never round-trips as "Bob". Anything else is double-quoted
// (JSON.stringify → a valid YAML double-quoted scalar).
const SAFE_PLAIN = /^[A-Za-z](?:[A-Za-z0-9 _.\-@/]*[A-Za-z0-9_.\-@/])?$/;
// YAML 1.1 boolean / null literal tokens (any case) that must be quoted even
// though they match SAFE_PLAIN, or they re-parse as a boolean / null instead of
// a string (CANON-1). Compared case-insensitively so `Yes`/`ON`/`Off`/`No`/… are
// all caught, not just the lowercase forms.
const RESERVED_CI = new Set([
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "null",
]);

/**
 * Render a string as a canonical YAML scalar: a conservative plain scalar when
 * unambiguous, otherwise a double-quoted scalar (JSON escaping, so newlines
 * become `\n` and the value stays a single physical line — deterministic and
 * safe). PURE.
 */
export function canonicalString(s: string): string {
  if (s.length === 0) return '""';
  if (SAFE_PLAIN.test(s) && !RESERVED_CI.has(s.toLowerCase())) return s;
  // JSON.stringify yields a valid YAML flow double-quoted scalar with all the
  // necessary escapes (\", \\, \n, \t, control chars, unicode). YAML's
  // double-quoted style is a superset of JSON string syntax.
  return JSON.stringify(s);
}

/** Render a scalar (string | number | boolean | null | undefined) canonically. */
function canonicalScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return canonicalNumber(v);
  if (typeof v === "string") return canonicalString(v);
  // Any other type (symbol/function/bigint) is not representable — coerce to a
  // quoted string so the emitter never throws.
  return canonicalString(String(v));
}

// ---------------------------------------------------------------------------
// Canonical YAML emitter
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Emit `value` as canonical YAML lines at the given indent (2 spaces/level).
 * Maps: keys sorted ascending; empty map → `{}`. Arrays: `- ` per element;
 * empty array → `[]`. Nested maps/arrays under a key or a list item are placed
 * on following, further-indented lines. PURE, never throws.
 */
function emitLines(value: unknown, indent: number): string[] {
  const pad = "  ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const out: string[] = [];
    for (const el of value) {
      if (isPlainObject(el) || Array.isArray(el)) {
        const child = emitLines(el, indent + 1);
        if (child.length === 0) {
          out.push(`${pad}- ${Array.isArray(el) ? "[]" : "{}"}`);
          continue;
        }
        // Splice the "- " marker onto the child's first line.
        const first = child[0].slice((indent + 1) * 2);
        out.push(`${pad}- ${first}`);
        for (let i = 1; i < child.length; i++) out.push(child[i]);
      } else {
        out.push(`${pad}- ${canonicalScalar(el)}`);
      }
    }
    return out;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return [`${pad}{}`];
    const out: string[] = [];
    for (const k of keys) {
      const v = value[k];
      const keyStr = canonicalString(k);
      if (Array.isArray(v)) {
        if (v.length === 0) {
          out.push(`${pad}${keyStr}: []`);
        } else {
          out.push(`${pad}${keyStr}:`);
          // Block sequence indented one level under its key (canonical, matches
          // the hand-authored reconcile files' 2-space sequence indent).
          for (const line of emitLines(v, indent + 1)) out.push(line);
        }
      } else if (isPlainObject(v)) {
        if (Object.keys(v).length === 0) {
          out.push(`${pad}${keyStr}: {}`);
        } else {
          out.push(`${pad}${keyStr}:`);
          for (const line of emitLines(v, indent + 1)) out.push(line);
        }
      } else {
        out.push(`${pad}${keyStr}: ${canonicalScalar(v)}`);
      }
    }
    return out;
  }

  return [`${pad}${canonicalScalar(value)}`];
}

/**
 * Render a value to canonical YAML (trailing newline). Deterministic: the same
 * object always yields the same text, independent of key insertion order. PURE.
 */
export function canonicalizeYaml(value: unknown): string {
  return emitLines(value, 0).join("\n") + "\n";
}

/**
 * Wrap a canonical YAML body in a generated-file banner for a committed
 * `*.state.yaml` (observed side — DO NOT EDIT; never an `apply` input, §4). The
 * banner records what produced it and the observed-at stamp so a `git diff` is
 * self-describing.
 */
export function renderStateDoc(
  kind: string,
  body: unknown,
  retrievedAt: string,
): string {
  const header = [
    `# GENERATED by @shrug/invoiceninja/snapshot — observed IN state (${kind}).`,
    "# DO NOT EDIT and DO NOT feed to apply/upsert* — observed-only (§4).",
    `# Materialized at: ${canonicalString(retrievedAt)}`,
    "",
  ].join("\n");
  return header + canonicalizeYaml(body);
}

// ---------------------------------------------------------------------------
// Round-trip projections: observed normalized row -> desired-input subset (§7.3)
// ---------------------------------------------------------------------------

/** Drop null/undefined/empty-string entries so the desired subset is minimal. */
function pruneEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** Structural slice of an observed normalized client row (model `ClientSchema`). */
export interface ObservedClient {
  id: string;
  number: string | null;
  name: string | null;
  contacts?: Array<
    {
      firstName?: string | null;
      lastName?: string | null;
      email?: string | null;
    }
  >;
  [k: string]: unknown;
}

/**
 * Project an observed client to the round-trippable `ClientInput` subset: exactly
 * the swamp-authoritative fields `upsertClients` would re-apply as a no-op (§7.3).
 * Balances/paid state (IN-authoritative) are excluded. PURE.
 */
export function toDesiredClient(row: ObservedClient): Record<string, unknown> {
  const contacts = Array.isArray(row.contacts)
    ? row.contacts
      .map((c) =>
        pruneEmpty({
          firstName: c?.firstName ?? null,
          lastName: c?.lastName ?? null,
          email: c?.email ?? null,
        })
      )
      .filter((c) => Object.keys(c).length > 0)
    : [];
  return pruneEmpty({
    number: row.number,
    name: row.name,
    contacts,
  });
}

/** Structural slice of an observed normalized project row (model `ProjectSchema`). */
export interface ObservedProject {
  number: string | null;
  name: string | null;
  clientId: string | null;
  taskRate?: number | null;
  budgetedHours?: number | null;
  dueDate?: string | null;
  [k: string]: unknown;
}

/** Project an observed project to the round-trippable `ProjectInput` subset. PURE. */
export function toDesiredProject(
  row: ObservedProject,
): Record<string, unknown> {
  return pruneEmpty({
    number: row.number,
    name: row.name,
    clientId: row.clientId,
    taskRate: row.taskRate ?? null,
    budgetedHours: row.budgetedHours ?? null,
    dueDate: row.dueDate ?? null,
  });
}

// ---------------------------------------------------------------------------
// Semantic diff / classification (§5.2)
// ---------------------------------------------------------------------------

/** The four drift verdicts (design §5.2). */
export type DriftVerdict = "in-sync" | "would-create" | "in-only" | "diverged";

/** One classified entity. */
export interface DriftRow {
  /** Dedup key (`number`). */
  key: string;
  verdict: DriftVerdict;
  /** For `diverged`: the swamp-authoritative fields whose values differ. */
  changedFields: string[];
  /** Observed IN id when the entity exists (else null). */
  observedId: string | null;
}

/** Normalize a value for a stable field-equality compare (semantic, not textual). */
function normValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(normValue);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = normValue(v[k]);
    return out;
  }
  return v;
}

/** Deep semantic equality after normalization (order-stable for objects). */
export function semanticEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normValue(a)) === JSON.stringify(normValue(b));
}

/**
 * Classify ONE entity given its desired object (from `reconcile/*.yaml`) and its
 * observed object (from a read snapshot), comparing only `authoritativeFields`
 * (§2 swamp-authoritative subset). PURE.
 *
 *  - desired present, observed absent → `would-create`
 *  - observed present, desired absent → `in-only`
 *  - both present, every authoritative field equal → `in-sync`
 *  - both present, some authoritative field differs → `diverged`
 *
 * A field ABSENT from the desired object is not compared (a desired subset only
 * declares what it manages; an unset field is not a divergence). A field present
 * in desired but absent/null in observed IS a divergence.
 */
export function classifyEntity(
  key: string,
  desired: Record<string, unknown> | null,
  observed: (Record<string, unknown> & { id?: string | null }) | null,
  authoritativeFields: string[],
): DriftRow {
  const observedId = observed
    ? (typeof observed.id === "string" ? observed.id : null)
    : null;
  if (desired && !observed) {
    return { key, verdict: "would-create", changedFields: [], observedId };
  }
  if (!desired && observed) {
    return { key, verdict: "in-only", changedFields: [], observedId };
  }
  if (!desired && !observed) {
    // Neither side has it — not a real entity; treat as in-only-of-nothing.
    return { key, verdict: "in-only", changedFields: [], observedId };
  }
  const d = desired as Record<string, unknown>;
  const o = observed as Record<string, unknown>;
  const changed: string[] = [];
  for (const f of authoritativeFields) {
    // Only compare a field the desired side actually declares.
    if (!Object.hasOwn(d, f)) continue;
    if (!semanticEqual(d[f], o[f])) changed.push(f);
  }
  return {
    key,
    verdict: changed.length === 0 ? "in-sync" : "diverged",
    changedFields: changed,
    observedId,
  };
}

/** Read a `number`-like dedup key off a row (prototype-safe). */
function keyOf(row: Record<string, unknown>): string | null {
  if (!isPlainObject(row)) return null;
  const n = row.number;
  if (typeof n === "string" && n.trim() !== "") return n.trim();
  if (typeof n === "number" && Number.isFinite(n)) return String(n);
  return null;
}

/**
 * Classify a whole managed scope: join desired[] and observed[] on the `number`
 * dedup key (§7.2) and classify each. Rows on either side with a blank/absent
 * `number` are collected in `unkeyed` (they cannot be diffed — never silently
 * matched). PURE. `authoritativeFields` is the §2 subset for this entity type.
 */
export function classifyScope(
  desired: Array<Record<string, unknown>>,
  observed: Array<Record<string, unknown>>,
  authoritativeFields: string[],
): { rows: DriftRow[]; unkeyed: { desired: number; observed: number } } {
  const desiredByKey = new Map<string, Record<string, unknown>>();
  const observedByKey = new Map<string, Record<string, unknown>>();
  let unkeyedDesired = 0;
  let unkeyedObserved = 0;

  for (const d of desired) {
    const k = keyOf(d);
    if (k === null) {
      unkeyedDesired++;
      continue;
    }
    // First declaration wins (a repeated number in the desired file is a
    // caller error; do not let the later one mask it). Canonicalize the `number`
    // field to the string dedup key so a numeric-vs-string authored number
    // (e.g. `0078` parsed as int 78 vs `"78"`) never reads as a false divergence
    // of the very field the join matched on.
    if (!desiredByKey.has(k)) desiredByKey.set(k, { ...d, number: k });
  }
  for (const o of observed) {
    const k = keyOf(o);
    if (k === null) {
      unkeyedObserved++;
      continue;
    }
    if (!observedByKey.has(k)) observedByKey.set(k, { ...o, number: k });
  }

  const keys = new Set<string>([
    ...desiredByKey.keys(),
    ...observedByKey.keys(),
  ]);
  const rows: DriftRow[] = [];
  for (const k of [...keys].sort()) {
    rows.push(
      classifyEntity(
        k,
        desiredByKey.get(k) ?? null,
        (observedByKey.get(k) ?? null) as
          | (Record<string, unknown> & { id?: string | null })
          | null,
        authoritativeFields,
      ),
    );
  }
  return {
    rows,
    unkeyed: { desired: unkeyedDesired, observed: unkeyedObserved },
  };
}

/** The §2 swamp-authoritative field sets, by entity type. */
export const AUTHORITATIVE_FIELDS = {
  client: ["number", "name", "idNumber", "contacts"],
  project: [
    "number",
    "name",
    "clientId",
    "taskRate",
    "budgetedHours",
    "dueDate",
  ],
  invoice: [
    "number",
    "clientId",
    "date",
    "dueDate",
    "lineItems",
    "publicNotes",
  ],
} as const;
