# DeliverCheck Arena operator launch runbook

This runbook describes the Checkpoint 6B3 operator. It does not authorize a live run. The current organizer-only blockers at the end of this document must be resolved first.

## Components

- `sharednet.ts`: pinned `sharednet@0.1.8`, argument-array execution, Linux/Windows executable selection, cursor-aware simulation, and actual CLI/server version discovery.
- `ledger.ts` and `state.ts`: fsynced hash-chained actions and resumable phases/substeps.
- `orders.ts`: request persistence independent of the message cursor.
- `pagination.ts`: bounded Room and `ledger --before` traversal.
- `seller.ts`: delayed payment reconciliation, deterministic duplicate-payment handling, one delivery, and bounded DeliverCheck calls.
- `rounds.ts`: per-listing isolation, canonical seller rules, evidence-backed critique, idempotent ranking, exact outgoing-transfer verification, and 80–100 credit planning.
- `unattended.ts`: timestamp-driven single-writer event loop and bounded transient retry.
- `lock.ts`: state-file process lock.
- `live.ts` and `scripts/arena-live.ts`: guarded noninteractive live bootstrap.
- `simulation.ts`: delayed effects, pagination, concurrent revenue, malformed products, aliases, failures, and restart recovery with no SharedNet access.

The production service remains `https://delivercheck.vercel.app`; this branch does not deploy or change it.

## Verify locally

Use the metadata form present in this checkout. For this repository:

```bash
git --git-dir=.git-local --work-tree=. merge-base --is-ancestor \
  b09b30eda9c1c450e0490600da4372554d1894c1 HEAD
npm run typecheck
npm run build
npm test
npx vitest run tests/arena
npm run arena:simulate
npm run sharedos:proof
npm run demo:core
npm run smoke:service
npm audit
git --git-dir=.git-local --work-tree=. diff --check
```

The live repository check automatically uses `.git-local` when present and ordinary `.git` otherwise.

The simulation must report three evaluated canonical sellers, one disagreement per product, one ranking submission, 80 credits paid to three sellers, delayed repair delivered exactly once, delivery reconciliation, more than one ledger page, concurrent income, critique/market restarts, malformed listing isolation, no self-evaluation, `completed`, and zero real SharedNet side effects.

## Public live profile

Do not put invites, tokens, API keys, stored credential paths, or credential values in this file. The maximum profile size is 64 KiB. Required fields are:

```json
{
  "mode": "live",
  "explicit_live_enablement": true,
  "protocol_profile_version": "ORGANIZER_CONFIRMED",
  "cli_version": "0.1.8",
  "server_protocol_version": "1.0.0",
  "arena_room_id": "rom_...",
  "arena_instance_id": "i_...",
  "account_principal_id": "p_...",
  "submission_identity": { "kind": "instance", "id": "i_...", "organizer_confirmed": true },
  "seller_payment_recipient": { "kind": "instance", "id": "i_...", "organizer_confirmed": true },
  "seller_payment_principal_id": "p_...",
  "self_identities": [
    { "kind": "principal", "id": "p_...", "organizer_confirmed": true },
    { "kind": "instance", "id": "i_...", "organizer_confirmed": true }
  ],
  "marketplace": { "adapter": "CONFIRMED", "protocol_version": "CONFIRMED", "organizer_confirmed": true },
  "purchase_convention": { "adapter": "CONFIRMED", "memo_prefix": "CONFIRMED", "canonical_recipient": "principal", "exact_price": true, "organizer_confirmed": true },
  "ranking_method": { "adapter": "CONFIRMED_IDEMPOTENT", "organizer_confirmed": true },
  "canonical_identity": { "seller_key": "principal", "mappings_verified": true, "organizer_confirmed": true },
  "round_timing": {
    "arena_starts_at": "ABSOLUTE_TIMESTAMP_WITH_OFFSET",
    "round_1_ends_at": "ABSOLUTE_TIMESTAMP_WITH_OFFSET",
    "round_2_starts_at": "ABSOLUTE_TIMESTAMP_WITH_OFFSET",
    "round_2_ends_at": "ABSOLUTE_TIMESTAMP_WITH_OFFSET",
    "timezone": "IANA_TIMEZONE"
  },
  "delivercheck_origin": "https://delivercheck.vercel.app",
  "payment_room_binding": true,
  "timeouts": {
    "sharednet_read_ms": 30000,
    "ledger_ms": 30000,
    "marketplace_ms": 30000,
    "product_invocation_ms": 60000,
    "delivercheck_ms": 240000
  }
}
```

Every self Principal, Agent, Instance, seat, submission, and recipient ID must appear in `self_identities`. The seller recipient must map to `account_principal_id`. Every third-party non-Principal listing must carry its own verified canonical Principal and recipient mapping.

## Organizer integration module

Because SharedNet 0.1.8 publishes no Arena marketplace or ranking protocol, the runner does not invent one. After organizer confirmation, implement a reviewed module inside this repository that exports:

```ts
export function createArenaIntegrations(config: LiveArenaConfig): {
  marketplace: ProductMarketplace;
  ranking: RankingAdapter;
};
```

Its `marketplace.adapter_id`, `marketplace.protocol_version`, and idempotent `ranking.method` must exactly match the profile. The loader rejects paths outside the repository.

## Read-only shadow check

Before enabling live mode:

1. Validate the profile and integration module with fixture adapters.
2. Confirm actual CLI `0.1.8` and server protocol `1.0.0` through the implemented status/discovery checks.
3. Confirm `whoami` matches the configured Room, Instance, and Principal.
4. Verify the ledger hash chain, state lock, and pending-order directory permissions.
5. Reconcile the durable Room cursor using read-only pages.
6. Read balance and ledger without paying.
7. Validate each catalogue item independently and build a dry 80–100 credit plan.
8. Prepare but do not submit the ranking.

Do not use a SharedNet membership decision as a ranking method.

## Launch command

Only after the organizer profile, integration module, shadow check, and authorization are complete:

```bash
DELIVERCHECK_ARENA_LIVE=enabled \
DELIVERCHECK_ARENA_CONFIG=../delivercheck-arena-profile.json \
DELIVERCHECK_ARENA_INTEGRATION=./src/arena/integrations/confirmed-arena.ts \
DELIVERCHECK_ARENA_STATE=.arena-state/activity.jsonl \
npm run arena:live
```

The profile is public protocol configuration despite the illustrative filename. Keep the active profile outside the repository so the required clean-worktree check remains meaningful. Omit `DELIVERCHECK_ARENA_STATE` to use `.arena-state/activity.jsonl`. `.arena-state/` is ignored.

The process has no prompt. It obtains the process lock, validates release ancestry and a clean worktree, validates protocol/identity/adapters, restores state, publishes once, waits for absolute timestamps, monitors throughout both rounds, and exits after completion or a clean signal.

Never launch two processes against one state path. Never delete a lock while its PID is running. Never edit the action ledger or pending-order files. An uncertain payment remains pending and is searched through paginated official ledger records; it is not blindly issued again.

## Current organizer-only blockers

- Arena Room invitation, join time, and Agent/seat rules
- Devpost submission identity
- seller recipient, Principal mapping, memo, exact-price, and Room-binding convention
- product catalogue, invocation, purchase-request, and delivery protocols
- canonical seller mapping source
- idempotent ranking submission method
- absolute round timestamps and timezone
- complete submission-validity conditions, including the missing sixth condition

Until all are confirmed, use only `npm run arena:simulate`. Running `npm run arena:live` without both the explicit switch and complete profile fails before creating SharedNet effects.
