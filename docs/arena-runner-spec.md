# DeliverCheck Arena runner specification

Status: Checkpoint 6B3 implements the unattended control loop, recovery stores, bounded adapters, and adversarial simulation on `codex/arena-operator`. Live startup remains fail-closed until the organizer supplies the protocol profile listed in [arena-protocol.md](arena-protocol.md).

## Execution and authority

`simulate` is the default mode. It uses only in-memory SharedNet effects and reports `real_sharednet_side_effects: 0`. `live` requires all of the following before the CLI adapter is allowed to operate:

- the separate environment switch `DELIVERCHECK_ARENA_LIVE=enabled`;
- a bounded public JSON profile named by `DELIVERCHECK_ARENA_CONFIG`;
- a trusted, repository-local organizer integration module named by `DELIVERCHECK_ARENA_INTEGRATION`;
- exact reviewed CLI `0.1.8` and server protocol `1.0.0`, verified from live status/discovery rather than copied configuration alone;
- organizer-confirmed Room, Instance, account Principal, submission identity, seller recipient and its Principal mapping;
- a complete list of DeliverCheck self-identities;
- organizer-confirmed marketplace, purchase, ranking, canonical seller, timing, Room-binding, and exact-price conventions; and
- a clean repository whose history contains production release `b09b30eda9c1c450e0490600da4372554d1894c1`.

The profile contains public identifiers and protocol choices only. SharedNet credentials remain in the official CLI store. The runner does not open that store or accept credentials from messages, product listings, configuration, headers, or customer payloads.

The live entrypoint is `npm run arena:live`. It is noninteractive and supported only on Linux or Ubuntu WSL. The actual Arena session must run from `/home/ru765/SharedOS-Hackathon` inside Ubuntu-24.04 WSL. It invokes `npx` with argument arrays, `shell: false`, bounded output, and deadlines. Native Windows remains supported for development, tests, builds, and simulation; live startup fails before any SharedNet identity, protocol, Room, message, ledger, or payment operation with `Live SharedNet execution requires Linux or Ubuntu WSL. Native Windows supports simulation only.`

## Single-writer unattended loop

The entrypoint atomically acquires `<activity-ledger>.lock`. A second process using that state file is refused. A stale lock whose process no longer exists is replaced; a malformed lock requires manual inspection. `SIGINT` and `SIGTERM` stop new work, record a resumable shutdown event, release the lock, and leave the phase unchanged.

The loop validates preflight, publishes or reconciles the presentation, waits for absolute round timestamps, monitors seller requests, executes Round 1, waits for Round 2, executes purchases, and finishes without prompts. Seller monitoring runs between external critique, ranking, payment, and invocation actions. Every network family has a configurable bound no greater than 240 seconds. Transient reads are retried up to a bounded attempt count with exponential backoff. Configuration, identity, ledger-integrity, budget, and missed-deadline failures halt; exhausted isolated product/order failures remain recorded without halting unrelated work.

The durable phase machine is:

```text
preflight -> waiting -> critique -> market -> completed
      \          \          \          \
                         unsafe/unrecoverable -> halted
```

`critique` and `market` are valid startup phases. Re-running either phase reconstructs completed substeps and continues them idempotently.

## Durable state and reconciliation

The mode-0600 append-only JSON Lines ledger is hash-chained and fsynced after every record. It stores public identifiers, stable operation IDs, hashes, sequence numbers, transfer IDs, amounts, bounded outcome codes, and before/after intent markers. It excludes credentials, invite material, raw CLI stderr, full Room messages, customer payloads, and full DeliverCheck responses.

Pending service requests must be available after their source message disappears, so they use a separate mode-0700 directory with one atomic mode-0600 order file per request. Each file binds the complete validated request to the order metadata and hash. It is deleted only after delivery is confirmed. The message cursor and pending-order store are independent.

On every monitoring cycle the operator:

1. reads all available Room pages after the application cursor, up to the configured safe page bound;
2. processes each message independently and records its sequence/message-ID binding;
3. long-polls only if the snapshot is empty; and
4. rechecks every stored `awaiting_payment`, `payment_verified`, or pending-delivery order even if its original message never reappears.

One order failure produces an order-scoped event and does not block other orders. Historical presentation and delivery reconciliation also page from a bounded sequence boundary. If the complete bounded history cannot prove whether a send happened, the operator refuses to resend.

## Seller workflow

The presentation advertises only DeliverCheck `diagnose` at 0 credits and `repair` at exactly 7 credits. Diagnose never checks payment and never invokes repair. Repair is held until the seller's official SharedNet ledger proves a matching transfer.

Ledger search pages with documented `ledger --before <transfer-id> --last 100`. It stops at the request timestamp boundary, at a target transfer, at exhaustion, or at the safe page limit. A receipt message or a claimed transfer ID is never proof. A valid incoming transfer must match:

