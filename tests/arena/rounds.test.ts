import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryActionLedger } from "../../src/arena/ledger.js";
import { runRoundTwo } from "../../src/arena/rounds.js";
import { runArenaSimulation, SimulationMarketplace } from "../../src/arena/simulation.js";
import { SimulatedSharedNetAdapter } from "../../src/arena/sharednet.js";
import { ArenaStateController } from "../../src/arena/state.js";

async function marketState() {
  const state = await ArenaStateController.open(new MemoryActionLedger());
  await state.transition("waiting", "test");
  await state.transition("critique", "test");
  await state.transition("market", "test");
  return state;
}

const policy = { minimum_spend: 80, maximum_spend: 100, minimum_sellers: 3, room_id: "rom_SIMULATE1", bind_payments_to_room: true, self_ids: new Set(["p_SELLER0001", "i_SELLER0001"]) };

describe("Arena rounds", () => {
  it("completes both deterministic rounds with no real SharedNet side effects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arena-simulation-test-"));
    const result = await runArenaSimulation(join(dir, "activity.jsonl"));
    expect(result).toMatchObject({ label: "SIMULATION", paid_repair_delivered: true, paid_repair_delivered_once: true, pending_delivery_reconciled: true, evaluated_products: 3, spent_credits: 80, purchased_sellers: 3, marketplace_calls: 7, malformed_products_isolated: true, delivercheck_self_evaluated: false, critique_restart_succeeded: true, market_restart_succeeded: true, ranking_submissions: 1, human_prompts: 0, real_sharednet_side_effects: 0, final_phase: "completed" });
    expect(result.disagreements).toHaveLength(3);
    expect(new Set(result.ranking)).toHaveLength(3);
  });

  it("rejects budget policies below the required minimum", async () => {
    const sharednet = new SimulatedSharedNetAdapter();
    await expect(runRoundTwo(await marketState(), sharednet, new SimulationMarketplace(), { ...policy, minimum_spend: 79 })).rejects.toThrow(/80–100/);
    expect(sharednet.payments).toHaveLength(0);
  });

  it("does not pay when fewer than three sellers are available", async () => {
    const sharednet = new SimulatedSharedNetAdapter();
    const marketplace = new SimulationMarketplace();
    marketplace.unavailable.add("product-envelope");
    await expect(runRoundTwo(await marketState(), sharednet, marketplace, policy)).rejects.toThrow(/three-seller/);
    expect(sharednet.payments).toHaveLength(0);
  });

  it("refuses purchases inside the deadline safety margin", async () => {
    const sharednet = new SimulatedSharedNetAdapter();
    await expect(runRoundTwo(await marketState(), sharednet, new SimulationMarketplace(), { ...policy, deadline_at: 1_200_000, now: () => 1_000_000 })).rejects.toThrow(/deadline safety margin/);
    expect(sharednet.payments).toHaveLength(0);
  });

  it("prevents payment to DeliverCheck itself", async () => {
    const sharednet = new SimulatedSharedNetAdapter();
    const marketplace = new SimulationMarketplace();
    await expect(runRoundTwo(await marketState(), sharednet, marketplace, { ...policy, self_ids: new Set(["p_MARKET0001"]) })).rejects.toThrow(/three-seller/);
    expect(sharednet.payments).toHaveLength(0);
  });

  it("does not duplicate completed purchases on replay", async () => {
    const sharednet = new SimulatedSharedNetAdapter();
    const marketplace = new SimulationMarketplace();
    const state = await marketState();
    const first = await runRoundTwo(state, sharednet, marketplace, policy);
    const second = await runRoundTwo(state, sharednet, marketplace, policy);
    expect(first.spent_credits).toBe(80);
    expect(second.spent_credits).toBe(80);
    expect(sharednet.payments).toHaveLength(3);
  });
});
