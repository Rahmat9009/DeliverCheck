import { describe, expect, it } from "vitest";

import { SimulatedDeliverCheckClient } from "../../src/arena/delivercheck.js";
import { MemoryActionLedger } from "../../src/arena/ledger.js";
import { ArenaOperator } from "../../src/arena/operator.js";
import { SimulationRankingAdapter } from "../../src/arena/rounds.js";
import { SimulationMarketplace } from "../../src/arena/simulation.js";
import { SharedNetCliAdapter, SimulatedSharedNetAdapter, type ArgumentExecutor } from "../../src/arena/sharednet.js";
import { ArenaStateController } from "../../src/arena/state.js";
import type { ArenaConfig } from "../../src/arena/types.js";
import { ARENA_ROOM, SELLER_INSTANCE, SELLER_PRINCIPAL, requestMessage, validLiveConfig } from "./fixtures.js";

async function options(sharednet = new SimulatedSharedNetAdapter()) {
  return {
    state: await ArenaStateController.open(new MemoryActionLedger()),
    sharednet,
    delivercheck: new SimulatedDeliverCheckClient(() => ({ service: "diagnose", outcome: "valid" })),
    marketplace: new SimulationMarketplace(),
    ranking: new SimulationRankingAdapter(),
    seller_policy: { room_id: ARENA_ROOM, seller_principal_id: SELLER_PRINCIPAL, payment_recipient: { kind: "instance" as const, id: SELLER_INSTANCE, organizer_confirmed: true as const }, require_room_binding: true },
    round_two_policy: { minimum_spend: 80, maximum_spend: 100, minimum_sellers: 3, room_id: ARENA_ROOM, bind_payments_to_room: true, self_ids: new Set([SELLER_PRINCIPAL, SELLER_INSTANCE]) },
  };
}

describe("Arena operator guards", () => {
  it("uses simulation by default and follows the durable phase machine", async () => {
    const operator = new ArenaOperator(await options());
    expect(operator.phase).toBe("preflight");
    await operator.preflight();
    expect(operator.phase).toBe("waiting");
    await operator.runRoundOne();
    expect(operator.phase).toBe("market");
    await operator.runRoundTwo();
    expect(operator.phase).toBe("completed");
  });

  it("catches up a message using the durable cursor and suppresses replay", async () => {
    const sharednet = new SimulatedSharedNetAdapter({ messages: [requestMessage({ content: "not a service request" })] });
    const operator = new ArenaOperator(await options(sharednet));
    await operator.preflight();
    expect(await operator.monitorOnce(0)).toEqual([{ status: "ignored", code: "not_delivercheck_request" }]);
    expect(await operator.monitorOnce(0)).toEqual([]);
    expect(operator.state.cursor).toBe(1);
  });

  it("refuses a live-shaped partial config before any executor call", async () => {
    const executor: ArgumentExecutor & { calls: number } = {
      calls: 0,
      async execute() { this.calls += 1; return { stdout: "{}", stderr: "", exitCode: 0 }; },
    };
    expect(() => new SharedNetCliAdapter({ mode: "live" } as ArenaConfig as ReturnType<typeof validLiveConfig>, executor)).toThrow(/configuration is incomplete/);
    expect(executor.calls).toBe(0);
  });

  it("rejects live execution with a simulation transport", async () => {
    const base = await options();
    const live = validLiveConfig();
    const operator = new ArenaOperator({ ...base, config: live });
    await expect(operator.preflight()).rejects.toThrow(/live SharedNet adapter/);
    expect(operator.phase).toBe("preflight");
  });
});
