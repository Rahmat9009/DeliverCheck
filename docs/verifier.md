# DeliverCheck Independent Evidence Verifier

## Overview

The DeliverCheck Independent Evidence Verifier (`src/verify/verifier.ts`) is an isolated, authoritative verification engine. Its purpose is to independently audit candidate repairs and result envelopes against explicit requests, target schemas, and declared change evidence.

The verifier enforces strict safety invariants without trusting outputs from repair models or upstream/downstream callers.

---

## Key Safety Invariants

1. **Exact schema validation without mutation or coercion**:
   Target schemas are compiled using Ajv 2020 in strict mode with `coerceTypes: false`, `useDefaults: false`, and `removeAdditional: false`. No property is coerced, no default value is inserted, and no additional property is silently removed.
2. **Immutable inputs**:
   Neither the candidate payload nor the target schema is ever mutated. Inputs are deep-frozen or verified with pre/post-validation snapshots.
3. **Canonical cryptographic hashing (RFC 8785)**:
   - `original_hash`: SHA-256 of the exact UTF-8 bytes of `source_text`.
   - `schema_hash`: SHA-256 of the RFC 8785 JSON Canonicalization Scheme (JCS) representation of `target_schema`.
   - `candidate_hash`: SHA-256 of the RFC 8785 canonical representation of `candidate`.
   - Hashes are invariant under key reordering in schemas or candidate objects.
4. **Change evidence audit**:
   - RFC 6901 JSON pointer traversal resolves exact paths.
   - Verifies that every declared change matches actual `before` and `after` values.
   - Detects and flags any **undeclared changes** introduced into candidate payloads.
   - Detects and flags **spurious declared changes** where no actual modification occurred.
   - Validates that `rule_indexes` reference valid rules within `request.explicit_rules`.
5. **No claim of factual truth**:
   All checks strictly set `proves_factual_truth: false`. Passing schema, syntax, or cryptographic checks proves only structural and rule conformance, never real-world factual veracity.
6. **Prompt-like text containment**:
   Prompt injection payloads (e.g. system override instructions) inside JSON string values are treated strictly as passive, untrusted data literals.

---

## Security & Resource Guardrails

The verifier incorporates defenses against adversarial vectors (`src/verify/security.ts`):

| Threat Vector | Mitigation Strategy |
| :--- | :--- |
| **Prototype Pollution** | Scans objects for dangerous keys (`__proto__`, `constructor`, `prototype`). Inspects object prototype inheritance chain (`Object.getPrototypeOf`) to reject hijacked prototypes before Ajv compilation or traversal. |
| **Remote Schema References (SSRF)** | Rejects target schemas containing remote `$ref` URIs (e.g. `http://`, `https://`, `ftp://`, `//`). Only internal document fragments (e.g. `#/$defs/...`) are permitted. |
| **Depth Bombs / Stack Overflow** | Rejects payloads and schemas exceeding the bounded nesting depth limit (default: 32). |
| **Schema Complexity / DoS** | Enforces maximum limits on schema AST node count (256) and reference count (64). |
| **Payload Size Inflation** | Enforces maximum byte size limit on `source_text` (default: 1 MB). |
| **Execution Timeout** | Executes verification under execution timeout guards (default: 1000ms). |

---

## Machine-Readable Checks vs Frozen Contract

The verifier produces machine-readable checks containing:
- `name`: Check identifier.
- `method`: Algorithmic technique (e.g., `ajv_strict_validate`, `rfc8785_canonical_sha256`, `rfc6901_diff_audit`, `ast_inspection`).
- `outcome`: `"passed" | "failed" | "skipped"`.
- `diagnostic`: Machine-readable, deterministic explanation of the check.
- `evidence`: Human-readable summary formatted for contract output.
- `proves_factual_truth`: Constant `false`.

To remain 100% compliant with the frozen `contracts/result.schema.json`, `VerificationReport.checks` provides contract-compliant `VerificationCheck` objects (`name`, `status`, `evidence`, `proves_factual_truth: false`), while `VerificationReport.detailedChecks` provides the extended diagnostic structure for internal consumers.

