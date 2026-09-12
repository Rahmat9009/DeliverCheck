# Repair engine

This checkpoint adds `src/repair/**`: a deterministic, rule-driven engine that
turns rejected JSON into a schema-valid candidate without an LLM or external
API. It builds on the frozen contracts and `src/verify/validate.ts` from
checkpoint 1 and does not modify either.

`repairJson(request, options?)` in `src/repair/engine.ts` is the entry point.
It accepts a `DeliverCheckRequest` (already contract-valid — callers should
run `validateRequestContract` first) and returns a `DeliverCheckResult`.

## Pipeline

1. Parse `source_text` as JSON. Failure -> `cannot_repair` / `invalid_source_json`.
2. Scan the parsed document for reserved keys (`__proto__`, `constructor`,
   `prototype`). Any hit -> `cannot_repair` / `schema_violation`, citing the
   JSON pointer where the key was found. This is a hard security stop: the
   engine does not attempt repair on a document it does not trust.
3. Parse `explicit_rules` into **directives** (see grammar below) and detect
   contradictions (two rules requiring different constant values for the
   same field).
4. Reject any directive whose target is a reserved key (e.g. a rename into
   `__proto__`) the same way as step 2.
5. Deep-clone the parsed source into a fresh candidate. The original parsed
   document, and the caller's `request` object, are never mutated.
6. Apply structural directives (rename, move) to the candidate.
7. For a flat top-level object schema, walk `target_schema.properties`. A
   field that already validates is left untouched. A field that doesn't is
   offered to `findRepairStrategy`, which tries directive-backed
   transformations in a fixed order (below) and accepts the first one that
   produces a schema-valid value. If none applies, the failure is classified
   as `missing_fact` (absent + required), one of the three ambiguity codes,
   or a generic `schema_violation`.
8. If nothing is unresolved, the whole candidate is validated once more with
   `validateCandidate` (reused, unmodified, from `src/verify/validate.ts`) as
   a final gate — this is what catches `additionalProperties` and other
   whole-document constraints the per-field pass does not check.
9. Every recorded change and unresolved issue carries the deterministic
   evidence the contract requires (`path`, `before`/`after`, `justification`,
   `rule_indexes`, or `code`/`message`/`path`).

## Status decision

Per `contracts/result.schema.json`, if *any* unresolved issue carries one of
`ambiguous_date`, `ambiguous_number`, `ambiguous_currency`,
`contradictory_requirements`, or `missing_fact`, the result **must** be
`needs_information` — even if other, cannot-repair-flavored issues (e.g. a
budget overrun) were also collected in the same run. Only when none of those
codes are present, and at least one issue remains, is the result
`cannot_repair`. `repairJson` mirrors this exactly: it collects every issue
it finds before deciding status, rather than returning on the first problem
(the only exceptions are the two security-boundary stops above and a
malformed `source_text`, which make any further analysis meaningless).

`needs_information` and `cannot_repair` results never carry a `candidate`
in this implementation, even when a partial repair was in progress —
simpler to reason about, and consistent with the checkpoint-1 fixtures.

## Rule grammar

`explicit_rules` is a frozen `string[]` — free text, not structured data.
Rather than guess at prose with an LLM, this checkpoint recognizes a small,
literal, case-insensitive grammar. A rule that matches becomes a directive
tied to its rule index (so every resulting change can cite `rule_indexes`,
which the contract requires); text that matches nothing is inert supporting
context — it never blocks a rule from existing, but it also never triggers a
transformation.

| Intent | Example | Directive |
| --- | --- | --- |
| Rename | `Rename field "name" to "full_name".` | rename |
| Move | `Move "/address/zip" to "/zip".` | move |
| Enum normalization | `Normalize "status" value "done" to "complete".` | enum_normalize |
| Whitespace trim | `Trim whitespace from "code".` / `... from all fields.` | trim_whitespace |
| Leading-zero identifier | `invoice_id is a six-character identifier and meaningful leading zeros must be preserved.` (must both say "leading zero(s)" and name a known schema field) | identifier_preserve |
| Constant requirement | `currency must be QAR.` | constant_requirement |
| Date order | `Dates in "delivery_date" use the format DD/MM/YYYY.` (or `Dates use the format ...` for all fields) | date_format |
| Decimal/thousands comma | `"," is the decimal separator for "amount".` / `... the thousands separator for ...` | number_separator |
| Currency symbol pin | `"$" means "USD" for "currency".` | currency_symbol |

Two `constant_requirement` directives for the same field with different
values are reported as `contradictory_requirements` and neither is applied.

## Supported transformations

Only these, and only when a matching directive exists **and** applying it
produces a value that validates against the field's subschema:

