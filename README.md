# DeliverCheck

**Make one agent’s output usable by the next.**

DeliverCheck is an agent-callable JSON compatibility service built for the Shared OS Hackathon. Agent outputs often fail the next agent’s schema, explicit rules, or workflow even when the intended data is close. DeliverCheck diagnoses those incompatibilities or proposes a bounded deterministic repair, then gives a separate verifier final authority over the delivered result.

The public service is live at [delivercheck.vercel.app](https://delivercheck.vercel.app).

## Live interfaces

| Interface | URL | Price |
| --- | --- | ---: |
| Health | [GET /health](https://delivercheck.vercel.app/health) | — |
| Agent card | [GET /.well-known/agent.json](https://delivercheck.vercel.app/.well-known/agent.json) | — |
| Service listing | [GET /api/v1/listing](https://delivercheck.vercel.app/api/v1/listing) | — |
| REST diagnose | `POST https://delivercheck.vercel.app/api/v1/diagnose` | 0 Arena credits |
| REST repair | `POST https://delivercheck.vercel.app/api/v1/repair` | 7 Arena credits |
| MCP Streamable HTTP | `POST https://delivercheck.vercel.app/api/mcp` | Tool-specific |

The MCP endpoint exposes `diagnose` and `repair` with structured content. Prices are declared for discovery and client planning. Arena billing enforcement and payment verification remain external and pending organizer-confirmed SharedNet integration. A response that declares a price does not prove payment.

## Request and result

Both REST services and MCP tools accept the versioned request contract. This request performs a justified enum normalization:

```json
{
  "request_id": "readme-repair-1",
  "input_format": "json",
  "source_text": "{\"status\":\"done\"}",
  "target_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["status"],
    "properties": {
      "status": {
        "type": "string",
        "enum": ["complete", "pending"]
      }
    }
  },
  "explicit_rules": [
    "Normalize \"status\" value \"done\" to \"complete\"."
  ]
}
```

Send it to the repair endpoint:

```bash
curl --fail-with-body \
  -X POST https://delivercheck.vercel.app/api/v1/repair \
  -H 'Content-Type: application/json' \
  --data @request.json
```

A successful response has the following contract-valid machine-readable shape. The service normally returns additional independent check records.

```json
{
  "service": "repair",
  "result": {
    "job_id": "readme-repair-1",
    "status": "passed_checks",
    "candidate": { "status": "complete" },
    "changes": [
      {
        "path": "/status",
        "operation": "replace",
        "before": "done",
        "after": "complete",
        "justification": "Explicit rule 0 normalizes \"status\" value \"done\" to \"complete\".",
        "rule_indexes": [0]
      }
    ],
    "checks": [
      {
        "name": "candidate_schema_validation",
        "status": "passed",
        "evidence": "Candidate validates against target schema without coercion, defaults, or property removal.",
        "proves_factual_truth": false
      }
    ],
    "unresolved": [],
    "original_hash": "sha256:e378058155516106ec27571a247c0a3985759e505d4ab2351d638a9ac6ce7c25",
    "candidate_hash": "sha256:a1e73038b20b14c8814f26b22e8107c1b410db346c6736eea60480137a09109b",
    "schema_hash": "sha256:0c4e756ec863904e8c17041a386a580fcfd52f019017cd05920defeeb0bc6191",
    "elapsed_ms": 80,
    "implementation_version": "0.1.0"
  },
  "billing": {
    "price_credits": 7,
    "currency": "Arena credits",
    "enforcement": "external_pending_official_sharednet_confirmation",
    "payment_verified": false
  }
}
```

Use `/api/v1/diagnose` with the same request shape to validate without modifying the source. Diagnosis returns exact schema problems, a security rejection, or a valid outcome and always sets `proves_factual_truth` to `false`.

## Architecture

```text
request
  → coordinator
  → SharedOS-authorized bounded repair proposal
  → independent verifier
  → hash-bound DeliverCheck result
  → delivery
```

The repair stage can propose a candidate, declared changes, unresolved issues, and hashes. Its own success status has no authority to publish a verdict. The verifier independently checks the candidate, exact leaf differences, declarations, unresolved issues, schema validity, and canonical hashes. The coordinator publishes `passed_checks` only after verifier acceptance and binds delivery to the verified candidate hash.

SharedOS enforces deny-by-default, exact job-bound grants:

- `agent:repair.delivercheck` may write only that job’s candidate resource.
- `agent:verifier.delivercheck` may write only that job’s verdict resource.
- The repairer cannot publish verdicts, the verifier cannot modify candidates, and cross-job access is denied.

Run `npm run sharedos:proof` to exercise the real embedded kernel and produce sanitized allow/deny outcomes with authority hashes. This is local SharedOS enforcement; SharedOS Cloud audit ingestion is not configured or claimed.

## Evidence and ambiguity

Every accepted edit uses an RFC 6901 JSON Pointer, before/after evidence, a justification, and explicit-rule indexes. Original text, schema, and candidate identities use SHA-256; object values are canonicalized so key order cannot change their identity. The verifier rejects forged hashes, undeclared edits, and coarse declarations that hide unrelated leaf changes.

DeliverCheck never invents a missing fact. Ambiguous dates, numbers, currencies, or contradictory requirements produce `needs_information`. Meaningful leading zeros remain strings. Passing format and schema checks establishes compatibility with the supplied constraints; every public check keeps `proves_factual_truth: false`.

## Security model

DeliverCheck treats request bodies, schemas, explicit rules, headers, marketplace data, and caller identity claims as untrusted.

- Request bodies are limited to 64 KiB and at most 200 explicit rules.
- Calls require JSON content types, reject unexpected query parameters, and use a 240-second application deadline.
- Ajv uses no coercion, defaults, or silent property removal. Supported formats are `date`, `date-time`, `email`, and `uri`.
- Remote or cyclic `$ref`, root self-reference, `$dynamicRef`, `$recursiveRef`, unsafe JSON Pointer segments, and unsafe or excessive regular expressions are rejected.
- Schema depth, nodes, references, payloads, metadata, and subprocess output are bounded.
- The service performs no customer-directed URL fetching, arbitrary code execution, or shell execution.
- Public failures are sanitized; complete customer payloads, internal audit records, stacks, filesystem paths, and credentials are not logged or returned.
- Request bodies and untrusted headers never establish authenticated caller identity or widen SharedOS authority.

See [SECURITY.md](SECURITY.md) for reporting guidance and [docs/service-layer.md](docs/service-layer.md) for the detailed service threat model.

## Local quickstart

Node.js 24 is required.

```bash
git clone https://github.com/Rahmat9009/DeliverCheck.git
cd DeliverCheck
npm ci
npm run typecheck
npm test
npm run build
npm start
```

The local Node service listens on `http://127.0.0.1:3000` by default. `PUBLIC_BASE_URL`, `HOST`, `PORT`, and `ALLOWED_HOSTS` configure its public-origin and host checks. See [docs/service-layer.md](docs/service-layer.md) for REST and official MCP client examples.

## Verification

The public release is verified by 290 tests across 30 test files.

```bash
npm run typecheck
npm test
npm run build
npm run arena:simulate
npm run sharedos:proof
npm run demo:core
npm run smoke:service
npm run test:deploy
npm audit
```

`demo:core` covers justified repair, missing information, and a tampered proposal. `smoke:service` starts an ephemeral local server and exercises discovery, REST, and MCP. No command above needs SharedNet credentials; Arena simulation has zero real SharedNet effects.

## Vercel deployment

The production service uses stateless Node 24 Vercel functions in [`api/`](api/) over portable handlers in [`src/service/`](src/service/). Health, discovery, diagnose, repair, and stateless MCP routes share the same 64 KiB request limit, sanitized error mapping, and 240-second application deadline. The deployment does not rely on filesystem persistence.

Optional SharedOS Cloud audit export remains disabled unless both deployment configuration and `SHAREDOS_KEY` are provided. No official Cloud ingestion endpoint is configured in this release. See [docs/vercel-deployment.md](docs/vercel-deployment.md).

## Arena operator

The Arena branch includes a persistent, crash-resumable seller and buyer operator. Its deterministic simulation exercises delayed ledger settlement, more than 100 ledger records, concurrent income, malformed listings, service timeouts, restart recovery, duplicate prevention, three evaluated and purchased sellers, one ranking submission, 80 credits spent, and exactly-once paid delivery.

```bash
npm run arena:simulate
```

Simulation is always safe and reports zero real SharedNet side effects. Live SharedNet execution is fail-closed until organizer-specific identity, marketplace, payment, ranking, and timing configuration is confirmed. When those blockers are resolved, the actual live session must run from `/home/ru765/SharedOS-Hackathon` inside Ubuntu-24.04 WSL. Native Windows supports development, tests, builds, and simulation, but not the live runner.

See [docs/arena-runner-spec.md](docs/arena-runner-spec.md) and [docs/arena-launch-runbook.md](docs/arena-launch-runbook.md).

## Limitations

- Repair is deterministic and bounded to top-level JSON objects; CSV and general document transformation are not implemented.
- Missing or ambiguous facts are not inferred, and compatibility checks do not establish factual truth.
- Remote schema references and cyclic local references are unsupported.
- Arena prices are declarations; billing enforcement, official seller registration, and payment verification are pending organizer-confirmed integration.
- Official Arena marketplace and ranking adapters remain blocked on organizer guidance.
- Native Windows cannot run the live SharedNet operator.

## Repository structure

| Path | Purpose |
| --- | --- |
| [`contracts/`](contracts/) | Frozen versioned request and result JSON Schemas |
| [`src/repair/`](src/repair/) | Bounded deterministic repair proposals |
| [`src/verify/`](src/verify/) | Independent validation, diff, security, and hash verification |
| [`src/coordinator/`](src/coordinator/) | Stage orchestration and final delivery authority |
| [`src/sharedos/`](src/sharedos/) | Identities, grants, workflow boundary, and proof |
| [`src/service/`](src/service/) | Portable discovery, REST, and MCP handlers |
| [`api/`](api/) | Stateless Vercel route adapters |
| [`src/arena/`](src/arena/) | Guarded simulated and live Arena operator |
| [`evaluation/`](evaluation/) | Held-out adversarial evaluation cases |
| [`tests/`](tests/) | Contract, repair, verifier, security, service, deployment, and Arena tests |
| [`docs/`](docs/) | Protocol, architecture, deployment, and runbooks |

## License and author

Copyright © 2026 Rahmat Ullah. Released under the [MIT License](LICENSE).
