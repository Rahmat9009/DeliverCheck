import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SimulatedDeliverCheckClient } from "../../src/arena/delivercheck.js";
import { FileActionLedger, MemoryActionLedger } from "../../src/arena/ledger.js";
import { ArenaProcessLock } from "../../src/arena/lock.js";
import { ArenaOperator } from "../../src/arena/operator.js";
import { FilePendingOrderStore } from "../../src/arena/orders.js";
import { runRoundOne, runRoundTwo, SimulationRankingAdapter } from "../../src/arena/rounds.js";
import { DeliverCheckSellerWorkflow } from "../../src/arena/seller.js";
import { gitMetadataArguments } from "../../src/arena/repository.js";
import { SimulatedSharedNetAdapter } from "../../src/arena/sharednet.js";
import { SIMULATION_PRODUCTS, SimulationMarketplace } from "../../src/arena/simulation.js";
import { ArenaStateController } from "../../src/arena/state.js";
import { runUnattendedArena, type ArenaClock } from "../../src/arena/unattended.js";
import type { ActionLedger, ArenaProduct, CreditTransfer, ProductMarketplace, RankingAdapter, RankingEntry } from "../../src/arena/types.js";
import { ARENA_ROOM, BUYER_INSTANCE, BUYER_PRINCIPAL, SELLER_INSTANCE, SELLER_PRINCIPAL, requestMessage } from "./fixtures.js";

const sellerPolicy = { room_id: ARENA_ROOM, seller_principal_id: SELLER_PRINCIPAL, payment_recipient: { kind: "instance" as const, id: SELLER_INSTANCE, organizer_confirmed: true as const }, require_room_binding: true };
const roundPolicy = { minimum_spend: 80, maximum_spend: 100, minimum_sellers: 3, room_id: ARENA_ROOM, bind_payments_to_room: true, self_ids: new Set([SELLER_PRINCIPAL, SELLER_INSTANCE]), ledger_timeout_ms: 500, discovery_timeout_ms: 500, invocation_timeout_ms: 500 };

function incoming(id: string, memo: string, created_at = "2026-09-13T09:01:00.000Z"): CreditTransfer {
  return { id, from_principal_id: BUYER_PRINCIPAL, to_principal_id: SELLER_PRINCIPAL, amount: 7, memo, room_id: ARENA_ROOM, by_instance_id: BUYER_INSTANCE, addressed_to: SELLER_INSTANCE, code: null, created_at };
}

async function waitingState(ledger: ActionLedger = new MemoryActionLedger()) {
  const state = await ArenaStateController.open(ledger);
  if (state.state.phase === "preflight") await state.transition("waiting", "test");
  return state;
}