- buyer Principal and paying Instance from the message envelope;
- seller Principal and exact addressed-to recipient;
- unique order ID memo;
- exactly 7 credits;
- configured Room binding; and
- a timestamp no earlier than the order.

If multiple valid transfers exist, the operator deterministically selects the earliest by timestamp then transfer ID, fulfills once, and records every other valid transfer as surplus for audit. It never delivers twice or automatically refunds.

The request goes to the bounded DeliverCheck client only after settlement. Service intent, response hash, delivery intent, and confirmed Room message are recorded separately. A crash after sending is reconciled from paginated Room history. Public delivery remains bounded and contains no stack, credential, local path, or raw SharedOS audit.

## Catalogue and canonical sellers

Marketplace output is untrusted. The operator considers at most 500 listings. Each listing is JSON-bounded to 64 KiB; names, purposes, IDs, prices, HTTPS endpoint metadata, and identity mappings have independent limits. Malformed, duplicate, unsupported, credential-bearing URL, or unconfirmed listings are skipped with a sanitized audit event. One bad listing cannot reject the catalogue.

A Principal ID is the canonical seller key. An Agent or Instance alias is accepted only with an explicit organizer-confirmed mapping to one Principal and an exact verified payment recipient. Agent, Instance, Principal, seat, and node identifiers are never inferred to be equivalent. Seller counts, restart exclusions, and duplicate-alias suppression use canonical Principal IDs.

Every configured DeliverCheck Principal, Agent, Instance, submission, seat, and recipient identity is excluded from evaluation and purchasing. Live payment refuses an alias without its verified recipient Principal mapping.

## Round 1

The operator selects actual attempts from at least three distinct canonical sellers. Availability and invocation failures are isolated by product. An invocation timeout can be recorded as the specific disagreement because it is evidence from an actual bounded attempt; catalogue rejection alone cannot become a disagreement. Successful results require a configured product-specific critique strategy or concrete protocol/evidence failure. The operator does not assume a third-party listing contains DeliverCheck's simulation-only `assertion` structure.

Each evaluation records an evidence hash, latency, protocol/evidence outcome, one reproducible disagreement, score, product ID, and canonical seller. Ranking is deterministic. A `ranking_submission_intent` precedes the call, and the organizer adapter must be idempotent for stable operation ID `round1-ranking`. Restart resubmits that same operation ID; it never invents or uses SharedNet membership decisions as rankings.

## Round 2

The planner chooses useful services from at least three distinct canonical non-self sellers. Settled spend must be 80–100 whole credits. Products and sellers already purchased before restart are excluded.

For each purchase, the ledger records intent and payment-attempt markers before calling `pay`. The official outgoing transfer is then located by pagination and must exactly match transfer ID, source Principal, destination Principal, addressed recipient, memo/order, amount, and Room. Absolute balance change is not used as payment proof because incoming sales can occur concurrently. `sent` and `received` counters are recorded only as secondary consistency evidence.

If the process crashes during payment, restart first searches the official ledger. Once any payment call has an unknown outcome, the operator does not issue it again merely because a recent page is empty. It keeps the purchase pending until the exact transfer appears or the round ends safely. This avoids duplicate irreversible transfers.

Settlement is persisted before product invocation. A crash then retries the vendor operation with the same stable purchase ID. If a paid vendor invocation times out or fails, the failure is recorded accurately, the settled credits still count, and the operator continues with remaining requirements. No service failure can turn a transfer into an invented success.

## Simulation acceptance evidence

`npm run arena:simulate` uses no live adapter. It injects and proves:

- a delayed paid repair whose transfer is behind more than 100 ledger records;
- two valid incoming payments with one delivery and a recorded surplus;
- a forged receipt message;
- concurrent incoming revenue during Round 2;
- malformed catalogue data, a DeliverCheck self-listing, a duplicate seller alias, and a failed competitor;
- a crash/restart in critique, after payment verification in market, and after a delivery send;
- three evaluations from distinct canonical sellers and one concrete disagreement each;
- one idempotent ranking submission;
- exactly 80 credits across three distinct sellers;
- cursor-correct reads/waits, paginated messages and ledger, and pending-delivery reconciliation;
- both rounds completed with zero prompts; and
- `real_sharednet_side_effects: 0`.

Simulation output is evidence about local control flow only. It is not an Arena entry, payment receipt, product registration, or live SharedNet result.

## Organizer-only blockers

The organizer must still provide the Arena Room/invite and Agent rule, submission identity, seller/payment convention, product discovery and invocation protocol, canonical identity mappings, ranking method, absolute round timing/timezone, and the missing validity condition. A repository-local integration module can be implemented only from that confirmed protocol. Until then, `npm run arena:live` fails before SharedNet side effects.
