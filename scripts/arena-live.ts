import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { computeCanonicalHash } from "../src/verify/canonical.js";
import { ProductionDeliverCheckRestClient } from "../src/arena/delivercheck.js";
import { FileActionLedger } from "../src/arena/ledger.js";
import { loadLiveArenaConfig, loadOrganizerIntegrations } from "../src/arena/live.js";
import { ArenaProcessLock } from "../src/arena/lock.js";
import { ArenaOperator } from "../src/arena/operator.js";
import { FilePendingOrderStore } from "../src/arena/orders.js";
import { assertArenaRepository } from "../src/arena/repository.js";
import { SharedNetCliAdapter } from "../src/arena/sharednet.js";
import { ArenaStateController } from "../src/arena/state.js";
import { runUnattendedArena } from "../src/arena/unattended.js";

const RELEASE = "b09b30eda9c1c450e0490600da4372554d1894c1";
const repository = resolve(process.cwd());

async function main(): Promise<void> {
  if (process.env.DELIVERCHECK_ARENA_LIVE !== "enabled") throw new Error("Live Arena operation is disabled. Set DELIVERCHECK_ARENA_LIVE=enabled only after organizer configuration is confirmed.");
  const configPath = process.env.DELIVERCHECK_ARENA_CONFIG;
  const integrationModule = process.env.DELIVERCHECK_ARENA_INTEGRATION;
  if (!configPath || !integrationModule) throw new Error("Live Arena operation requires explicit configuration and organizer integration module paths.");
  await assertArenaRepository(repository, RELEASE);
  const config = await loadLiveArenaConfig(resolve(repository, configPath));
  const integrations = await loadOrganizerIntegrations(integrationModule, config, repository);
  const statePath = resolve(repository, process.env.DELIVERCHECK_ARENA_STATE ?? ".arena-state/activity.jsonl");
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const lock = await ArenaProcessLock.acquire(`${statePath}.lock`);
  const abort = new AbortController();
  const shutdown = () => abort.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const state = await ArenaStateController.open(await FileActionLedger.open(statePath));
    const orders = await FilePendingOrderStore.open(join(dirname(statePath), "pending-orders"));
    const sharednet = new SharedNetCliAdapter(config, undefined, config.timeouts.sharednet_read_ms);
    let operator: ArenaOperator;
    operator = new ArenaOperator({
      config,
      state,
      sharednet,
      delivercheck: new ProductionDeliverCheckRestClient(config.delivercheck_origin, fetch, config.timeouts.delivercheck_ms),
      marketplace: integrations.marketplace,
      ranking: integrations.ranking,
      orders,
      timeouts: config.timeouts,
      seller_policy: { room_id: config.arena_room_id, seller_principal_id: config.account_principal_id, payment_recipient: config.seller_payment_recipient, require_room_binding: config.payment_room_binding },
      round_two_policy: { minimum_spend: 80, maximum_spend: 100, minimum_sellers: 3, room_id: config.arena_room_id, bind_payments_to_room: config.payment_room_binding, self_ids: new Set(config.self_identities.map((identity) => identity.id)), purchase_memo_prefix: config.purchase_convention.memo_prefix },
      order_id: (message) => `order-${computeCanonicalHash({ id: message.id, sequence: message.sequence }).slice(-24)}`,
      after_external_action: async () => { if (["waiting", "critique", "market"].includes(operator.phase)) await operator.monitorOnce(0); },
    });
    const outcome = await runUnattendedArena({ operator, timing: config.round_timing, signal: abort.signal });
    process.stdout.write(`${JSON.stringify({ status: outcome, phase: operator.phase })}\n`);
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    await lock.release();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Arena operator failed safely."}\n`);
  process.exitCode = 1;
});
