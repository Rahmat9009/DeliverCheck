import { computeCanonicalHash } from "../verify/canonical.js";
import type { DeliverCheckRequest } from "../types.js";
import { parseServiceRequest, productPresentation } from "./messages.js";
import { MemoryPendingOrderStore } from "./orders.js";
import { readMessagesPaginated, scanLedger } from "./pagination.js";
import { classifyArenaFailure, withTimeout } from "./resilience.js";
import type { ArenaStateController } from "./state.js";
import type {
  ConfirmedIdentity,
  CreditTransfer,
  DeliverCheckClient,
  PaymentIdentityKind,
  SellerOrder,
  PendingOrderStore,
  SharedNetAdapter,
  SharedNetMessage,
} from "./types.js";

const REPAIR_PRICE = 7;
const MAX_DELIVERY_BYTES = 30 * 1024;

export interface SellerPolicy {
  room_id: string;
  seller_principal_id: string;
  payment_recipient: ConfirmedIdentity<PaymentIdentityKind>;
  require_room_binding: boolean;
}

export type PaymentFailureCode = "payment_not_found" | "insufficient_payment" | "duplicate_payment" | "unrelated_payment" | "incorrectly_addressed_payment";

export type PaymentMatch =
  | { accepted: true; transfer: CreditTransfer; surplus_transfer_ids: string[] }
  | { accepted: false; code: PaymentFailureCode };

export type SellerOutcome =
  | { status: "ignored" | "duplicate"; code: string }
  | { status: "awaiting_payment"; order: SellerOrder; code: PaymentFailureCode }
  | { status: "delivered"; order: SellerOrder; delivery_message_id: string; response_hash: string }
  | { status: "operational_failure"; order_id: string; code: string };

function exactRecipient(identity: ConfirmedIdentity<PaymentIdentityKind>): string {
  return identity.id;
}

export function matchRepairPayment(
  order: SellerOrder,
  transfers: readonly CreditTransfer[],
  policy: SellerPolicy,
  consumed: ReadonlySet<string>,
): PaymentMatch {
  const sameMemo = transfers.filter((transfer) => transfer.memo === order.order_id);
  if (sameMemo.length === 0) return { accepted: false, code: "payment_not_found" };
  const correctlyAddressed = sameMemo.filter((transfer) => transfer.addressed_to === exactRecipient(policy.payment_recipient) && transfer.to_principal_id === policy.seller_principal_id);
  const related = correctlyAddressed.filter((transfer) => transfer.from_principal_id === order.buyer_principal_id && transfer.by_instance_id === order.buyer_instance_id && (!policy.require_room_binding || transfer.room_id === policy.room_id) && Date.parse(transfer.created_at) >= Date.parse(order.created_at));
  const exact = related.filter((transfer) => transfer.amount === REPAIR_PRICE && !consumed.has(transfer.id))
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at) || left.id.localeCompare(right.id));
  if (exact.length >= 1) return { accepted: true, transfer: exact[0]!, surplus_transfer_ids: exact.slice(1).map((item) => item.id) };
  if (related.some((transfer) => consumed.has(transfer.id))) return { accepted: false, code: "duplicate_payment" };
  if (correctlyAddressed.length === 0) return { accepted: false, code: "incorrectly_addressed_payment" };
  if (related.some((transfer) => transfer.amount < REPAIR_PRICE)) return { accepted: false, code: "insufficient_payment" };
  return { accepted: false, code: "unrelated_payment" };
}

function deliveryContent(order: SellerOrder, response: unknown): { content: string; response_hash: string } {
  const response_hash = computeCanonicalHash(response);
  const content = JSON.stringify({ type: "delivercheck.delivery", version: 1, order_id: order.order_id, service: order.service, response_hash, response });
  if (Buffer.byteLength(content, "utf8") > MAX_DELIVERY_BYTES) throw new Error("The DeliverCheck result exceeds the bounded Room delivery size.");
  return { content, response_hash };
}

