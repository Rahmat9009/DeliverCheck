import { computeCanonicalHash } from "../verify/canonical.js";
import type { DeliverCheckRequest } from "../types.js";
import { parseServiceRequest, productPresentation } from "./messages.js";
import type { ArenaStateController } from "./state.js";
import type {
  ConfirmedIdentity,
  CreditTransfer,
  DeliverCheckClient,
  PaymentIdentityKind,
  SellerOrder,
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
  | { accepted: true; transfer: CreditTransfer }
  | { accepted: false; code: PaymentFailureCode };

export type SellerOutcome =
  | { status: "ignored" | "duplicate"; code: string }
  | { status: "awaiting_payment"; order: SellerOrder; code: PaymentFailureCode }
  | { status: "delivered"; order: SellerOrder; delivery_message_id: string; response_hash: string };

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
  const exact = related.filter((transfer) => transfer.amount === REPAIR_PRICE && !consumed.has(transfer.id));
  if (exact.length === 1) return { accepted: true, transfer: exact[0]! };
  if (exact.length > 1) return { accepted: false, code: "duplicate_payment" };
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
  constructor(
    private readonly state: ArenaStateController,
    private readonly sharednet: SharedNetAdapter,
    private readonly delivercheck: DeliverCheckClient,
    private readonly policy: SellerPolicy,
    private readonly orderId: (message: SharedNetMessage) => string,
  ) {}

  async publishPresentation(): Promise<string> {
    if (this.state.state.presentationPublished) return "already_published";
    const content = productPresentation();
    if (this.state.state.presentationIntentHash !== null) {
      const page = await this.sharednet.read(this.state.state.cursor, 100);
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
      return this.continueOrder(existing, parsed.value.request);
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
    await this.state.createOrder(order);
    if (order.service === "repair") {
      await this.sharednet.reply(message.id, JSON.stringify({ type: "delivercheck.order", version: 1, order_id: order.order_id, service: "repair", price_credits: REPAIR_PRICE, payment_status: "awaiting_official_ledger_record" }));
    }
    return this.continueOrder(order, parsed.value.request);
  }

  private async continueOrder(order: SellerOrder, request: DeliverCheckRequest): Promise<SellerOutcome> {
    if (order.status === "awaiting_payment") {
      const matched = matchRepairPayment(order, await this.sharednet.ledger(100), this.policy, this.state.state.consumedTransferIds);
      if (!matched.accepted) {
        await this.state.ledger.append({ kind: "payment_rejected", phase: this.state.state.phase, details: { order_id: order.order_id, reason: matched.code } });
        return { status: "awaiting_payment", order: structuredClone(order), code: matched.code };
      }
      await this.state.verifyPayment(order, matched.transfer);
    }

    const pending = this.state.state.pendingDeliveries.get(order.order_id);
    if (pending !== undefined) {
      const page = await this.sharednet.read(pending.source_sequence - 1, 100);
      const found = page.items.find((item) => item.content.includes(`\"order_id\":\"${order.order_id}\"`) && computeCanonicalHash(item.content) === pending.content_hash);
      if (found !== undefined) {
        await this.confirmDelivery(order, found.id);
        return { status: "delivered", order: structuredClone(order), delivery_message_id: found.id, response_hash: "reconciled" };
      }
      throw new Error("A previous delivery outcome is unknown; automatic resend is denied.");
    }

    const response = await this.delivercheck.invoke(order.service, request);
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
  }
}
