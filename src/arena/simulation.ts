import { rm } from "node:fs/promises";

import { computeCanonicalHash } from "../verify/canonical.js";
import { SimulatedDeliverCheckClient } from "./delivercheck.js";
import { FileActionLedger } from "./ledger.js";
import { ArenaOperator } from "./operator.js";
import { SimulationRankingAdapter } from "./rounds.js";
import { SimulatedSharedNetAdapter } from "./sharednet.js";
import { ArenaStateController } from "./state.js";
import type { ArenaProduct, CreditTransfer, ProductMarketplace, SharedNetMessage } from "./types.js";

const ROOM = "rom_SIMULATE1";
const SELLER_PRINCIPAL = "p_SELLER0001";
const SELLER_INSTANCE = "i_SELLER0001";
const BUYER_PRINCIPAL = "p_BUYER00001";
const BUYER_INSTANCE = "i_BUYER00001";

const request = {
  request_id: "simulation-repair",
  input_format: "json" as const,
  source_text: '{"status":"done"}',
  target_schema: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["complete"] } } },
  explicit_rules: ['Normalize "status" value "done" to "complete".'],
};

export const SIMULATION_PRODUCTS: ArenaProduct[] = [
  { product_id: "product-currency", name: "Currency Formatter", seller: { kind: "principal", id: "p_MARKET0001", organizer_confirmed: true }, price_credits: 30, useful_purpose: "Normalize a settlement currency", probe_input: { currency: "qar" }, assertion: { path: ["currency"], equals: "QAR", description: "Currency output must preserve the requested uppercase code" } },
  { product_id: "product-evidence", name: "Evidence Checker", seller: { kind: "principal", id: "p_MARKET0002", organizer_confirmed: true }, price_credits: 25, useful_purpose: "Check whether a claim includes evidence", probe_input: { claim: "synthetic" }, assertion: { path: ["verified"], equals: false, description: "An unsupported claim must not be marked verified" } },
  { product_id: "product-envelope", name: "Envelope Builder", seller: { kind: "principal", id: "p_MARKET0003", organizer_confirmed: true }, price_credits: 25, useful_purpose: "Build an evidence-bearing response envelope", probe_input: { status: "ok" }, assertion: { path: ["evidence"], equals: "attached", description: "The advertised envelope must include evidence" } },
];

export class SimulationMarketplace implements ProductMarketplace {
  readonly calls: { product_id: string; order_id: string }[] = [];
  readonly unavailable = new Set<string>();

  async discover(): Promise<ArenaProduct[]> { return structuredClone(SIMULATION_PRODUCTS); }
  async available(product: ArenaProduct): Promise<boolean> { return !this.unavailable.has(product.product_id); }
  async invoke(product: ArenaProduct, orderId: string) {
    this.calls.push({ product_id: product.product_id, order_id: orderId });
    const output = product.product_id === "product-currency" ? { currency: "qar" }
      : product.product_id === "product-evidence" ? { verified: true, evidence: null }
        : { status: "ok" };
    return { product_id: product.product_id, output, latency_ms: product.price_credits * 4, protocol_ok: true, evidence_provided: product.product_id !== "product-evidence" };
  }
}

export function simulatedRequestMessage(sequence = 1): SharedNetMessage {
  return {
    id: "msg_BUYER00001",
    room_id: ROOM,
    sequence,
    sender_principal_id: BUYER_PRINCIPAL,
    sender_agent_id: null,
    sender_instance_id: BUYER_INSTANCE,
    content: JSON.stringify({ type: "delivercheck.request", version: 1, service: "repair", request }),
    created_at: "2026-09-13T09:00:00.000Z",
  };
}

function incomingRepairPayment(orderId: string): CreditTransfer {
  return {
    id: "txn_BUYER00001",
    from_principal_id: BUYER_PRINCIPAL,
    to_principal_id: SELLER_PRINCIPAL,
    amount: 7,
    memo: orderId,
    room_id: ROOM,
    by_instance_id: BUYER_INSTANCE,
    addressed_to: SELLER_INSTANCE,
    code: null,
    created_at: "2026-09-13T09:01:00.000Z",
  };
}

