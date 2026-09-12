# SharedOS and SharedNet platform spike

Investigation date: 2026-09-12

## Scope and safety

This checkpoint used only read-only command discovery, the locally cached SharedNet package README, and public documentation from the official SharedOS repository. It did not inspect stored credentials, send room messages, make purchases, deploy software, register an agent, or register a service.

## Confirmed SharedNet facts

- The locally resolved `sharednet` package is version 0.1.8 and requires Node.js 22.18 or newer. This project uses Node.js 24.
- SharedNet rooms are persistent and addressed by room ID. A seat is an Instance with a permanent ID.
- The package README documents `join`, `say`, `wait`, `watch`, `add`, `rooms`, `requests`, `accept`, and `login` examples. Top-level CLI discovery also reports `whoami`, `read`, `deny`, `reach`, balance/credit commands, file commands, session commands, room subcommands, and decision subcommands. Discovery confirms those command families exist; it does not establish their argument contracts.
- The README says machine credentials are kept in an owner-only user configuration directory and per-project room state is kept in `.sharednet/`, which ignores itself in Git. This checkpoint did not open the machine credential store. `.sharednet/` is also excluded by this repository's root `.gitignore`.
- The README identifies `https://www.sharednet.ai/api/docs` as the HTTP API documentation. The page was not readable from this environment during the spike, so no raw HTTP route or authentication details are treated as confirmed here.
- Source: [SharedNet repository](https://github.com/Aicoo-Team/SharedNet) and the README shipped in the resolved npm package.

## Confirmed SharedOS facts

- SharedOS is a TypeScript permission and one-turn execution kernel, not a service-registration or billing platform. Its public README says product UI, accounts, billing, durable host state, model providers, credentials, and scheduling remain host responsibilities.
- Public packages are `0.x` prereleases installed from npm's `next` tag. The public API is explicitly described as unstable and not production-hardened.
- The recommended product integration is an embedded runtime. A remote alternative uses `@aicoo/sharedos-http` with `@aicoo/sharedos-client`.
- For each call, a host constructs a trusted access context containing a namespace, actor, authority, owner, purpose, trace ID, enabled tool namespaces, and time. The public guide uses application-selected example values; it does not describe hackathon tenant-ID or owner-address provisioning.
- Authorization is deny-by-default. A usable tool must be registered for the context, have its namespace enabled, and have a matching capability grant. Invocation is authorized again against the exact validated arguments.
- Transport authentication identifies a remote caller but does not replace SharedOS capability authorization. The host owns authentication and must derive identity and grants from trusted server-side state rather than caller-supplied JSON.
- A target agent invocation requires a separate recipient-scoped execution grant. A message alone grants no authority.
- SharedOS audit records are designed to omit message secrets, credentials, raw authorization tokens, and sensitive provider payloads.
- Sources: [SharedOS README](https://github.com/Aicoo-Team/SharedOS), [host integration guide](https://github.com/Aicoo-Team/SharedOS/blob/main/docs/host-integration.md), and [threat model](https://github.com/Aicoo-Team/SharedOS/blob/main/docs/security/threat-model.md).

## Blockers and unknowns

- No official hackathon procedure was found for provisioning a SharedOS tenant ID or owner address.
- No official Arena procedure was found for registering a product service or seller agent.
- No hackathon-specific required endpoint shape, discovery document, callback contract, or authentication scheme was found.
- No official service-pricing rules, competition-credit charging API, settlement flow, or seller-side payment-verification procedure was found.
- No organizer-confirmed Arena date, time, or timezone was found in the inspected platform documentation.
- The referenced “sixth submission-validity condition” was not defined in the inspected platform documentation.
- The SharedNet API documentation URL was identified but could not be inspected from this environment.
- The public SharedOS documents describe a general host integration. They do not establish whether the hackathon will inspect embedded audit events, require a hosted SharedOS boundary, or supply a separate competition adapter.

## Deferred integration decisions

DeliverCheck does not yet choose a SharedOS tenant, seller identity, service-registration path, authentication contract, pricing model, credit-transfer flow, or deployment target. Those decisions remain outside checkpoint 1 until organizers publish an official integration example or answer the open questions.

## Recommended next action

Obtain one organizer-confirmed, minimal end-to-end Arena integration example covering tenant/owner provisioning, seller registration, endpoint authentication, paid-call settlement and verification, the event schedule, and all submission-validity conditions. Record that answer before designing checkpoint 2 so the implementation does not encode unsupported platform assumptions.
