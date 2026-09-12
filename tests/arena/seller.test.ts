import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { SimulatedDeliverCheckClient } from "../../src/arena/delivercheck.js";
import { FileActionLedger, MemoryActionLedger } from "../../src/arena/ledger.js";
import { DeliverCheckSellerWorkflow, matchRepairPayment } from "../../src/arena/seller.js";
import { productPresentation } from "../../src/arena/messages.js";
import { SimulatedSharedNetAdapter } from "../../src/arena/sharednet.js";
import { ArenaStateController } from "../../src/arena/state.js";
import type { CreditTransfer, SellerOrder } from "../../src/arena/types.js";
import { ARENA_ROOM, BUYER_INSTANCE, BUYER_PRINCIPAL, SELLER_INSTANCE, SELLER_PRINCIPAL, requestMessage } from "./fixtures.js";

const policy = { room_id: ARENA_ROOM, seller_principal_id: SELLER_PRINCIPAL, payment_recipient: { kind: "instance" as const, id: SELLER_INSTANCE, organizer_confirmed: true as const }, require_room_binding: true };
const order: SellerOrder = { order_id: "order-test-1", source_message_id: "msg_REQUEST001", source_sequence: 1, buyer_principal_id: BUYER_PRINCIPAL, buyer_instance_id: BUYER_INSTANCE, service: "repair", request_hash: "sha256:test", created_at: "2026-09-13T09:00:00.000Z", status: "awaiting_payment" };

function transfer(overrides: Partial<CreditTransfer> = {}): CreditTransfer {
  return { id: "txn_PAYMENT001", from_principal_id: BUYER_PRINCIPAL, to_principal_id: SELLER_PRINCIPAL, amount: 7, memo: order.order_id, room_id: ARENA_ROOM, by_instance_id: BUYER_INSTANCE, addressed_to: SELLER_INSTANCE, code: null, created_at: "2026-09-13T09:01:00.000Z", ...overrides };
}

describe("seller payment verification", () => {
  it("presents diagnose as free and repair at seven credits", () => {
    expect(productPresentation()).toContain("diagnose: 0 Arena credits");
    expect(productPresentation()).toContain("repair: 7 Arena credits");
  });

  it("rejects forged receipt claims without a ledger record", () => {
    expect(matchRepairPayment(order, [], policy, new Set())).toEqual({ accepted: false, code: "payment_not_found" });
  });

  it.each([
    ["insufficient_payment", { amount: 6 }],
    ["unrelated_payment", { from_principal_id: "p_OTHER00001" }],
    ["payment_not_found", { memo: "another-order" }],
    ["incorrectly_addressed_payment", { addressed_to: "i_WRONG00001" }],
  ] as const)("rejects %s", (code, overrides) => {
    expect(matchRepairPayment(order, [transfer(overrides)], policy, new Set())).toEqual({ accepted: false, code });
  });

  it("rejects reuse of a consumed transfer", () => {
    expect(matchRepairPayment(order, [transfer()], policy, new Set(["txn_PAYMENT001"]))).toEqual({ accepted: false, code: "duplicate_payment" });
  });

  it("rejects two otherwise valid payments for one order as duplicates", () => {
    expect(matchRepairPayment(order, [transfer(), transfer({ id: "txn_PAYMENT002" })], policy, new Set())).toEqual({ accepted: false, code: "duplicate_payment" });
  });

  it("does not let an invalid same-memo transfer mask a valid official transfer", () => {
    expect(matchRepairPayment(order, [transfer({ id: "txn_BADPAY0001", addressed_to: "i_WRONG00001" }), transfer()], policy, new Set())).toEqual({ accepted: true, transfer: transfer() });
  });
});