---

## Adversarial Test Suites

Adversarial fixtures and tests live in `tests/security/fixtures/` and `tests/security/security.test.ts`:

1. **`ambiguity.json`**: Ambiguous date (`03/04/2026`) and currency symbol (`$`) without locale rules; correctly triggers `needs_information`.
2. **`leading_zeros.json`**: Preserves zero-padded identifiers (e.g. `"000123"`) against numerical coercion (e.g. `123`).
3. **`missing_facts.json`**: Mandatory unmentioned fields (e.g. `tax_id`); verifies repair cannot invent facts.
4. **`prototype_pollution.json`**: Vectors attempting `__proto__`, `constructor`, or `prototype` injection.
5. **`remote_references.json`**: Schemas with remote network `$ref` URIs attempting SSRF.
6. **`deep_objects.json`**: Deeply nested JSON tree exceeding maximum depth limits.
7. **`contradictory_rules.json`**: Conflicting requirements (e.g., currency must be QAR and USD).
8. **`prompt_injection.json`**: String values containing jailbreak directives attempting to force `passed_checks`.
9. **`undeclared_changes.json`**: Covert modifications outside declared `changes`.
10. **`candidate_hash_mismatch.json`**: Mismatched or forged candidate SHA-256 hashes.

---

## Held-Out Evaluation Suite

Located in `evaluation/cases/`, 12 isolated test cases with expected outcomes evaluate verification across diverse scenarios without exposing expected outputs to repair components:
- `case_01_valid_leading_zero_repair.json`
- `case_02_ambiguous_slash_date.json`
- `case_03_missing_postal_code.json`
- `case_04_undeclared_discount_tampering.json`
- `case_05_forged_candidate_hash.json`
- `case_06_prototype_pollution_payload.json`
- `case_07_unsupported_remote_schema_ref.json`
- `case_08_schema_depth_bomb.json`
- `case_09_prompt_injection_jailbreak.json`
- `case_10_contradictory_currency_rule.json`
- `case_11_invalid_json_source.json`
- `case_12_disallowed_additional_property.json`

---

## Analysis of Weaknesses in Frozen Contracts

During verifier implementation and security analysis, the following weaknesses were identified in `contracts/request.schema.json` and `contracts/result.schema.json`:

1. **Closed `check` Schema Precludes Structured Diagnostics**:
   In `contracts/result.schema.json`, `#/$defs/check` has `additionalProperties: false` with only `name`, `status`, `evidence`, and `proves_factual_truth: false`. It lacks structured properties for `method`, `diagnostic_details`, `rule_index`, or `error_code`. As a result, machine-readable diagnostic details must be serialized into unstructured strings within `evidence`.
2. **Missing Invariants for `needs_information` Candidates**:
   In `contracts/result.schema.json`, a result with `status: "needs_information"` is permitted to include a `candidate` property, but `candidate_hash` is not required when `candidate` is present (and vice versa). An incomplete or unapproved candidate could be supplied without cryptographic binding.
3. **Unconstrained Target Schema in Request Contract**:
   In `contracts/request.schema.json`, `target_schema` is typed loosely as `"type": "object"`. The request schema does not require compliance with JSON Schema Draft 2020-12, nor does it forbid remote `$ref` URIs or dangerous prototype property names. This shifts the entire burden of schema sanitation into runtime application logic.
4. **Unbounded `rule_indexes` Cross-Field References**:
   `change.rule_indexes` in `contracts/result.schema.json` requires array items to be non-negative integers (`minimum: 0`), but JSON Schema cannot enforce that these indexes are `< request.explicit_rules.length`. Without the independent verifier's bounds audit, results could cite non-existent rule indexes.
5. **Pattern-Only Validation for Cryptographic Hashes**:
   `original_hash`, `schema_hash`, and `candidate_hash` are validated only by regex (`^sha256:[a-f0-9]{64}$`). The schema cannot verify that `original_hash` actually matches the SHA-256 of `source_text` or that `candidate_hash` matches the RFC 8785 canonical representation of `candidate`. Cryptographic validity must be checked independently.
