import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SimulatedDeliverCheckClient } from "../../src/arena/delivercheck.js";
import { MemoryActionLedger } from "../../src/arena/ledger.js";
import { ArenaOperator } from "../../src/arena/operator.js";
import { SimulationRankingAdapter } from "../../src/arena/rounds.js";
import { matchRepairPayment } from "../../src/arena/seller.js";
import { SimulatedSharedNetAdapter } from "../../src/arena/sharednet.js";
import { SimulationMarketplace } from "../../src/arena/simulation.js";
import { ArenaStateController } from "../../src/arena/state.js";
import type { CreditTransfer, SellerOrder } from "../../src/arena/types.js";
import {
  ARENA_ROOM,
  BUYER_INSTANCE,
  BUYER_PRINCIPAL,
  SELLER_INSTANCE,
  SELLER_PRINCIPAL,
  requestMessage,
} from "./fixtures.js";

const policy = {
  room_id: ARENA_ROOM,
  seller_principal_id: SELLER_PRINCIPAL,
  payment_recipient: { kind: "instance" as const, id: SELLER_INSTANCE, organizer_confirmed: true as const },
  require_room_binding: true,
};

function transfer(id: string, memo = "order-delayed"): CreditTransfer {
  return {
    id,
    from_principal_id: BUYER_PRINCIPAL,
    to_principal_id: SELLER_PRINCIPAL,
    amount: 7,
    memo,
    room_id: ARENA_ROOM,
    by_instance_id: BUYER_INSTANCE,
    addressed_to: SELLER_INSTANCE,
    code: null,
    created_at: "2026-09-13T09:01:00.000Z",
  };
}

async function operator(sharednet: SimulatedSharedNetAdapter, suppliedState?: ArenaStateController) {
  const state = suppliedState ?? await ArenaStateController.open(new MemoryActionLedger());
  return new ArenaOperator({
    state,
    sharednet,
    delivercheck: new SimulatedDeliverCheckClient(() => ({ ok: true })),
    marketplace: new SimulationMarketplace(),
    ranking: new SimulationRankingAdapter(),
    seller_policy: policy,
    round_two_policy: {
      minimum_spend: 80,
      maximum_spend: 100,
      minimum_sellers: 3,
      room_id: ARENA_ROOM,
      bind_payments_to_room: true,
      self_ids: new Set([SELLER_PRINCIPAL, SELLER_INSTANCE]),
    },
    order_id: () => "order-delayed",
  });
}

describe("independent-review reproductions", () => {
  it("rechecks a pending order even when its request message does not reappear", async () => {
    const sharednet = new SimulatedSharedNetAdapter();
    const arena = await operator(sharednet);
    await arena.preflight();
    expect((await arena.handleSellerMessage(requestMessage())).status).toBe("awaiting_payment");
    sharednet.addTransfer(transfer("txn_DELAYED001"));
    expect((await arena.monitorOnce(0)).some((outcome) => outcome.status === "delivered")).toBe(true);
  });

  it("selects one deterministic valid transfer and records duplicate surplus separately", () => {
    const order: SellerOrder = {
      order_id: "order-delayed",
      source_message_id: "msg_REQUEST001",
      source_sequence: 1,
      buyer_principal_id: BUYER_PRINCIPAL,
      buyer_instance_id: BUYER_INSTANCE,
      service: "repair",
      request_hash: "sha256:test",
      created_at: "2026-09-13T09:00:00.000Z",
      status: "awaiting_payment",
    };
    expect(matchRepairPayment(order, [transfer("txn_PAYMENT002"), transfer("txn_PAYMENT001")], policy, new Set())).toMatchObject({
      accepted: true,
      transfer: { id: "txn_PAYMENT001" },
      surplus_transfer_ids: ["txn_PAYMENT002"],
    });
  });

  it("resumes Round 1 after a restart in critique phase", async () => {
    const state = await ArenaStateController.open(new MemoryActionLedger());
    await state.transition("waiting", "preflight");
    await state.transition("critique", "crash-after-round-start");
    const arena = await operator(new SimulatedSharedNetAdapter(), state);
    await expect(arena.runRoundOne()).resolves.toBeDefined();
  });

  it("does not replay old messages from simulated wait cursors", async () => {
    const adapter = new SimulatedSharedNetAdapter({ messages: [requestMessage()] });
    expect((await adapter.wait(0, 1)).items).toHaveLength(1);
    expect((await adapter.wait(0, 1)).items).toHaveLength(0);
  });

  it("exposes the guarded unattended live entrypoint", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["arena:live"]).toBeDefined();
  });
});
