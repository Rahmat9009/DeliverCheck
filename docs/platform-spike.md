# SharedOS and SharedNet platform spike

Investigation date: 2026-09-12

## Scope and safety

The investigation used only read-only command discovery, the locally cached SharedNet package README, public documentation from the official SharedOS repository, and the source and declarations shipped in the pinned official package. It did not inspect stored credentials, send room messages, make purchases, deploy software, register an agent, or register a service.

## Confirmed SharedNet facts

- The locally resolved `sharednet` package is version 0.1.8 and requires Node.js 22.18 or newer. This project uses Node.js 24.
- SharedNet rooms are persistent and addressed by room ID. A seat is an Instance with a permanent ID.
- The package README documents `join`, `say`, `wait`, `watch`, `add`, `rooms`, `requests`, `accept`, and `login` examples. Top-level CLI discovery also reports `whoami`, `read`, `deny`, `reach`, balance/credit commands, file commands, session commands, room subcommands, and decision subcommands. Discovery confirms those command families exist; it does not establish their argument contracts.
- The README says machine credentials are kept in an owner-only user configuration directory and per-project room state is kept in `.sharednet/`, which ignores itself in Git. This checkpoint did not open the machine credential store. `.sharednet/` is also excluded by this repository's root `.gitignore`.
- The README identifies `https://www.sharednet.ai/api/docs` as the HTTP API documentation. The page was not readable from this environment during the spike, so no raw HTTP route or authentication details are treated as confirmed here.
- Source: [SharedNet repository](https://github.com/Aicoo-Team/SharedNet) and the README shipped in the resolved npm package.

## Confirmed SharedOS facts

- DeliverCheck pins the official `@aicoo/sharedos` SDK at exactly `0.1.0-alpha.4`. That SDK requires Node.js 20.11 or newer and re-exports the contracts, core, HTTP, OS, runtime, and client packages at the same prerelease version.
- SharedOS is a TypeScript permission and one-turn execution kernel, not a service-registration or billing platform. Its public README says product UI, accounts, billing, durable host state, model providers, credentials, and scheduling remain host responsibilities.
- Public packages are `0.x` prereleases installed from npm's `next` tag. The public API is explicitly described as unstable and not production-hardened.
- The recommended product integration is an embedded runtime. A remote alternative uses `@aicoo/sharedos-http` with `@aicoo/sharedos-client`.
- For each call, a host constructs a trusted access context containing a namespace, actor, authority, owner, purpose, trace ID, enabled tool namespaces, and time. The public guide uses application-selected example values; it does not describe hackathon tenant-ID or owner-address provisioning.
- Authorization is deny-by-default. A usable tool must be registered for the context, have its namespace enabled, and have a matching capability grant. Invocation is authorized again against the exact validated arguments.
- Transport authentication identifies a remote caller but does not replace SharedOS capability authorization. The host owns authentication and must derive identity and grants from trusted server-side state rather than caller-supplied JSON.
- A target agent invocation requires a separate recipient-scoped execution grant. A message alone grants no authority.
- SharedOS audit records are designed to omit message secrets, credentials, raw authorization tokens, and sensitive provider payloads.
- `AccessContext` uses structured addresses and contains identity, namespace, owner, purpose, trace, namespace-selection, and time data; it deliberately carries no grants. `SharedOSKernel` requires a trusted `GrantSource` and fails closed if authority cannot be resolved as one valid set.
- A capability grant binds its subject, issuer, namespace, resource owner/path, allowed actions, exact-or-descendant scope, and constraints such as permitted purposes. The DeliverCheck proof uses only `exact` scopes.
- An authority snapshot hash is SHA-256 over a canonical, order-independent representation of the resolved grant set. `authority.resolved` and `authorization.checked` audit events carry that hash.
- `invokeResource` authorizes before resolving or calling the resource provider. The embedded DeliverCheck proof confirmed that three denied operations never reached its provider; only the allowed intake operation did.
- Sources: [SharedOS README](https://github.com/Aicoo-Team/SharedOS), [host integration guide](https://github.com/Aicoo-Team/SharedOS/blob/main/docs/host-integration.md), and [threat model](https://github.com/Aicoo-Team/SharedOS/blob/main/docs/security/threat-model.md).

## Confirmed MCP SDK facts

- DeliverCheck pins the official split MCP TypeScript SDK packages `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, and `@modelcontextprotocol/client` at exactly `2.0.0`.
- The official v2 server API registers tools through `McpServer.registerTool`. Tools can return `structuredContent`, and plain JSON Schema can be adapted through `fromJsonSchema`.
- The official server guide recommends Streamable HTTP for remote servers. DeliverCheck uses `createMcpHandler` with the official Node adapter at `/api/mcp`; the smoke test uses the official Streamable HTTP client.
- The MCP HTTP entry does not verify tokens or infer authenticated identity from headers. Authentication remains a host responsibility, so DeliverCheck does not expose an authenticated-caller claim in local mode.
- Sources: [official MCP TypeScript SDK v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/) and [official server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md).

## Confirmed Vercel deployment facts

- Vercel currently supports Node.js 24, and `package.json` may select it with a compatible engine range.
- Vercel Functions accept Web-standard `Request` objects and return `Response` objects. Files under `api/` become functions without a framework.
- Function duration can be set in `vercel.json`. DeliverCheck configures a 300-second maximum with Fluid compute and cancellation forwarding. Its application deadline is 240 seconds so sanitized timeout handling has a 60-second platform margin.
- Vercel officially documents hosting MCP over Streamable HTTP. Independently, the pinned official MCP SDK documents that `createMcpHandler` runs its factory once per HTTP request, retains no instance state, and scales horizontally.
- DeliverCheck's two tools need no sessions, resumability, subscriptions, server push, or filesystem state. The existing Streamable HTTP transport is therefore compatible with stateless Vercel Functions for this scope.
- Sources: [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [Functions API](https://vercel.com/docs/functions/functions-api-reference), [duration configuration](https://vercel.com/docs/functions/configuring-functions/duration), [Vercel MCP guide](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel), and [official MCP HTTP serving guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md).

## Confirmed Cloud audit boundary

- SharedOS makes durable host state and provider behavior host responsibilities. Its threat model treats HTTP headers, request bodies, external services, deployment configuration, and secrets as trust-boundary concerns.
- No official public SharedOS Cloud audit-ingestion URL or wire contract was found in the current official documentation or the pinned package. The Vercel adapter therefore keeps export optional, requires both a key and an operator-supplied HTTPS endpoint, exports only sanitized audit outcomes, and fails safely.
- Sources: [SharedOS architecture](https://www.sharedos.ai/docs/architecture) and [SharedOS threat model](https://github.com/Aicoo-Team/SharedOS/blob/main/docs/security/threat-model.md).

## Non-official interoperability evidence

No other participant's repository was inspected or used for the implementation. In particular, no Witness source was copied. Therefore this checkpoint contains no participant-derived interoperability claim. Any future observation learned from a participant repository or deployed agent must be recorded under this heading as non-official evidence and must not override official SharedOS contracts or organizer guidance.

## Blockers and unknowns

- No official hackathon procedure was found for provisioning a SharedOS tenant ID or owner address.
- No official Arena procedure was found for registering a product service or seller agent.
- No hackathon-specific required endpoint shape, discovery document, callback contract, or authentication scheme was found.
- No official service-pricing rules, competition-credit charging API, settlement flow, or seller-side payment-verification procedure was found.
- No organizer-confirmed Arena date, time, or timezone was found in the inspected platform documentation.
- The referenced “sixth submission-validity condition” was not defined in the inspected platform documentation.
- The SharedNet API documentation URL was identified but could not be inspected from this environment.
- The public SharedOS documents describe a general host integration. They do not establish whether the hackathon will inspect embedded audit events, require a hosted SharedOS boundary, or supply a separate competition adapter.
- No official SharedOS Cloud audit-ingestion endpoint or request schema was identified. `SHAREDOS_KEY` and the deployment export seam must remain disabled until the organizer or SharedOS documentation supplies that contract.

## Deferred integration decisions

DeliverCheck now has a local-only Vercel-compatible adapter, but no Vercel project or public deployment exists. It does not yet choose a SharedOS tenant, seller registration path, authentication contract, credit-transfer flow, or confirmed Cloud audit endpoint. The local identities, service prices, and proof namespace are application-owned development values; they are not claims about Arena provisioning or settlement.

## Recommended next action

Obtain one organizer-confirmed, minimal end-to-end Arena integration example covering tenant/owner provisioning, seller registration, endpoint authentication, paid-call settlement and verification, the event schedule, and all submission-validity conditions. Record that answer before implementing Arena authentication, billing enforcement, seller registration, or deployment.
