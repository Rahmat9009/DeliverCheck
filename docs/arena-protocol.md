# SharedNet Arena protocol preflight

Investigation date: 2026-09-12 (Asia/Qatar)

## Scope and evidence standard

This preflight is read-only. It used the published `sharednet` npm package, the official public SharedNet discovery document and OpenAPI document, read-only CLI status operations, and the existing Q&A room history. It did not inspect credential files or values, join a room, send a message, transfer credits, resolve a decision, or change the production service.

A protocol fact is marked confirmed only when it appears in the published CLI/package source, the official SharedNet API documentation, or an organizer-authored room response. Participant statements are not treated as protocol evidence.

Sources:

- [SharedNet HTTP API documentation](https://www.sharednet.ai/api/docs)
- [SharedNet API discovery document](https://www.sharednet.ai/api/v1)
- [SharedNet OpenAPI document](https://www.sharednet.ai/api/v1/openapi.json)
- [SharedNet repository](https://github.com/Aicoo-Team/SharedNet)

## Installed and server versions

- `sharednet@latest` resolved to exactly `0.1.8` on 2026-09-12. The current seat also reports CLI version `0.1.8`.
- The public server discovery document reports API major version `1`, protocol version `1.0.0`, and minimum CLI version `0.1.3`.
- The package requires Node.js 22.18 or newer. This repository uses Node.js 24.
- The CLI has no working `--version` or top-level `--help` option in 0.1.8. Supplying either returns `unknown_command` and the documented command-family list. Version confirmation therefore came from the npm package metadata and manifest.
- An unattended runner should pin `sharednet@0.1.8` until a later CLI has been separately reviewed. Using `@latest` would allow the protocol to change between runs.

The CLI's documented top-level families are:

```text
login, whoami, join, say, read, wait, watch, add, rooms, requests,
accept, deny, reach, balance, redeem, pay, ledger, upload, download,
files, session start/status, room create/list/invite/add/join/post/messages,
decision list/approve/deny
```

`--json` selects machine-readable output. Account/session commands can select a session with `--session <i_...>`. Seat-oriented commands can select a room seat with `--as <i_...>` where documented. The CLI expressly refuses an API key supplied as a command-line flag. Credentials must remain in the CLI's secure local store and must never be passed through prompts, arguments, logs, or the runner ledger.

## Current authenticated identity

Read-only status confirmed this machine's following public identifiers:

| Concept | Current value | Meaning |
| --- | --- | --- |
| Principal/account | `p_oQqJzCwYjL` | The account and credit-purse owner. |
| Agent | none | No durable Agent tag is attached to the current Instance. |
| Instance | `i_CipKpa8uuL` | The permanent, public Codex execution identity and current room member ID. |
| Current room | `rom_TxTzqEUKyx` | The existing Q&A room, not an Arena-room confirmation. |

The distinctions are confirmed as follows:

- A **Principal** (`p_...`) is the account identity and owns the credit purse.
- An **Agent** (`a_...`) is an optional durable tag/handle owned by a Principal. Multiple Instances may be grouped under it.
- An **Instance** (`i_...`) is a permanent execution/session identity. Its short-lived lease is renewed by the CLI. An Instance can occupy a room membership or seat.
- A **seat** is an Instance's membership in a specific Room. `--as` disambiguates when the working directory knows more than one seat. Older anonymous memberships may use a legacy `mem_...` identifier, but current account-backed seats use an Instance ID.
- A **Room** (`rom_...`) is a persistent, sequence-ordered message log.
- **Node** is not a separate identifier type in the current CLI or public OpenAPI document.

Principal, Agent, Instance, Room, Message, Decision, and Transfer IDs are protocol-visible identifiers rather than secret bearer credentials. The current Instance ID can safely be disclosed as an address. The organizer has not confirmed whether Devpost expects the Principal, an Agent tag, the Arena seat Instance, or some separately assigned “node” value. Because the current Instance has no Agent tag and the Arena seat does not yet exist, no exact Devpost identifier is confirmed.

Read-only identity/status commands:

```bash
npx -y sharednet@0.1.8 whoami --json
npx -y sharednet@0.1.8 session status --session <instance_id> --json
npx -y sharednet@0.1.8 rooms --json
```

## Joining and re-entering rooms

The confirmed invite form is:

```bash
npx -y sharednet@0.1.8 join '<invite>'
```

The invite is a single quoted argument containing a Room ID, invite token, and base URL. It is sensitive and must not be logged or placed in source control. On an already authenticated machine, the CLI creates a fresh account-backed Instance and joins it to the invited Room. No claim argument is needed. An optional `--agent <a_id-or-handle>` groups the new Instance under an account-owned Agent tag.

To re-enter a Room for which this machine already holds a seat:

```bash
npx -y sharednet@0.1.8 join <room_id> --as <instance_id>
```

Re-entry is idempotent and restores history and local cursor state for that seat. It is distinct from accepting a new invite. The Arena room's invite, its required Agent tag, and its admission time have not been published in the inspected sources, so the exact Arena join command cannot yet be instantiated.

## Reading, waiting, sending, and cursors

Confirmed commands:

```bash
# Snapshot reads; these do not advance the stored cursor.
npx -y sharednet@0.1.8 read --last 100 --as <instance_id> --json
npx -y sharednet@0.1.8 read --after <sequence> --limit 100 --order asc --as <instance_id> --json
npx -y sharednet@0.1.8 read --grep '<text>' --as <instance_id> --json

# Long polling; this starts at and advances the seat's stored cursor.
npx -y sharednet@0.1.8 wait --timeout <seconds> --min <count> --as <instance_id> --json

# Persistent command dispatch for unattended operation.
npx -y sharednet@0.1.8 watch --on message --run '<handler-command>' --as <instance_id>

# Message mutation. Do not run in simulation mode.
npx -y sharednet@0.1.8 say '<message>' --as <instance_id> --json
npx -y sharednet@0.1.8 say '<message>' --reply-to <message_id> --as <instance_id> --json
```

`read` supports mutually exclusive `--last`, `--after`, and `--before` windows, a limit from 1 through 100, ascending or descending order, exact sender filters, and a text grep. Message `sequence` is the canonical ordering field. A snapshot read does not acknowledge or advance the seat cursor.

The server long-poll endpoint accepts `after >= 0` and a timeout from 0 through 25 seconds. The CLI's `wait` command loops those bounded polls to satisfy its requested timeout/minimum. It advances over every observed sequence, including the seat's own messages, while returning only messages from other members. The next run resumes from the locally stored `last_sequence`.

The server discovery limits a message to 32,768 bytes and an artifact to 4,194,304 bytes, with a 268,435,456-byte artifact quota. These platform limits do not establish the Arena's allowed request or delivery format.

`watch` is the CLI's documented unattended primitive. It accepts `message`, periodic, count, and idle triggers. A child process receives a JSON batch on standard input and these non-secret context values: Room ID, member ID, message count, and last sequence. The seat's own messages never trigger it. The CLI maintains an in-memory fetch cursor and a persisted handled cursor. The persisted cursor advances only after the handler exits successfully and, when `--reply` is used, its reply is confirmed. A failed handler or reply leaves the batch available for replay. The default failure ceiling is three attempts.

The CLI renews an Instance lease when no more than 30 seconds remain. The public API reports a 90-second presence lease and a 30-second heartbeat threshold. Authentication failure removes a stale local session. A runner must use one stable working directory so the CLI continues to find the correct non-secret room cursor and the opaque credential store.

`watch` replay is at-least-once processing, not proof of exactly-once external side effects. A process can fail after an external call but before its cursor is persisted. The Arena runner therefore needs its own durable deduplication and reconciliation rules described in [arena-runner-spec.md](arena-runner-spec.md).

## Credits, transfers, receipts, and verification

At `2026-09-12T22:08:19+03:00`, the read-only purse response for the current Principal was:

| Balance | Granted | Sent | Received |
| ---: | ---: | ---: | ---: |
| 100 | 100 | 0 | 0 |

Confirmed commands:

```bash
# Read-only purse and ledger.
npx -y sharednet@0.1.8 balance --as <instance_id> --json
npx -y sharednet@0.1.8 ledger --last 100 --as <instance_id> --json
npx -y sharednet@0.1.8 ledger --before <transfer_id> --last 100 --as <instance_id> --json

# Irreversible mutation. Do not run in simulation or before Arena preflight passes.
npx -y sharednet@0.1.8 pay <principal_or_agent_or_instance_id> <whole_credit_amount> --memo '<memo>' --as <instance_id> --json

# Optional Room binding and a separate human-readable receipt post.
npx -y sharednet@0.1.8 pay <target_id> <amount> --memo '<memo>' --room --as <instance_id> --json
```

The amount must be a positive whole number. The destination can be a Principal, Agent, or Instance. The official transfer request carries a UUID `Idempotency-Key`; the CLI generates it internally. A transfer is final and has no reversal operation in the documented API.

`--room` binds the transfer to the current Room and then makes a separate message post containing a human-readable receipt. If that post fails, the CLI reports `receipt_not_confirmed` and explicitly warns against repeating the payment. A Room message or a claimed transfer ID is not payment proof.

The seller-side official evidence is its own `ledger` response. The current transfer records expose these fields: transfer ID, source Principal, destination Principal, amount, memo, Room ID, paying Instance, addressed-to identifier, code, and creation time. Verification must find one incoming server record whose recipient, amount, unique order memo, and Room binding match the pending purchase. It must also mark that transfer ID consumed exactly once. There is no separate `receipt`, `verify-payment`, or transfer-by-ID CLI command in version 0.1.8; verification requires paginating `ledger` and matching the official record. The Arena organizer still needs to confirm the required payee identifier, memo/order format, Room binding, and whether seller delivery occurs before or after settlement.

The `redeem <CODE>` command exists but mutates the purse and was not used. No Arena credit top-up, redemption, or refund procedure is confirmed.

## Decisions, rankings, and discovery

The confirmed decision commands are:

```bash
npx -y sharednet@0.1.8 decision list --status pending --session <instance_id> --json
npx -y sharednet@0.1.8 decision approve <decision_id> --session <instance_id> --json
npx -y sharednet@0.1.8 decision deny <decision_id> --session <instance_id> --json
```

The published CLI describes these Decisions as requests addressed to a private Instance, currently requests to seat it in a Room. They are not Arena rankings, reviews, product choices, or round submissions. There is no `rank`, `ranking`, `arena`, `product`, `purchase`, `service`, or seller-registration command in CLI 0.1.8, and no matching route in the public OpenAPI document. No ranking/round result should be submitted through `decision approve/deny`.

SharedNet's public protocol discovery is:

```text
GET https://www.sharednet.ai/api/v1
GET https://www.sharednet.ai/api/v1/openapi.json
```

It advertises identity, Agents, Instance leases, Rooms/messages/wait/inbox, membership decisions, reach, credits, and artifacts. It does not advertise a product/service registry. `rooms` or `room list` discovers rooms visible to the account; it is not product discovery. DeliverCheck independently publishes its agent card and listing, but the inspected SharedNet sources do not define how Arena products are announced, enumerated, purchased, or correlated with a seller identity.

## Organizer evidence

The existing Q&A room contained one organizer-authored message: `Xisen(Organiser)`, message `msg_tu3rQDKpvh`, sequence 1, at `2026-09-11T11:17:53.521Z`. It was an introduction offering source-backed help and contained no Arena protocol answer. No organizer response in the inspected history confirms the join invitation, identity for Devpost, product discovery, seller registration, purchase grammar, payment matching, round deadlines, ranking submission, or the missing sixth validity condition.

## Production reachability

One bounded check against `https://delivercheck.vercel.app` produced:

| Interface | Result | Observed latency |
| --- | --- | ---: |
| `GET /health` | HTTP 200, JSON | 1,699 ms |
| `GET /.well-known/agent.json` | HTTP 200, JSON, production-origin endpoint URLs | 1,331 ms |
| `GET /api/v1/listing` | HTTP 200, JSON | 1,386 ms |
| Official Streamable HTTP MCP client to `POST /api/mcp` | connected; listed `diagnose` and `repair` | 2,708 ms |

The discovery documents name DeliverCheck, declare `diagnose` at 0 credits and `repair` at 7 credits, and contain no localhost URL. These are reachability observations only. They do not register DeliverCheck with SharedNet or prove Arena billing.

## Unconfirmed Arena protocol

The following facts are required before a live unattended operator can be enabled:

1. The Arena Room invite, join window, required Agent tag, and whether the competition provisions a new Instance.
2. The exact Principal, Agent, Instance, or separately assigned node identifier required by Devpost.
3. The official product catalogue/discovery mechanism and product identity schema.
4. The purchase-request and seller-response message grammar, correlation ID, retry rules, and delivery size/artifact rules.
5. The seller payee identifier, when the buyer pays, required memo and Room binding, and settlement/receipt acceptance rule.
6. The exact Round 1 disagreement and ranking submission format and destination.
7. The exact Round 2 purchase/credit accounting rules, including whether exactly 80 or at least 80 credits must settle.
8. Arena start, round, cutoff, and timezone timestamps.
9. The missing sixth submission-validity condition.

Until those are organizer-confirmed, the transport and credit primitives are usable, but the full Arena protocol is not.

## Checkpoint 6B3 compatibility assumptions

The operator pins the confirmed CLI package at `sharednet@0.1.8` and verifies two runtime values during live preflight: the selected session's reported CLI version and the official discovery document's `protocol_version`. A configured nonempty profile label is not accepted as version proof. The live adapter chooses `npx` on Linux and `npx.cmd` on native Windows.

The unattended loop uses bounded `read --after` pagination followed by `wait`, while retaining its own application cursor. This avoids delegating exactly-once behavior to the CLI's `watch` cursor and lets pending orders be reconsidered without message replay. `watch` remains an official command but is not required by this implementation.

Ledger reconciliation uses the documented `--before <transfer_id>` cursor. Incoming order searches continue to the order timestamp boundary so duplicate valid transfers can be recorded. Exact transfer-ID searches stop as soon as the target is found. All searches also stop at an explicit page limit and fail safely when evidence lies beyond it.

No official marketplace, product invocation, purchase-request, canonical seller mapping, or ranking convention has become available since the preflight above. The new live entrypoint therefore requires a repository-local integration module and exact organizer-confirmed adapter identifiers; it does not provide a guessed Room-message grammar. Missing integration configuration prevents startup before any SharedNet mutation.

For implementation purposes, Principal is the required canonical seller key. This is a fail-closed configuration rule based on the confirmed credit-owner semantics, not evidence that the organizer has chosen a seller identity convention. An Agent or Instance listing remains unusable for payment until the organizer confirms its Principal mapping and exact addressed recipient.
