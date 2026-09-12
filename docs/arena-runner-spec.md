# DeliverCheck Arena runner specification

Status: the guarded operator, durable state, adapters, and deterministic simulation are implemented on `codex/arena-operator`. Live operation remains blocked on the unconfirmed protocol items in [arena-protocol.md](arena-protocol.md).

## Objective

The runner will operate one DeliverCheck seat through the SharedNet Arena while keeping SharedNet credentials opaque. It will monitor a Room, present the product, accept bounded requests, call the deployed DeliverCheck service, deliver results, verify payments from the official ledger, evaluate other products in both competition rounds, and maintain a durable audit trail.

The first implementation must use the pinned official CLI as the credential boundary. It may consume the CLI's JSON output, public IDs, messages, balances, and transfer records. It must never open, copy, print, persist, or forward the CLI's credential files or bearer values.

## Hard enablement gate

The runner has two modes: `simulate` and `live`. `live` must fail closed during startup unless an operator-supplied, versioned Arena profile contains organizer-confirmed values for:

- Arena Room and seat/Agent requirements;
- start, round, and submission deadlines with timezone;
- product catalogue and seller/purchaser message schemas;
- seller payee and payment-correlation rules;
- ranking submission format and destination;
- Round 2 accounting rules; and
- all submission-validity conditions.

The profile contains public protocol data only. Invite and credential material remains managed by the SharedNet CLI and is never copied into the profile. The runner validates the SharedNet server's discovery `protocol_version`, requires CLI `0.1.8` for this design revision, and refuses a newer unreviewed version.

## Safety and authority boundaries

The runner separates capabilities into small adapters:

| Adapter | Simulation | Live |
| --- | --- | --- |
| Room reader | Fixture-only | May invoke `read`, `wait`, or `watch` for the selected seat |
| Room sender | Throws `simulation_mutation_denied` | May invoke `say` after policy checks |
| Credit reader | Fixture-only | May invoke `balance` and `ledger` |
| Credit payer | Throws `simulation_mutation_denied` | May invoke `pay` after budget and dedupe checks |
| DeliverCheck client | Stub or bounded production call explicitly selected by the operator | May call only the configured HTTPS DeliverCheck origin |
| Ranking submitter | Records intended submission only | Disabled until the organizer-confirmed method is implemented |

No query parameter, Room message, customer payload, HTTP header, or claimed identity can enable a capability, raise a budget, change a deadline, alter the configured payee, select a different DeliverCheck origin, or switch simulation into live mode. Live mutation adapters require an explicit startup mode selected outside message data.

Simulation builds must not contain a code path to the live adapter's `say`, `pay`, mutating Room/Decision commands, or authenticated SharedNet POST operations. The simulation adapter records synthetic sends and payments in memory so the workflows can be tested, while its real-side-effect counter remains zero. Simulation can replay sanitized fixtures and write only its local simulation ledger.

## Persistent monitoring and reconnection

The runner uses a fixed working directory bound to one Arena seat. It never parses the CLI's private state files. The preferred process boundary is:

```text
sharednet watch --on message --run <runner-batch-handler> --as <arena_instance>
```

The handler receives each JSON batch on standard input. It writes an append-only `batch_received` event and fsyncs it before processing. It exits successfully only after every message has reached a terminal local state or a safely retryable state has been recorded. A non-zero exit leaves the SharedNet cursor before the batch so the CLI can replay it.

On startup or reconnection the runner:

1. verifies the pinned CLI and server protocol versions;
2. calls read-only identity/session status and confirms the configured Principal, Instance, and Arena Room;
3. reads the last durable local event and reconstructs indexes from the append-only ledger;
4. reconciles every side effect whose outcome was unknown at shutdown;
5. uses `read --after <last-observed-sequence> --order asc` to inspect the gap without advancing the CLI cursor;
6. resumes `watch` from the CLI-managed handled cursor; and
7. ignores own messages and deduplicates every incoming message ID and sequence.

If the Instance lease expires, the CLI may renew it. Authentication failure, identity drift, Room mismatch, a sequence regression, malformed JSON, or a discontinuity that cannot be reconciled stops live processing. The runner does not automatically join a replacement seat.

## Append-only activity ledger

The ledger is local durable JSON Lines with one canonical JSON object per line and a hash chain. Each event contains:

```text
event_id, prior_hash, event_hash, recorded_at, mode, arena_profile_version,
room_id, seat_instance_id, message_id?, sequence?, order_id?, product_id?,
request_hash?, response_hash?, transfer_id?, amount?, state, outcome_code
```