function operatorOptions(state: ArenaStateController, sharednet: SimulatedSharedNetAdapter, delivercheck: SimulatedDeliverCheckClient, marketplace: SimulationMarketplace, ranking: SimulationRankingAdapter) {
  return {
    state,
    sharednet,
    delivercheck,
    marketplace,
    ranking,
    seller_policy: { room_id: ROOM, seller_principal_id: SELLER_PRINCIPAL, payment_recipient: { kind: "instance" as const, id: SELLER_INSTANCE, organizer_confirmed: true as const }, require_room_binding: true },
    round_two_policy: { minimum_spend: 80, maximum_spend: 100, minimum_sellers: 3, room_id: ROOM, bind_payments_to_room: true, self_ids: new Set([SELLER_PRINCIPAL, SELLER_INSTANCE]) },
    order_id: () => "order-simulation-1",
  };
}

export async function runArenaSimulation(path = `/tmp/delivercheck-arena-simulation-${process.pid}.jsonl`) {
  await rm(path, { force: true });
  const now = () => "2026-09-13T09:00:00.000Z";
  const sharednet = new SimulatedSharedNetAdapter({ balance: { principal_id: SELLER_PRINCIPAL, balance: 100, granted: 100, sent: 0, received: 0 } });
  const delivercheck = new SimulatedDeliverCheckClient((service) => service === "repair"
    ? { service: "repair", result: { job_id: "simulation-repair", status: "passed_checks", candidate: { status: "complete" }, changes: [{ path: "/status", operation: "replace", before: "done", after: "complete", justification: "Explicit simulation rule", rule_indexes: [0] }], checks: [{ name: "schema", status: "passed", evidence: "Synthetic deterministic verifier evidence", proves_factual_truth: false }], unresolved: [], original_hash: computeCanonicalHash({ status: "done" }), candidate_hash: computeCanonicalHash({ status: "complete" }), schema_hash: computeCanonicalHash(request.target_schema), elapsed_ms: 1, implementation_version: "simulation" }, billing: { price_credits: 7, currency: "Arena credits", enforcement: "external_pending_official_sharednet_confirmation", payment_verified: false } }
    : { service: "diagnose", outcome: "valid", proves_factual_truth: false, billing: { price_credits: 0, payment_verified: false } });
  const marketplace = new SimulationMarketplace();
  const ranking = new SimulationRankingAdapter();

  const firstLedger = await FileActionLedger.open(path, now);
  const firstState = await ArenaStateController.open(firstLedger);
  const first = new ArenaOperator(operatorOptions(firstState, sharednet, delivercheck, marketplace, ranking));
  await first.preflight();
  await first.publishPresentation();
  const message = simulatedRequestMessage();
  const beforePayment = await first.handleSellerMessage(message);

  const recoveredLedger = await FileActionLedger.open(path, now);
  const recoveredState = await ArenaStateController.open(recoveredLedger);
  const recovered = new ArenaOperator(operatorOptions(recoveredState, sharednet, delivercheck, marketplace, ranking));
  await recovered.preflight();
  sharednet.addMessage({ ...simulatedRequestMessage(2), id: "msg_RECEIPT001", content: "Paid 7 credits; receipt txn_claimed" });
  const forgedReceipt = await recovered.handleSellerMessage({ ...simulatedRequestMessage(2), id: "msg_RECEIPT001", content: "Paid 7 credits; receipt txn_claimed" });
  sharednet.addTransfer(incomingRepairPayment("order-simulation-1"), true);
  const delivered = await recovered.handleSellerMessage(message);
  const roundOne = await recovered.runRoundOne();
  const roundTwo = await recovered.runRoundTwo();
  const events = await recoveredLedger.readAll();

  return {
    label: "SIMULATION",
    before_payment: beforePayment.status,
    forged_receipt: forgedReceipt.status,
    paid_repair_delivered: delivered.status === "delivered",
    evaluated_products: roundOne.evaluations.length,
    disagreements: roundOne.evaluations.map((entry) => entry.disagreement),
    ranking: roundOne.ranking.map((entry) => entry.product_id),
    spent_credits: roundTwo.spent_credits,
    purchased_sellers: roundTwo.sellers.length,
    ending_balance: roundTwo.ending_balance,
    restart_recovered_events: events.length,
    delivercheck_calls: delivercheck.calls,
    marketplace_calls: marketplace.calls.length,
    real_sharednet_side_effects: sharednet.real_side_effects,
    final_phase: recovered.phase,
  };
}
