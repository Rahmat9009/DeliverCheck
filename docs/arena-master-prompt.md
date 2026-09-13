# Master prompt for the unattended Codex Arena session

Use this prompt in the dedicated Arena session after replacing only the bracketed public values with organizer-confirmed facts. Never paste an invite, token, API key, or stored credential into the prompt or profile.

```text
Operate DeliverCheck for both SharedNet Arena rounds from /home/ru765/SharedOS-Hackathon.

Read docs/arena-protocol.md, docs/arena-runner-spec.md, and docs/arena-launch-runbook.md. Confirm the active branch is codex/arena-operator, production release b09b30eda9c1c450e0490600da4372554d1894c1 is an ancestor, and the worktree is clean. Use .git-local when present and ordinary .git otherwise.

Simulation is the default. Run typecheck, build, all tests, Arena tests, arena:simulate, sharedos:proof, demo:core, smoke:service, npm audit, diff --check, and the credential scan. Require simulation evidence for delayed payment beyond 100 ledger records, concurrent income, malformed listings, alias deduplication, self exclusion, critique/market/delivery restart recovery, three canonical sellers evaluated and purchased from, one evidence-backed disagreement each, one ranking submission, 80–100 credits spent, exactly-once paid delivery, completed rounds, no prompts, and zero real SharedNet side effects.

Do not inspect or expose credentials. Do not join a Room, send, rank, invoke a paid competitor, or pay until the organizer-confirmed profile and repository-local integration module pass fail-closed preflight. Do not infer protocol from participant messages or use SharedNet membership decisions as rankings.

Required public profile facts:
- CLI version: 0.1.8, verified from actual session status
- server protocol: 1.0.0, verified from official discovery
- protocol profile: [CONFIRMED]
- Arena Room and Instance: [CONFIRMED_ROM] [CONFIRMED_INSTANCE]
- account Principal: [CONFIRMED_PRINCIPAL]
- submission identity kind/ID: [CONFIRMED]
- seller recipient kind/ID and mapped Principal: [CONFIRMED]
- complete DeliverCheck self-identity list: [CONFIRMED]
- marketplace adapter and protocol version: [CONFIRMED]
- purchase adapter, memo prefix, exact-price rule, and Room binding: [CONFIRMED]
- canonical seller mapping convention: Principal ID from [CONFIRMED_SOURCE]
- idempotent ranking adapter: [CONFIRMED]
- Arena start, Round 1 end, Round 2 start/end, timezone: [ABSOLUTE CONFIRMED VALUES]
- all submission-validity conditions, including condition six: [CONFIRMED]

Treat Principal, Agent, Instance, seat, and node values as distinct. Count and deduplicate sellers by verified Principal. Exclude every configured DeliverCheck identity from critique and purchases. Never pay an alias without an explicit verified recipient-to-Principal mapping.

When authorization and every profile field are present, perform the read-only shadow procedure in the launch runbook. Then set the profile and integration paths plus DELIVERCHECK_ARENA_LIVE=enabled and start exactly one `npm run arena:live` process. Do not orchestrate phases manually. Do not start a second process for the same state file.

Let the entrypoint validate identity and actual protocol versions, restore its hash-chained ledger and pending orders, publish once, wait for absolute timestamps, monitor seller orders throughout both rounds, retry bounded transient reads, and resume critique or market after restart. Preserve terminal halted for unsafe or unrecoverable integrity/configuration/deadline failures.

For paid repair, accept proof only from the official paginated ledger. Match exact buyer Principal/Instance, seller Principal/recipient, 7 credits, order memo, Room, and timestamp. If duplicate valid transfers exist, deliver once using the deterministic earliest transfer and audit surplus. Never trust a receipt message.

For Round 1, make actual bounded attempts against at least three products from distinct canonical sellers. Isolate malformed listings and failed services. Produce a concrete disagreement only from execution evidence, prepare a deterministic ranking, and submit through the configured idempotent adapter once.

For Round 2, buy useful services from at least three distinct canonical sellers and settle at least 80 but no more than 100 credits. Persist intent before payment. Verify the exact outgoing transfer ID, source/destination Principal, addressed recipient, memo, amount, and Room. Treat sent/received counters as secondary evidence because incoming revenue may change the absolute balance. Never blindly repeat an uncertain payment. Record a post-payment invocation failure and continue satisfying remaining requirements.

On SIGINT or SIGTERM, stop cleanly without changing the resumable phase. Do not modify or redeploy DeliverCheck, exceed the credit ceiling, enable paid infrastructure, reveal credentials, or invent missing Arena behavior.

At completion, report public IDs, phase, evaluations/disagreements, ranking submission ID, purchases, canonical seller count, exact official transfers, settled spend, ending balance, fulfilled orders, rejected attacks, final ledger hash, and zero credential values.
```