It stores hashes and the minimum redacted operational metadata needed for reconciliation. It excludes credentials, invite material, full customer payloads, full DeliverCheck results, raw CLI stderr, and arbitrary message text. Any diagnostic excerpt is length-bounded and redacted.

Before a mutation, the runner appends and syncs an `intent` event with a stable internal operation ID. After it observes the authoritative outcome, it appends `confirmed` or `failed`. The ledger is never edited in place. Startup verifies the hash chain and refuses live operation on corruption.

Deduplication indexes reconstructed from the ledger include:

- handled `(room_id, message_id)` and `(room_id, sequence)` pairs;
- one accepted request per organizer-defined order/correlation ID;
- one delivery per accepted request version;
- one consumed incoming transfer ID per paid seller request;
- one purchase intent per Round 2 product/attempt;
- one submitted review/disagreement per Round 1 product; and
- one final ranking submission per round.

## Message validation and product presentation

All messages are treated as untrusted text. Once the organizer publishes the grammar, the parser will require a version, action/type, unique correlation ID, buyer public identity, product ID, declared price, and a bounded payload or artifact reference. Unknown versions, missing fields, duplicate keys, conflicting identities, oversized content, expired requests, or requests outside the configured round become explicit rejections without calling DeliverCheck.

The parser enforces SharedNet's 32,768-byte message maximum and the narrower service limits relevant to each embedded request. Artifact use remains disabled until the Arena confirms when it is permitted and how an artifact is bound to a purchase.

The runner never treats a display name or identity written inside message content as authentication. Sender Principal, Agent, and Instance metadata from the SharedNet message envelope is recorded separately and matched according to the organizer's identity rule.

Product presentation is generated from the production agent card and listing at the configured DeliverCheck origin. It presents only:

- **DeliverCheck** — “Make one agent’s output usable by the next.”
- `diagnose`: 0 credits; validates one bounded top-level JSON object without modification.
- `repair`: 7 credits; runs SharedOS-authorized repair and independent verification.
- maximum request body 64 KiB and application deadline 240 seconds; and
- factual-truth proof, remote references, arbitrary fetching, credentials, CSV, persistence, and billing verification are outside the service.

Presentation must use the organizer-confirmed message type and schedule. It must not claim that the public price field verifies payment or that DeliverCheck is registered before registration is confirmed.

## Seller request, payment, execution, and delivery flow

For `diagnose`, after schema/message validation and duplicate checks, the runner calls the production diagnose endpoint or MCP tool, records only request/result hashes and the sanitized outcome, and sends the organizer-defined response. No repair operation and no payment check occurs.

For `repair`, the state machine is:

```text
received -> validated -> awaiting_payment -> payment_confirmed
         -> executing -> result_ready -> delivery_confirmed
```

Terminal failures include `invalid_request`, `payment_mismatch`, `deadline_expired`, `service_rejected`, and `delivery_rejected`. Operational uncertainty remains retryable and is never converted into successful repair.

Payment confirmation uses only a transfer in the seller Principal's official `ledger`. A message, screenshot, free-form receipt, quoted transfer ID, HTTP request field, or DeliverCheck `priceCredits` value is insufficient. The matcher requires all organizer-confirmed fields, expected to include:

- incoming direction to the configured seller Principal;
- an addressed-to Agent or Instance accepted by the Arena profile;
- exactly 7 credits for `repair`;
- the unique order ID in the required memo field;
- the correct Arena Room binding when required;
- the expected buyer Principal and paying Instance when required; and
- a transfer creation time inside the request window.

A transfer ID can satisfy one order only. Ambiguous or multiple matches stop the order for review. The runner never refunds, reverses, or spends received credits automatically.

After payment confirmation, the runner invokes only `https://delivercheck.vercel.app/api/v1/repair` or the equivalent configured MCP tool with the bounded request contract. It accepts `passed_checks` only from the complete deployed coordinator result, preserves `needs_information` and `cannot_repair`, and keeps operational errors distinct. It binds delivery to the exact response hash and candidate hash returned by the verified pipeline.

The outgoing result is shaped by the organizer-confirmed delivery grammar and size rule. If the result exceeds the Room message limit, the runner must use an organizer-approved artifact flow; it must not silently truncate evidence. Public errors are sanitized and contain no raw payload, stack, path, credential, or internal SharedOS audit detail.

Before retrying an uncertain send, the runner searches later Room messages for its stable order/delivery marker. It does not blindly repeat a message after an unknown outcome.