export class DeliverCheckSellerWorkflow {
  readonly #orders: PendingOrderStore;
  constructor(
    private readonly state: ArenaStateController,
    private readonly sharednet: SharedNetAdapter,
    private readonly delivercheck: DeliverCheckClient,
    private readonly policy: SellerPolicy,
    private readonly orderId: (message: SharedNetMessage) => string,
    orders: PendingOrderStore = new MemoryPendingOrderStore(),
    private readonly timeouts: { ledger_ms: number; sharednet_read_ms: number; delivercheck_ms: number } = { ledger_ms: 30_000, sharednet_read_ms: 30_000, delivercheck_ms: 240_000 },
  ) { this.#orders = orders; }

  async publishPresentation(): Promise<string> {
    if (this.state.state.presentationPublished) return "already_published";
    const content = productPresentation();
    if (this.state.state.presentationIntentHash !== null) {
      const page = await readMessagesPaginated(this.sharednet, 0, { timeout_ms: this.timeouts.sharednet_read_ms });
      const found = page.items.find((item) => computeCanonicalHash(item.content) === this.state.state.presentationIntentHash);
      if (found === undefined) throw new Error("A previous presentation outcome is unknown; automatic resend is denied.");
      await this.state.ledger.append({ kind: "presentation_confirmed", phase: this.state.state.phase, details: { message_id: found.id } });
      this.state.state.presentationPublished = true;
      this.state.state.presentationIntentHash = null;
      return found.id;
    }
    await this.state.ledger.append({ kind: "presentation_intent", phase: this.state.state.phase, details: { content_hash: computeCanonicalHash(content) } });
    this.state.state.presentationIntentHash = computeCanonicalHash(content);
    const sent = await this.sharednet.say(content);
    await this.state.ledger.append({ kind: "presentation_confirmed", phase: this.state.state.phase, details: { message_id: sent.message_id } });
    this.state.state.presentationPublished = true;
    this.state.state.presentationIntentHash = null;
    return sent.message_id;
  }

  async handleMessage(message: SharedNetMessage): Promise<SellerOutcome> {
    const existing = this.state.state.ordersByMessage.get(message.id);
    const parsed = parseServiceRequest(message);
    if (existing !== undefined) {
      if (!parsed.accepted || parsed.request_hash !== existing.request_hash) return { status: "duplicate", code: "message_content_changed" };
      if (existing.status === "delivered") return { status: "duplicate", code: "already_delivered" };
      const stored = await this.#orders.get(existing.order_id);
      return this.continueOrder(existing, stored?.request ?? parsed.value.request);
    }
    if (!this.state.assertNewMessage(message.id, message.sequence)) return { status: "duplicate", code: "message_already_processed" };
    if (!parsed.accepted) {
      await this.state.ignoreMessage(message.id, message.sequence, parsed.code);
      return { status: "ignored", code: parsed.code };
    }
    if (!/^p_[0-9A-Za-z]{10}$/.test(message.sender_principal_id ?? "") || !/^i_[0-9A-Za-z]{10}$/.test(message.sender_instance_id ?? "")) {
      await this.state.ignoreMessage(message.id, message.sequence, "unverified_sender_identity");
      return { status: "ignored", code: "unverified_sender_identity" };
    }
    if (message.room_id !== this.policy.room_id) {
      await this.state.ignoreMessage(message.id, message.sequence, "wrong_room");
      return { status: "ignored", code: "wrong_room" };
    }

    const order: SellerOrder = {
      order_id: this.orderId(message),
      source_message_id: message.id,
      source_sequence: message.sequence,
      buyer_principal_id: message.sender_principal_id!,
      buyer_instance_id: message.sender_instance_id!,
      service: parsed.value.service,
      request_hash: parsed.request_hash,
      created_at: message.created_at,
      status: parsed.value.service === "repair" ? "awaiting_payment" : "accepted",
    };
    await this.#orders.put({ order, request: parsed.value.request });
    await this.state.createOrder(order);
    if (order.service === "repair") {
      await this.sharednet.reply(message.id, JSON.stringify({ type: "delivercheck.order", version: 1, order_id: order.order_id, service: "repair", price_credits: REPAIR_PRICE, payment_status: "awaiting_official_ledger_record" }));
    }
    return this.continueOrder(order, parsed.value.request);
  }

  private async continueOrder(order: SellerOrder, request: DeliverCheckRequest): Promise<SellerOutcome> {
    if (order.status === "awaiting_payment") {
      const scanned = await scanLedger(
        this.sharednet,
        (transfer) => transfer.memo === order.order_id,
        { not_before: order.created_at, timeout_ms: this.timeouts.ledger_ms },
      );
      const matched = matchRepairPayment(order, scanned.matches, this.policy, this.state.state.consumedTransferIds);
      if (!matched.accepted) {
        await this.state.ledger.append({ kind: "payment_rejected", phase: this.state.state.phase, details: { order_id: order.order_id, reason: matched.code } });
        return { status: "awaiting_payment", order: structuredClone(order), code: matched.code };
      }
      for (const transferId of matched.surplus_transfer_ids) {
        await this.state.ledger.append({ kind: "surplus_payment_recorded", phase: this.state.state.phase, details: { order_id: order.order_id, transfer_id: transferId } });
      }
      await this.state.verifyPayment(order, matched.transfer);
    }

    const pending = this.state.state.pendingDeliveries.get(order.order_id);
    if (pending !== undefined) {
      const page = await readMessagesPaginated(this.sharednet, pending.source_sequence - 1, { timeout_ms: this.timeouts.sharednet_read_ms });
      const found = page.items.find((item) => item.content.includes(`\"order_id\":\"${order.order_id}\"`) && computeCanonicalHash(item.content) === pending.content_hash);
      if (found !== undefined) {
        await this.confirmDelivery(order, found.id);
        return { status: "delivered", order: structuredClone(order), delivery_message_id: found.id, response_hash: "reconciled" };
      }
      throw new Error("A previous delivery outcome is unknown; automatic resend is denied.");
    }

    await this.state.ledger.append({ kind: "delivery_service_intent", phase: this.state.state.phase, details: { order_id: order.order_id, service: order.service, request_hash: order.request_hash } });
    const response = await withTimeout(this.delivercheck.invoke(order.service, request), this.timeouts.delivercheck_ms, "delivercheck_timeout");
    await this.state.ledger.append({ kind: "delivery_service_observed", phase: this.state.state.phase, details: { order_id: order.order_id, response_hash: computeCanonicalHash(response) } });
    const delivery = deliveryContent(order, response);
    await this.state.ledger.append({ kind: "delivery_intent", phase: this.state.state.phase, details: { order_id: order.order_id, content_hash: computeCanonicalHash(delivery.content), response_hash: delivery.response_hash, source_sequence: order.source_sequence } });
    this.state.state.pendingDeliveries.set(order.order_id, { content_hash: computeCanonicalHash(delivery.content), source_sequence: order.source_sequence });
    const sent = await this.sharednet.reply(order.source_message_id, delivery.content);
    await this.confirmDelivery(order, sent.message_id);
    return { status: "delivered", order: structuredClone(order), delivery_message_id: sent.message_id, response_hash: delivery.response_hash };
  }

  private async confirmDelivery(order: SellerOrder, messageId: string): Promise<void> {
    await this.state.ledger.append({ kind: "delivery_confirmed", phase: this.state.state.phase, details: { order_id: order.order_id, message_id: messageId } });
    order.status = "delivered";
    this.state.state.pendingDeliveries.delete(order.order_id);
    await this.#orders.delete(order.order_id);
  }

  async reconcilePendingOrders(): Promise<SellerOutcome[]> {
    const outcomes: SellerOutcome[] = [];
    const stored = await this.#orders.list();
    for (const value of stored.sort((left, right) => left.order.created_at.localeCompare(right.order.created_at) || left.order.order_id.localeCompare(right.order.order_id))) {
      const order = this.state.state.ordersById.get(value.order.order_id);
      if (order?.status === "delivered" || order?.status === "rejected") {
        await this.#orders.delete(value.order.order_id);
        continue;
      }
      if (order === undefined || computeCanonicalHash(value.request) !== order.request_hash) {
        await this.state.ledger.append({ kind: "order_integrity_failure", phase: this.state.state.phase, details: { order_id: value.order.order_id, reason: "missing_or_mismatched_durable_order" } });
        outcomes.push({ status: "operational_failure", order_id: value.order.order_id, code: "order_integrity_failure" });
        continue;
      }
      try {
        outcomes.push(await this.continueOrder(order, value.request));
      } catch (error) {
        const code = classifyArenaFailure(error) === "transient" ? "transient_order_failure" : "order_integrity_failure";
        await this.state.ledger.append({ kind: "order_retry_failed", phase: this.state.state.phase, details: { order_id: order.order_id, reason: code } });
        outcomes.push({ status: "operational_failure", order_id: order.order_id, code });
      }
    }
    return outcomes;
  }
}