- **Rename** a top-level field (`remove` + `add` change pair).
- **Move** a field between JSON-pointer locations (`remove` + `add`), when
  the destination's parent object already exists (the engine never invents
  intermediate structure).
- **Zero-pad an identifier**: a number or all-digit string is padded to the
  exact length of a `^[0-9]{N}$` pattern, only when an `identifier_preserve`
  directive names that field. Padding is refused if the value already has
  more digits than the target length — the engine will not truncate.
- **Apply a constant requirement**: replaces an existing (non-conforming)
  value with the one unambiguous value a rule requires. This never creates a
  field that was absent — see "Never invents" below.
- **Enum-normalize** one named source value to one named target value.
- **Trim** leading/trailing whitespace, only when a rule explicitly permits
  it for that field or for all fields.
- **Reformat a slash-date** (`D/M/YYYY`) to ISO `YYYY-MM-DD`, only when a
  `date_format` rule states the day/month order for that field (or all
  fields).
- **Resolve a comma-grouped number** to plain digits or a decimal point,
  only when a rule states what the comma means for that field.
- **Map a currency symbol** to an ISO code, only when a rule pins that exact
  symbol to that exact code for that field.

## Safety invariants

- **Never invents missing values.** A required field that is absent from the
  source is always `missing_fact`, regardless of what the rules say it
  should be. Rules only transform values that already exist.
- **Never mutates the input.** The parsed source is deep-cloned before any
  directive runs; `request.source_text` and `request.target_schema` are read
  only.
- **Never silently deletes information.** Every change records both
  `before` and `after` (rename/move split into an explicit `remove`+`add`
  pair so the removed value stays on the record).
- **Preserves meaningful leading zeros**: numbers are only turned into
  padded ID strings under an explicit `identifier_preserve` directive, and
  never truncated to fit.
- **Rejects unsafe keys**: `__proto__`, `constructor`, `prototype` — in the
  source, or as a rule's rename/move target — abort the run.
- **Bounded work**: at most `MAX_CHANGE_OPERATIONS` (25) changes and the
  first `MAX_EXPLICIT_RULES` (200) rules are processed per run; exceeding
  the change budget reports `cannot_repair` / `schema_violation` rather than
  applying an unbounded number of edits.
- **Deterministic**: no randomness, no wall-clock-dependent logic other than
  `elapsed_ms` itself (which callers should not compare across runs). The
  same request, including with the same injected clock, always yields the
  same `status`, `changes`, `unresolved`, `candidate`, and hashes.

## Hashing

`original_hash` is `sha256:<hex>` over the exact UTF-8 bytes of
`source_text`. `schema_hash` and `candidate_hash` are `sha256:<hex>` over
RFC 8785 (JSON Canonicalization Scheme) bytes, implemented in
`src/repair/canonical-json.ts` for the subset of JSON `JSON.parse`/`JSON.stringify`
can ever produce (object keys sorted by UTF-16 code unit, array order
preserved, numbers/strings formatted the same way `JSON.stringify` already
does). `NaN`/`Infinity` are out of scope because parsed JSON cannot contain
them.

## Known limitations (by design, for this checkpoint)

- **Flat schemas only.** Field-level repair walks `target_schema.properties`
  one level deep (with limited recursion only for collecting field names
  used by the `identifier_preserve` rule matcher). Arrays and deeply nested
  objects are not repaired field-by-field; if the final whole-document
  validation still fails for such a schema, the result is `cannot_repair`
  rather than a guess.
- **No `$ref`/`$defs` resolution across properties.** Each field is validated
  by wrapping its own subschema in a minimal object schema; a subschema that
  `$ref`s into the parent document's `$defs` cannot be resolved in
  isolation and will surface as `invalid_target_schema` for that field.
- **Rename/move are top-level-first.** Rename only ever touches a top-level
  key. Move accepts arbitrary JSON pointers but will not create missing
  intermediate objects.
- **A `"<field> must be <phrase>."` sentence always parses as a constant
  requirement**, even if the phrase reads like description rather than a
  literal value (e.g. "code must be three uppercase letters."). This is
  harmless: the resulting value is only applied if it also passes schema
  validation, and it always cites its source rule either way.
- **Ambiguity detection is heuristic, not a full locale-aware parser.** Date
  ambiguity is limited to `D/M/YYYY`-shaped strings; number ambiguity to a
  single bare comma group; currency ambiguity to short non-alphanumeric (or
  a small set of known word) symbols. These cover the required categories
  without pretending to be exhaustive.
- **No LLM or external API.** All parsing and decision-making is pattern
  matching and JSON Schema validation over `src/verify/validate.ts`. This is
  intentional per the checkpoint scope — a later checkpoint may add a model
  in front of this deterministic core, never behind it.
