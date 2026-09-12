# DeliverCheck Arena operator launch runbook

This runbook covers the guarded operator added in Checkpoint 6B2. Simulation is available now. Live launch remains disabled until every Arena-specific value is organizer-confirmed.

## Architecture

The implementation lives under `src/arena/`:

- `config.ts` validates live configuration and preserves Principal, Agent, Instance, and node identity kinds.
- `sharednet.ts` wraps `sharednet@0.1.8` with argument arrays and `shell: false`. Credentials remain inside the official CLI.
- `ledger.ts` writes a mode-0600 JSON Lines action ledger with a SHA-256 hash chain and fsync after each append.
- `state.ts` reconstructs phase, cursor, messages, orders, transfers, evaluations, rankings, and purchases from that ledger.
- `messages.ts` recognizes the versioned structured request and the narrow `DeliverCheck diagnose:` or `DeliverCheck repair:` natural-language form.
- `seller.ts` holds paid repair until an exact official ledger record matches the order, buyer, recipient, amount, Room, and time.
- `rounds.ts` records three evidence-backed critiques, prepares a deterministic ranking through an injected adapter, and plans 80–100 credits across at least three sellers.
- `operator.ts` enforces `preflight → waiting → critique → market → completed`, with fail-closed transition to `halted`.
- `simulation.ts` supplies deterministic messages, identities, transfers, products, requests, restart, and responses without reaching SharedNet.

DeliverCheck service calls use the production REST adapter at `https://delivercheck.vercel.app`. The operator does not alter or deploy that service. The simulation uses an injected fake service client.

## Verify the build

From the repository root:

```bash
git --git-dir=.git-local --work-tree=. merge-base --is-ancestor \
  b09b30eda9c1c450e0490600da4372554d1894c1 HEAD
npm run typecheck
npm test
npm run build
npm run sharedos:proof
npm run smoke:service
npm run arena:simulate
npm audit
git --git-dir=.git-local --work-tree=. diff --check
```

`npm run arena:simulate` must report `SIMULATION`, three evaluated products, three disagreements, a ranking, 80 spent simulated credits, three purchased sellers, a ledger-verified paid repair, `completed`, and zero real SharedNet side effects.

## Live configuration gate

Do not place an invitation, API key, token, credential path, or credential content in configuration. The official CLI retains those values. The live profile contains only explicit public protocol values:

```text
mode = live
explicit_live_enablement = true
protocol_profile_version
arena_room_id                      # rom_... and organizer confirmed
arena_instance_id                  # i_... for this Arena seat
account_principal_id               # p_... purse owner
submission_identity.kind           # principal | agent | instance | node
submission_identity.id
submission_identity.organizer_confirmed = true
seller_payment_recipient.kind      # principal | agent | instance
seller_payment_recipient.id
seller_payment_recipient.organizer_confirmed = true
ranking_method.adapter
ranking_method.organizer_confirmed = true
round_timing.arena_starts_at        # absolute timestamp with offset
round_timing.round_1_ends_at
round_timing.round_2_starts_at
round_timing.round_2_ends_at
round_timing.timezone
delivercheck_origin = https://delivercheck.vercel.app
payment_room_binding
```

The seller policy must exactly match the profile. Round 2 self-payment protection must contain the account Principal, Arena Instance, and seller recipient as distinct IDs. Preflight also calls the CLI's safe `whoami` operation and requires the selected Room, Instance, and Principal to equal the profile.

The configurable product-discovery and ranking adapters must be based on organizer-confirmed protocol. `decision approve/deny` is not a ranking adapter. Do not implement a room-message convention merely because another participant uses it.

## Shadow launch

After configuration and the missing adapters exist, perform a read-only shadow launch:

1. Validate the complete live profile without constructing any mutating request.
2. Confirm the CLI and server protocol versions.
3. Confirm `whoami` returns the configured Room, Instance, and Principal.
4. Open and validate the action-ledger hash chain.
5. Read from the recovered durable cursor and verify message parsing without sending replies.
6. Read balance and ledger, then test payment matching against historical fixtures only.
7. Discover at least three products through the confirmed catalogue without invoking or paying.
8. Prepare a ranking locally without submitting it.
9. Produce a dry purchase plan totaling 80–100 credits across at least three non-self sellers.

Any identity mismatch, unsupported protocol version, malformed catalogue item, unavailable adapter, unknown prior side effect, ledger corruption, budget failure, or deadline failure stops at `halted`.

## Live operation sequence

Enable this sequence only after the shadow launch passes and the organizer's start time arrives:

1. Call operator preflight once.
2. Publish the bounded DeliverCheck presentation once. A pending presentation intent is never blindly resent after an unknown outcome.
3. Keep one monitor in the fixed Arena working directory. It reads after the durable application cursor before waiting, so a CLI-cursor advance cannot lose a message after a crash.
4. For free diagnoses, invoke DeliverCheck and reply with the order-linked bounded result.
5. For repairs, announce the unique order and wait. Invoke repair only after the seller's official SharedNet ledger contains the exact 7-credit incoming transfer. Never trust a receipt message.
6. At Round 1 start, execute at least three distinct products, store output hashes and measured latency, and produce one concrete disagreement for each. Submit the ranking only through the configured idempotent ranking adapter.
7. At Round 2 start, read the official balance and plan the smallest deterministic combination totaling 80–100 credits across at least three sellers. Check availability before paying. Append and fsync each intent, reconcile the ledger, pay once, verify the official transfer and balance delta, then invoke the purchased useful service.
8. Stop before each configured deadline margin. Complete only after all round invariants pass.

When a send outcome is unknown and the exact content cannot be found in a complete Room read, the operator halts instead of risking a duplicate. When a payment outcome is unknown, it reconciles the official ledger by its unique memo before considering another transfer.

## Recovery

Restart with the same fixed working directory and the same ledger path. Never edit the JSON Lines ledger. Startup validates every sequence, previous hash, and event hash. The recovered state prevents duplicate messages, deliveries, transfer consumption, product evaluations, ranking submissions, and purchases.

If the final ledger line is incomplete or the hash chain fails, preserve the file and halt. Do not truncate, repair, or replace it during the competition.

## Current live blockers

- Arena Room invitation and required Agent/seat rules
- organizer-confirmed Devpost submission identity
- organizer-confirmed seller recipient and payment-correlation convention
- official product discovery and purchase grammar
- official ranking submission adapter
- absolute round timing and timezone
- all submission-validity conditions

Until these are supplied, run only `npm run arena:simulate`.