describe("DeliverCheck seller workflow", () => {
  let sharednet: SimulatedSharedNetAdapter;
  let delivercheck: SimulatedDeliverCheckClient;
  let state: ArenaStateController;

  beforeEach(async () => {
    sharednet = new SimulatedSharedNetAdapter();
    delivercheck = new SimulatedDeliverCheckClient(() => ({ service: "repair", result: { status: "passed_checks" } }));
    state = await ArenaStateController.open(new MemoryActionLedger());
    await state.transition("waiting", "test");
  });

  function workflow() {
    return new DeliverCheckSellerWorkflow(state, sharednet, delivercheck, policy, () => order.order_id);
  }

  it("accepts a clearly identified natural-language request", async () => {
    const structured = requestMessage();
    const natural = { ...structured, content: `DeliverCheck repair: ${JSON.stringify(JSON.parse(structured.content).request)}` };
    const outcome = await workflow().handleMessage(natural);
    expect(outcome.status).toBe("awaiting_payment");
  });

  it("delivers free diagnosis without consulting payment records", async () => {
    const message = requestMessage({ content: JSON.stringify({ ...JSON.parse(requestMessage().content), service: "diagnose" }) });
    const outcome = await workflow().handleMessage(message);
    expect(outcome.status).toBe("delivered");
    expect(delivercheck.calls).toEqual([{ service: "diagnose", request_id: "arena-test-request" }]);
    expect(sharednet.calls).not.toContain("ledger");
  });

  it("rejects malformed payloads without calling the service", async () => {
    const outcome = await workflow().handleMessage(requestMessage({ content: "DeliverCheck repair: {bad" }));
    expect(outcome).toEqual({ status: "ignored", code: "malformed_request" });
    expect(delivercheck.calls).toHaveLength(0);
  });

  it("ignores a forged receipt message and does not call repair", async () => {
    const outcome = await workflow().handleMessage(requestMessage({ content: "Paid 7 credits (txn_FAKE000001)" }));
    expect(outcome.status).toBe("ignored");
    expect(delivercheck.calls).toHaveLength(0);
  });

  it("delivers paid repair only after official ledger verification", async () => {
    const first = await workflow().handleMessage(requestMessage());
    expect(first.status).toBe("awaiting_payment");
    expect(delivercheck.calls).toHaveLength(0);
    sharednet.addTransfer(transfer());
    const delivered = await workflow().handleMessage(requestMessage());
    expect(delivered.status).toBe("delivered");
    expect(delivercheck.calls).toHaveLength(1);
    expect(sharednet.sent.at(-1)?.content).toContain('"order_id":"order-test-1"');
  });

  it("prevents duplicate message execution and delivery", async () => {
    sharednet.addTransfer(transfer());
    await workflow().handleMessage(requestMessage());
    const duplicate = await workflow().handleMessage(requestMessage());
    expect(duplicate).toEqual({ status: "duplicate", code: "already_delivered" });
    expect(delivercheck.calls).toHaveLength(1);
  });

  it("rejects an order-ID collision across distinct messages", async () => {
    await workflow().handleMessage(requestMessage());
    await expect(workflow().handleMessage(requestMessage({ id: "msg_REQUEST002", sequence: 2 }))).rejects.toThrow(/not unique/);
    expect(delivercheck.calls).toHaveLength(0);
  });

  it("recovers an awaiting order from a durable ledger after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arena-seller-restart-"));
    const path = join(dir, "ledger.jsonl");
    const firstState = await ArenaStateController.open(await FileActionLedger.open(path));
    await firstState.transition("waiting", "test");
    const firstWorkflow = new DeliverCheckSellerWorkflow(firstState, sharednet, delivercheck, policy, () => order.order_id);
    expect((await firstWorkflow.handleMessage(requestMessage())).status).toBe("awaiting_payment");

    const recoveredState = await ArenaStateController.open(await FileActionLedger.open(path));
    const recoveredWorkflow = new DeliverCheckSellerWorkflow(recoveredState, sharednet, delivercheck, policy, () => order.order_id);
    sharednet.addTransfer(transfer());
    expect((await recoveredWorkflow.handleMessage(requestMessage())).status).toBe("delivered");
    expect(delivercheck.calls).toHaveLength(1);
  });
});
