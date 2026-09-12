# DeliverCheck local service layer

DeliverCheck exposes two MVP services. `diagnose` costs 0 Arena credits and validates one top-level JSON object without modifying it. `repair` declares a price of 7 Arena credits and runs the complete SharedOS-authorized repair and independent-verification pipeline. There is no separate `bridge` offering.

Price fields are declarations for discovery and client planning. Billing enforcement and payment verification remain external pending official SharedNet confirmation. A response with `price_credits` does not prove that a transfer occurred, and the service never fabricates a receipt or transfer ID.

## Local endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Process readiness without customer data. |
| `GET` | `/.well-known/agent.json` | Agent card generated for the configured public origin. |
| `GET` | `/api/v1/listing` | Service listing, prices, limits, and billing status. |
| `POST` | `/api/v1/diagnose` | Frozen request contract in; non-mutating compatibility diagnosis out. |
| `POST` | `/api/v1/repair` | Frozen request contract in; verified result plus billing declaration out. |
| `POST` | `/api/mcp` | Official MCP Streamable HTTP endpoint with `diagnose` and `repair` tools. |

Start the Node adapter:

```sh
npm install
npm run build
npm start
```

The default address is `http://127.0.0.1:3000`. `HOST`, `PORT`, `PUBLIC_BASE_URL`, and comma-separated `ALLOWED_HOSTS` are deployment configuration. A public `PUBLIC_BASE_URL` must use HTTPS. The default host allowlist contains only loopback names.

Diagnose an incompatible payload:

```sh
curl --fail-with-body -X POST http://127.0.0.1:3000/api/v1/diagnose \
  -H 'Content-Type: application/json' \
  --data '{"request_id":"diagnose-1","input_format":"json","source_text":"{\"status\":\"done\"}","target_schema":{"type":"object","additionalProperties":false,"required":["status"],"properties":{"status":{"type":"string","enum":["complete","pending"]}}},"explicit_rules":["status must satisfy the target schema"]}'
```

Run a justified repair:

```sh
curl --fail-with-body -X POST http://127.0.0.1:3000/api/v1/repair \
  -H 'Content-Type: application/json' \
  --data '{"request_id":"repair-1","input_format":"json","source_text":"{\"status\":\"done\"}","target_schema":{"type":"object","additionalProperties":false,"required":["status"],"properties":{"status":{"type":"string","enum":["complete","pending"]}}},"explicit_rules":["Normalize \"status\" value \"done\" to \"complete\"."]}'
```

An MCP client can connect with the pinned official client package:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "example-client", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3000/api/mcp")),
);
const tools = await client.listTools();
const result = await client.callTool({
  name: "diagnose",
  arguments: {
    request_id: "mcp-1",
    input_format: "json",
    source_text: '{"status":"complete"}',
    target_schema: {
      type: "object",
      required: ["status"],
      properties: { status: { const: "complete" } },
    },
    explicit_rules: ["status must satisfy the target schema"],
  },
});
console.log(tools.tools.map((tool) => tool.name), result.structuredContent);
await client.close();
```

## Security and result semantics

- HTTP request bodies and direct tool `source_text` values are limited to 64 KiB. The schema verifier also applies depth, node-count, and reference-count limits.
- Service calls require `Content-Type: application/json`. The adapter rejects query parameters and validates `Host` and browser `Origin` values against an operator-controlled allowlist.
- Remote `$ref` values are rejected. The service performs no URL fetching, arbitrary code execution, shell execution, or credential handling.
- Request-body identity fields violate the frozen contract. HTTP headers are not translated into SharedOS grants. A deployment must establish caller identity in trusted authentication middleware and must not trust a body claim.
- Public errors contain a category, stable code, and sanitized message. Internal stacks, SharedOS audit details, and complete customer payloads are not returned or logged.
- Requests have a five-minute deadline. A timeout, dependency failure, authorization denial, or verifier rejection remains an error response and never becomes `passed_checks` or `cannot_repair`.
- A successful diagnosis or repair proves only the stated format and schema checks. Every public diagnosis has `proves_factual_truth: false`, and every verification check in a repair result preserves the same limitation.

The Node adapter in `src/service/node-server.ts` is suitable for a supported Node 24 runtime. No deployment manifest or hosted resource is created in this checkpoint because a deployment provider has not been selected.