describe("unattended Arena hardening", () => {
  it("persists a pending request separately and finds its delayed transfer after more than 100 ledger records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arena-orders-"));
    const ledgerPath = join(dir, "activity.jsonl");
    const store = await FilePendingOrderStore.open(join(dir, "orders"));
    const sharednet = new SimulatedSharedNetAdapter();
    const delivercheck = new SimulatedDeliverCheckClient(() => ({ ok: true }));
    const firstState = await waitingState(await FileActionLedger.open(ledgerPath));
    const first = new DeliverCheckSellerWorkflow(firstState, sharednet, delivercheck, sellerPolicy, () => "order-delayed", store);
    expect((await first.handleMessage(requestMessage())).status).toBe("awaiting_payment");
    sharednet.addTransfer(incoming("txn_TARGET0001", "order-delayed"));
    for (let index = 0; index < 150; index += 1) sharednet.addTransfer({ ...incoming(`txn_NOISE${String(index).padStart(5, "0")}`, "unrelated", "2026-09-13T10:00:00.000Z"), from_principal_id: "p_OTHER00001" });
    const recoveredState = await ArenaStateController.open(await FileActionLedger.open(ledgerPath));
    const recovered = new DeliverCheckSellerWorkflow(recoveredState, sharednet, delivercheck, sellerPolicy, () => "unused", store);
    expect((await recovered.reconcilePendingOrders())[0]?.status).toBe("delivered");
    expect(delivercheck.calls).toHaveLength(1);
    expect(sharednet.calls.filter((call) => call === "ledger").length).toBeGreaterThan(1);
  });

  it("does not reject exact outgoing transfers when concurrent incoming revenue changes the absolute balance", async () => {
    const state = await waitingState();
    await state.transition("critique", "test");
    await state.transition("market", "test");
    const sharednet = new SimulatedSharedNetAdapter({ balance: { principal_id: SELLER_PRINCIPAL, balance: 100, granted: 100, sent: 0, received: 0 }, concurrent_income_per_payment: 9 });
    const result = await runRoundTwo(state, sharednet, new SimulationMarketplace(), roundPolicy);
    expect(result.spent_credits).toBe(80);
    expect(result.ending_balance).toBe(47);
    expect((await sharednet.balance()).sent).toBe(80);
    expect((await sharednet.balance()).received).toBe(27);
  });

  it("records a paid vendor failure and continues the remaining Round 2 purchases", async () => {
    class FailingPaidProduct extends SimulationMarketplace {
      override async invoke(product: ArenaProduct, orderId: string) {
        if (orderId.startsWith("purchase:") && product.product_id === "product-currency") throw new Error("vendor unavailable after settlement");
        return super.invoke(product, orderId);
      }
    }
    const state = await waitingState();
    await state.transition("critique", "test");
    await state.transition("market", "test");
    const sharednet = new SimulatedSharedNetAdapter({ balance: { principal_id: SELLER_PRINCIPAL, balance: 100, granted: 100, sent: 0, received: 0 } });
    const result = await runRoundTwo(state, sharednet, new FailingPaidProduct(), roundPolicy);
    expect(result.spent_credits).toBe(80);
    expect(sharednet.payments).toHaveLength(3);
    expect((await state.ledger.readAll()).some((event) => event.kind === "purchase_invocation_failed" && event.details?.product_id === "product-currency")).toBe(true);
  });

  it("isolates one failing pending order from another", async () => {
    const store = await FilePendingOrderStore.open(await mkdtemp(join(tmpdir(), "arena-order-isolation-")));
    const sharednet = new SimulatedSharedNetAdapter();
    const delivercheck = new SimulatedDeliverCheckClient((_service, request) => {
      if (request.request_id === "bad-order") throw new Error("synthetic service failure");
      return { ok: true };
    });
    const state = await waitingState();
    const seller = new DeliverCheckSellerWorkflow(state, sharednet, delivercheck, sellerPolicy, (message) => `order-${message.sequence}`, store);
    const bad = requestMessage({ id: "msg_BADORDER01", sequence: 1, content: requestMessage().content.replace("arena-test-request", "bad-order") });
    const good = requestMessage({ id: "msg_GOODORDER1", sequence: 2, content: requestMessage().content.replace("arena-test-request", "good-order") });
    expect((await seller.handleMessage(bad)).status).toBe("awaiting_payment");
    expect((await seller.handleMessage(good)).status).toBe("awaiting_payment");
    sharednet.addTransfer(incoming("txn_BADORDER01", "order-1"));
    sharednet.addTransfer(incoming("txn_GOODORDER1", "order-2"));
    const outcomes = await seller.reconcilePendingOrders();
    expect(outcomes.map((item) => item.status).sort()).toEqual(["delivered", "operational_failure"]);
  });

  it("isolates malformed listings, self identities, aliases, and an invocation timeout", async () => {
    const self: ArenaProduct = { ...SIMULATION_PRODUCTS[0]!, product_id: "self-product", seller: { kind: "principal", id: SELLER_PRINCIPAL, organizer_confirmed: true } };
    const timeout: ArenaProduct = { ...SIMULATION_PRODUCTS[0]!, product_id: "timeout-product", name: "Timeout", seller: { kind: "principal", id: "p_TIMEOUT001", organizer_confirmed: true }, price_credits: 100 };
    const alias: ArenaProduct = { ...SIMULATION_PRODUCTS[0]!, product_id: "alias-product", seller: { kind: "agent", id: "a_ALIAS00001", organizer_confirmed: true }, seller_principal_id: "p_MARKET0001", payment_recipient: { kind: "agent", id: "a_ALIAS00001", principal_id: "p_MARKET0001", mapping_verified: true, organizer_confirmed: true }, price_credits: 100 };
    class HostileCatalogue implements ProductMarketplace {
      readonly delegate = new SimulationMarketplace();
      get calls() { return this.delegate.calls; }
      async discover(): Promise<unknown[]> { return [{ product_id: "bad" }, self, timeout, alias, ...SIMULATION_PRODUCTS]; }
      async available(product: ArenaProduct) { return this.delegate.available(product); }
      async invoke(product: ArenaProduct, orderId: string) {
        if (product.product_id === timeout.product_id) return new Promise<never>(() => undefined);
        return this.delegate.invoke(product, orderId);
      }
    }
    const state = await waitingState();
    await state.transition("critique", "test");
    const market = new HostileCatalogue();
    const result = await runRoundOne(state, market, new SimulationRankingAdapter(), { self_ids: roundPolicy.self_ids, timeout_ms: 5, discovery_timeout_ms: 100 });
    expect(result.evaluations).toHaveLength(3);
    expect(new Set(result.evaluations.map((item) => item.seller_id)).size).toBe(3);
    expect(market.calls.some((call) => call.product_id === "self-product")).toBe(false);
    expect(market.calls.filter((call) => ["alias-product", "product-currency"].includes(call.product_id))).toHaveLength(1);
    expect(result.evaluations.find((item) => item.product_id === "timeout-product")?.disagreement).toContain("product_invocation_timeout");
    expect((await state.ledger.readAll()).some((event) => event.kind === "catalogue_item_skipped")).toBe(true);
  });

  it("evaluates ordinary third-party listings through a configured critique strategy without listing assertions", async () => {
    const products = SIMULATION_PRODUCTS.map(({ assertion: _assertion, probe_input: _probe, ...product }) => product);
    const marketplace: ProductMarketplace = {
      async discover() { return products; },
      async available() { return true; },
      async invoke(product) { return { product_id: product.product_id, output: { observed: "fixture" }, latency_ms: 3, protocol_ok: true, evidence_provided: true }; },
      critique(product, execution) { return { product_id: "untrusted", seller_id: "untrusted", evidence_hash: "untrusted", disagreement: `Observed a product-specific mismatch for ${product.product_id}.`, score: 50, latency_ms: execution.latency_ms }; },
    };
    const state = await waitingState();
    await state.transition("critique", "test");
    const result = await runRoundOne(state, marketplace, new SimulationRankingAdapter(), { self_ids: roundPolicy.self_ids });
    expect(result.evaluations).toHaveLength(3);
    expect(result.evaluations.every((item) => item.seller_id.startsWith("p_MARKET"))).toBe(true);
    expect(result.evaluations.every((item) => item.evidence_hash !== "untrusted")).toBe(true);
  });

  it("recovers idempotently from critique and from a crash after payment verification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arena-round-restart-"));
    const path = join(dir, "activity.jsonl");
    const marketplace = new SimulationMarketplace();
    const ranking = new SimulationRankingAdapter();
    const sharednet = new SimulatedSharedNetAdapter({ balance: { principal_id: SELLER_PRINCIPAL, balance: 100, granted: 100, sent: 0, received: 0 }, concurrent_income_per_payment: 5 });
    const initial = await waitingState(await FileActionLedger.open(path));
    await initial.transition("critique", "round1-start");
    let crashOne = true;
    await expect(runRoundOne(initial, marketplace, ranking, { self_ids: roundPolicy.self_ids, after_external_action: async () => { if (crashOne) { crashOne = false; throw new Error("simulated crash"); } } })).rejects.toThrow("simulated crash");
    const critiqueRestart = await ArenaStateController.open(await FileActionLedger.open(path));
    const roundOne = await runRoundOne(critiqueRestart, marketplace, ranking, { self_ids: roundPolicy.self_ids });
    expect(roundOne.evaluations).toHaveLength(3);
    expect(ranking.submissions).toBe(1);
    await critiqueRestart.transition("market", "round1-complete");
    let crashTwo = true;
    await expect(runRoundTwo(critiqueRestart, sharednet, marketplace, { ...roundPolicy, after_external_action: async () => { if (crashTwo) { crashTwo = false; throw new Error("simulated crash"); } } })).rejects.toThrow("simulated crash");
    const marketRestart = await ArenaStateController.open(await FileActionLedger.open(path));
    const roundTwo = await runRoundTwo(marketRestart, sharednet, marketplace, roundPolicy);
    expect(roundTwo.spent_credits).toBe(80);
    expect(roundTwo.sellers).toHaveLength(3);
    expect(sharednet.payments).toHaveLength(3);
  });

  it("does not blindly retransmit a payment whose outcome is unknown", async () => {
    class UnknownPaymentAdapter extends SimulatedSharedNetAdapter {
      attempts = 0;
      override async pay(): Promise<never> { this.attempts += 1; throw new Error("network disconnected during payment"); }
    }
    const state = await waitingState();
    await state.transition("critique", "test");
    await state.transition("market", "test");
    const sharednet = new UnknownPaymentAdapter({ balance: { principal_id: SELLER_PRINCIPAL, balance: 100, granted: 100, sent: 0, received: 0 } });
    await expect(runRoundTwo(state, sharednet, new SimulationMarketplace(), roundPolicy)).rejects.toThrow(/not yet met/);
    expect(sharednet.attempts).toBe(3);
    await expect(runRoundTwo(state, sharednet, new SimulationMarketplace(), roundPolicy)).rejects.toThrow(/not yet met/);
    expect(sharednet.attempts).toBe(3);
  });

  it("reconciles a presentation send and idempotently retries a ranking submission after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arena-effects-restart-"));
    const path = join(dir, "activity.jsonl");
    class SendCrashAdapter extends SimulatedSharedNetAdapter {
      crash = true;
      override async say(content: string) {
        const sent = await super.say(content);
        if (this.crash) { this.crash = false; throw new Error("crash after send"); }
        return sent;
      }
    }
    const sharednet = new SendCrashAdapter();
    const initial = await waitingState(await FileActionLedger.open(path));
    const seller = new DeliverCheckSellerWorkflow(initial, sharednet, new SimulatedDeliverCheckClient(() => ({})), sellerPolicy, () => "unused");
    await expect(seller.publishPresentation()).rejects.toThrow("crash after send");
    const recovered = await ArenaStateController.open(await FileActionLedger.open(path));
    const recoveredSeller = new DeliverCheckSellerWorkflow(recovered, sharednet, new SimulatedDeliverCheckClient(() => ({})), sellerPolicy, () => "unused");
    await expect(recoveredSeller.publishPresentation()).resolves.toMatch(/^msg_/);
    expect(sharednet.sent.filter((item) => item.kind === "say")).toHaveLength(1);

    await recovered.transition("critique", "test");
    const effects = new Set<string>();
    let crash = true;
    const ranking: RankingAdapter = {
      method: "simulation-idempotent",
      idempotent: true,
      async submit(_entries: readonly RankingEntry[], operationId: string) {
        effects.add(operationId);
        if (crash) { crash = false; throw new Error("crash after ranking acceptance"); }
        return { submission_id: "ranking-reconciled" };
      },
    };
    await expect(runRoundOne(recovered, new SimulationMarketplace(), ranking, { self_ids: roundPolicy.self_ids })).rejects.toThrow("crash after ranking acceptance");
    const rankingRestart = await ArenaStateController.open(await FileActionLedger.open(path));
    await expect(runRoundOne(rankingRestart, new SimulationMarketplace(), ranking, { self_ids: roundPolicy.self_ids })).resolves.toMatchObject({ submission_id: "ranking-reconciled" });
    expect(effects).toEqual(new Set(["round1-ranking"]));
  });

  it("paginates more than 100 room messages without replay", async () => {
    const messages = Array.from({ length: 205 }, (_, index) => requestMessage({ id: `msg_PAGE${String(index).padStart(6, "0")}`, sequence: index + 1, content: "not a request" }));
    const sharednet = new SimulatedSharedNetAdapter({ messages });
    const state = await ArenaStateController.open(new MemoryActionLedger());
    const operator = new ArenaOperator({ state, sharednet, delivercheck: new SimulatedDeliverCheckClient(() => ({})), marketplace: new SimulationMarketplace(), ranking: new SimulationRankingAdapter(), seller_policy: sellerPolicy, round_two_policy: roundPolicy });
    await operator.preflight();
    expect(await operator.monitorOnce(0)).toHaveLength(205);
    expect(operator.state.cursor).toBe(205);
    expect(await operator.monitorOnce(0)).toHaveLength(0);
  });

  it("runs both phases unattended and submits ranking once", async () => {
    const state = await ArenaStateController.open(new MemoryActionLedger());
    const sharednet = new SimulatedSharedNetAdapter({ balance: { principal_id: SELLER_PRINCIPAL, balance: 100, granted: 100, sent: 0, received: 0 } });
    const ranking = new SimulationRankingAdapter();
    const operator = new ArenaOperator({ state, sharednet, delivercheck: new SimulatedDeliverCheckClient(() => ({})), marketplace: new SimulationMarketplace(), ranking, seller_policy: sellerPolicy, round_two_policy: roundPolicy });
    let time = 1_000;
    const clock: ArenaClock = { now: () => time, sleep: async (milliseconds) => { time += milliseconds; } };
    const outcome = await runUnattendedArena({ operator, signal: new AbortController().signal, clock, poll_interval_ms: 1, timing: { arena_starts_at: new Date(1_000).toISOString(), round_1_ends_at: new Date(1_000_000).toISOString(), round_2_starts_at: new Date(1_000).toISOString(), round_2_ends_at: new Date(2_000_000).toISOString(), timezone: "UTC" } });
    expect(outcome).toBe("completed");
    expect(operator.phase).toBe("completed");
    expect(ranking.submissions).toBe(1);
    expect(sharednet.real_side_effects).toBe(0);
  });

  it("enforces one process per state file and isolates Git metadata fixtures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arena-lock-"));
    const path = join(dir, "operator.lock");
    const first = await ArenaProcessLock.acquire(path);
    await expect(ArenaProcessLock.acquire(path)).rejects.toThrow(/Another Arena operator/);
    await first.release();
    const localMetadata = await mkdtemp(join(tmpdir(), "arena-git-local-"));
    await mkdir(join(localMetadata, ".git-local"));
    const standardMetadata = await mkdtemp(join(tmpdir(), "arena-git-standard-"));
    await mkdir(join(standardMetadata, ".git"));
    expect(await gitMetadataArguments(localMetadata)).toEqual(["--git-dir=.git-local", "--work-tree=."]);
    expect(await gitMetadataArguments(standardMetadata)).toEqual([]);
  });
});
