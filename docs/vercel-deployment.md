# Vercel stateless deployment adapter

This checkpoint prepares DeliverCheck for Vercel without creating a Vercel project, authenticating, deploying, or sending external audit events. The portable handlers in `src/service/handlers.ts` are unchanged. Thin Web `Request`/`Response` entrypoints under `api/` select a route and delegate to `src/deploy/vercel.ts`.

## Architecture

Vercel currently supports Node.js 24 and Web-standard function handlers. This repository pins Node 24 through `engines.node`, declares the Node runtime in every function, enables Fluid compute, and configures a 300-second maximum duration and cancellation forwarding in `vercel.json`.

| Public path | Vercel function | Handler |
| --- | --- | --- |
| `GET /health` | rewrite to `api/health.ts` | health |
| `GET /.well-known/agent.json` | rewrite to `api/agent-card.ts` | agent card |
| `GET /api/v1/listing` | `api/v1/listing.ts` | listing |
| `POST /api/v1/diagnose` | `api/v1/diagnose.ts` | diagnose |
| `POST /api/v1/repair` | `api/v1/repair.ts` | verified repair |
| `POST /api/mcp` | `api/mcp.ts` | MCP Streamable HTTP |

Each service invocation creates a fresh core pipeline. The implementation stores no customer payload, session, audit history, or job data in the filesystem or across calls. Module reuse is limited to code and the MCP HTTP dispatcher.

The 64 KiB limit is enforced while reading the Web request stream, so a forged or absent `Content-Length` cannot bypass it. Each call receives an abort signal combining client cancellation with a 240-second application deadline, leaving 60 seconds before Vercel's configured 300-second termination boundary. Public errors are converted to stable sanitized bodies. Query parameters are rejected, request hosts and browser origins must match deployment-controlled origins, and caller headers or body fields never become SharedOS identity or grants. The unauthenticated MCP adapter strips authorization, cookie, identity, and grant headers before protocol dispatch.

## MCP compatibility

The pinned official MCP TypeScript server package creates a fresh `McpServer` once per HTTP request and retains no instance state. DeliverCheck's `diagnose` and `repair` tools finish within one request and do not use sessions, resumability, subscriptions, server push, or durable resources. They therefore operate correctly in stateless Vercel Functions and scale across independent instances.

The handler also enables the SDK's stateless compatibility path for 2025-era clients. Stateful MCP features remain unsupported. Add an external state store or move to an always-on Node provider before adding resumable streams, subscriptions, long-lived sessions, or server-initiated work.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | Recommended | Canonical HTTPS origin used in discovery documents and the trusted host/origin set. |
| `VERCEL_URL` | Supplied by Vercel when system variables are exposed | Deployment hostname fallback for discovery and validation. |
| `VERCEL_PROJECT_PRODUCTION_URL` | Supplied by Vercel when system variables are exposed | Production hostname fallback. |
| `SHAREDOS_KEY` | Optional | Enables fail-closed audit export. It is never returned, logged, placed in the export body, or persisted by DeliverCheck. |
| `SHAREDOS_AUDIT_URL` | Conditional | Operator-supplied HTTPS ingestion URL used only with `SHAREDOS_KEY`. No official public SharedOS Cloud ingestion endpoint was confirmed in this checkpoint. |

Audit export is disabled when `SHAREDOS_KEY` is absent, even if an exporter or URL is present. When the key is set, a missing endpoint, rejected export, network failure, or timeout becomes a sanitized operational failure after an otherwise successful repair. If the pipeline already failed, an export failure cannot replace that failure or turn it into success. The export contains only `SanitizedAuditOutcome` records; it excludes raw payloads, schemas, grants, owners, credentials, and tokens. This seam must remain disabled until SharedOS supplies an official ingestion URL and contract.

Do not put secrets in `PUBLIC_BASE_URL`, `SHAREDOS_AUDIT_URL`, source files, or `vercel.json`. Configure secrets through Vercel environment settings only when deployment is authorized.

## Local verification

No Vercel account or CLI is needed:

```sh
npm run typecheck
npm run test:deploy
npm test
npm run sharedos:proof
npm run smoke:service
npm audit
```

The deployment tests invoke every wrapper behavior in-process with Web requests. The MCP test uses the official `Client` and `StreamableHTTPClientTransport` across independent stateless requests. Cloud tests use an injected local fake and never contact an external endpoint.

## Confirmed references

- [Vercel supported Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel Functions API reference](https://vercel.com/docs/functions/functions-api-reference)
- [Vercel function duration configuration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Vercel MCP deployment guide](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
- [Official MCP TypeScript SDK HTTP serving guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)
- [SharedOS architecture](https://www.sharedos.ai/docs/architecture)
- [SharedOS threat model](https://github.com/Aicoo-Team/SharedOS/blob/main/docs/security/threat-model.md)