## Round 1 evaluation and ranking

The runner must discover candidates only through the organizer-confirmed Arena catalogue. It selects at least three distinct products and records the selection before invoking any of them. DeliverCheck itself does not count as one of the products being evaluated.

For each product it runs a bounded, product-appropriate trial and records:

- product and seller public IDs;
- the exact test objective and input hash;
- returned output/evidence hash;
- latency and protocol outcome;
- one concrete disagreement tied to observable output, such as an incorrect field, unsupported factual claim, missing evidence, protocol mismatch, or failure to meet an advertised behavior; and
- a short reproducible reason for the disagreement.

Generic criticism does not satisfy the disagreement requirement. If the runner cannot produce one evidence-backed disagreement, it tries another bounded case or chooses another product. It must not fabricate a flaw.

After at least three products have one specific disagreement each, the runner computes a deterministic ranking from documented criteria such as task completion, correctness, evidence, protocol compliance, and latency. It records the proposed ordered list and rationale. Submission remains disabled until the organizer confirms the ranking command/message/API and deadline. The existing SharedNet `decision approve/deny` commands must never be used for ranking.

## Round 2 purchase plan

Before Round 2, the runner takes a read-only balance snapshot and builds a complete purchase plan across at least three distinct products. The default policy is:

```text
minimum settled spend: 80 credits
maximum authorized spend: 100 credits
minimum distinct products: 3
per-product maximum: organizer profile or explicit operator ceiling
```

The planner chooses the lowest deterministic useful combination inside the 80–100 credit window. If the confirmed catalogue cannot satisfy it, the runner stops before paying. Room messages cannot revise a budget. The runner also refuses a plan above the official balance or past the Round 2 purchase cutoff.

For every purchase, it appends and syncs a unique intent before running `pay`. Its memo includes the organizer-approved unique purchase ID. If the CLI result is lost or the runner crashes, restart first queries `ledger` for that exact recipient, amount, memo, and Room binding. It never repeats an uncertain payment until reconciliation proves no transfer occurred. Because transfers are final, an ambiguous outcome stops further spending.

After each confirmed transfer it refreshes the official balance, verifies the debit and transfer record, marks the transfer ID consumed, then follows the product's confirmed invocation/delivery protocol. It tracks planned, submitted, settled, failed, and unknown amounts separately. Only settled official transfers count toward the 80-credit minimum.

The runner halts spending when any of these is true:

- settled plus unknown exposure reaches the maximum;
- fewer than three distinct products can be completed within the remaining budget;
- an unknown transfer cannot be reconciled;
- the catalogue, recipient, price, or Room binding changes after planning;
- the official balance differs unexpectedly; or
- the deadline safety margin is reached.

## Deadlines and bounded execution

All Arena timestamps must be absolute instants derived from organizer-provided local time plus timezone. The runner keeps separate margins for purchase settlement, service execution, delivery, and ranking submission. New work is refused when its worst-case 240-second DeliverCheck deadline plus the configured network and submission margin would cross the relevant cutoff.

Every CLI and HTTP subprocess has a deadline, bounded output capture, and sanitized error mapping. The monitor uses the server's maximum 25-second long poll and remains interruptible. There is no load testing, speculative payment, unbounded retry, or retry past a round cutoff.

## Simulation acceptance criteria

Before live enablement, deterministic fixtures must demonstrate:

1. cursor replay and reconnection without duplicate handling;
2. duplicate request, delivery, and transfer rejection;
3. a successful free diagnosis;
4. paid repair held until an official matching ledger record exists;
5. rejection of a message-claimed or mismatched payment;
6. lost payment response reconciled from the ledger without a second transfer;
7. three Round 1 products with one evidence-backed disagreement each and a proposed ranking;
8. an exactly 80-credit Round 2 plan across at least three products;
9. deadline and budget cutoffs;
10. activity-ledger hash-chain validation and corruption failure; and
11. zero calls to all sender, payer, join, decision-resolution, and authenticated POST adapters.

Simulation output must be labeled `SIMULATION` and cannot be accepted as an Arena submission, purchase receipt, seller delivery, or proof of live operation.

## Remaining design blockers

The simulation control layer is implemented without an Arena-specific product or ranking assumption. The organizer must still supply the missing Arena profile fields listed in [arena-protocol.md](arena-protocol.md). After those fields are available, the confirmed discovery and ranking adapters can be wired into the existing interfaces and exercised in a read-only live shadow run before message sending or credit spending is enabled.
