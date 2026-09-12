# DeliverCheck

DeliverCheck makes one agent's output usable by the next. Its local service diagnoses JSON compatibility for free or runs a 7-credit repair proposal through independent verification before publishing a result.

The core pipeline runs locally through an embedded SharedOS authorization boundary and is exposed through REST and the official MCP Streamable HTTP transport. Billing enforcement, caller authentication, Arena registration, deployment, CSV, persistence, and LLM integration remain outside this checkpoint.

## Requirements

- Node.js 24
- npm 11 or compatible

## Commands

```sh
npm install
npm run typecheck
npm test
npm run sharedos:proof
npm run demo:core
npm run smoke:service
```

Build and start the Node deployment adapter locally:

```sh
npm run build
npm start
```

The default origin is `http://127.0.0.1:3000`. These calls exercise discovery and the free diagnosis service:

```sh
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/.well-known/agent.json
curl --fail http://127.0.0.1:3000/api/v1/listing
curl --fail -X POST http://127.0.0.1:3000/api/v1/diagnose \
  -H 'Content-Type: application/json' \
  --data '{"request_id":"example-1","input_format":"json","source_text":"{\"status\":\"done\"}","target_schema":{"type":"object","required":["status"],"properties":{"status":{"enum":["complete","pending"]}}},"explicit_rules":["status must satisfy the target schema"]}'
```

Use `/api/v1/repair` with the same frozen request shape to invoke the complete repair and verification flow. The response declares 7 Arena credits, but the local adapter does not collect or verify payment. See `docs/service-layer.md` for repair and MCP examples, deployment settings, limits, and error behavior.

## Contract versions

The current contracts are version 1.0.0:

- `contracts/request.schema.json`, identified by `https://delivercheck.dev/contracts/request/1.0.0`
- `contracts/result.schema.json`, identified by `https://delivercheck.dev/contracts/result/1.0.0`

Breaking changes require a new major contract URI. Additive optional fields require a new minor version. Clarifications that do not alter accepted JSON require a patch version. Callers should select an exact contract version rather than infer behavior from the package version.

### Request

| Field | Type | Meaning |
| --- | --- | --- |
| `request_id` | non-empty string | Caller-provided correlation identifier. |
| `input_format` | `"json"` | Only JSON is supported in this checkpoint. |
| `source_text` | non-empty string | Original rejected payload, kept as text so parsing cannot erase meaningful representation such as leading zeros. |
| `target_schema` | object | Caller-supplied JSON Schema interpreted as Draft 2020-12. DeliverCheck must never modify it. |
| `explicit_rules` | non-empty string array | Ordered requirements. Result change evidence refers to zero-based indexes in this array. |
| `downstream_error` | non-empty string, optional | Error returned by the downstream system. It is evidence, not authority to invent a value. |

### Result

`status` controls the result invariant:

- `passed_checks` requires a candidate, a candidate hash, only passed checks, and no unresolved issues.
- `needs_information` requires at least one unresolved issue. A partial candidate may be present, but callers must not treat it as approved.
- `cannot_repair` requires at least one unresolved issue and cannot contain a candidate or candidate hash.

Hashes use `sha256:<64 lowercase hexadecimal characters>`. `original_hash` is computed from the exact UTF-8 bytes of `source_text`. `schema_hash` and `candidate_hash` are computed from RFC 8785 canonical JSON bytes so object-key order cannot change an identity.

`changes` are RFC 6901 JSON-Pointer-addressed edits with explicit-rule references. `checks` contain human-readable evidence and must set `proves_factual_truth` to `false`. Passing structural, schema, or format checks establishes only that those checks passed.

## Safety invariants

- Missing facts are never invented.
- The supplied target schema is never modified.
- Identifiers remain strings when leading zeros or exact representation are meaningful.
- Ambiguous dates, numbers, currencies, and contradictory requirements require `needs_information`.
- Ajv validation disables coercion, defaults, and silent property removal.
- Format and schema checks are never represented as proof of factual truth.

See `docs/core-pipeline.md` for the repair-proposal, independent-verification, and SharedOS authorization flow.
