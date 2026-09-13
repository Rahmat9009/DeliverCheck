import type {
  ActionLedger,
  ArenaEvent,
  ArenaPhase,
  CreditTransfer,
  SellerOrder,
} from "./types.js";
import { ArenaOperationalError } from "./resilience.js";

export interface RecoveredArenaState {
  phase: ArenaPhase;
  cursor: number;
  messageIds: Set<string>;
  sequenceMessages: Map<number, string>;
  ordersByMessage: Map<string, SellerOrder>;
  ordersById: Map<string, SellerOrder>;
  consumedTransferIds: Set<string>;
  evaluatedProductIds: Set<string>;
  evaluations: Map<string, { product_id: string; seller_id: string; evidence_hash: string; disagreement: string; score: number; latency_ms: number }>;
  purchasedProductIds: Set<string>;
  purchasedSellerIds: Set<string>;
  spentCredits: number;
  rankingPrepared: boolean;
  rankingSubmitted: boolean;
  rankingSubmissionId: string | null;
  presentationPublished: boolean;
  presentationIntentHash: string | null;
  pendingDeliveries: Map<string, { content_hash: string; source_sequence: number }>;
  pendingPurchases: Map<string, { product_id: string; target: string; seller_id: string; amount: number; memo: string; transfer_id?: string; payment_attempted?: boolean }>;
}

function text(event: ArenaEvent, key: string): string {
  const value = event.details?.[key];
  return typeof value === "string" ? value : "";
}

function number(event: ArenaEvent, key: string): number {
  const value = event.details?.[key];
  return typeof value === "number" ? value : 0;
}

export function recoverArenaState(events: readonly ArenaEvent[]): RecoveredArenaState {
  const state: RecoveredArenaState = {
    phase: "preflight",
    cursor: 0,
    messageIds: new Set(),
    sequenceMessages: new Map(),
    ordersByMessage: new Map(),
    ordersById: new Map(),
    consumedTransferIds: new Set(),
    evaluatedProductIds: new Set(),
    evaluations: new Map(),
    purchasedProductIds: new Set(),
    purchasedSellerIds: new Set(),
    spentCredits: 0,
    rankingPrepared: false,
    rankingSubmitted: false,
    rankingSubmissionId: null,
    presentationPublished: false,
    presentationIntentHash: null,
    pendingDeliveries: new Map(),
    pendingPurchases: new Map(),
  };

  for (const event of events) {
    if (event.kind === "phase_changed") state.phase = text(event, "to") as ArenaPhase;
    if (event.kind === "presentation_intent") state.presentationIntentHash = text(event, "content_hash");
    if (event.kind === "presentation_confirmed") {
      state.presentationPublished = true;
      state.presentationIntentHash = null;
    }
    if (event.kind === "message_ignored" || event.kind === "order_created") {
      const messageId = text(event, "message_id");
      const sequence = number(event, "message_sequence");
      state.messageIds.add(messageId);
      state.sequenceMessages.set(sequence, messageId);
      state.cursor = Math.max(state.cursor, sequence);
    }
    if (event.kind === "order_created") {
      const order: SellerOrder = {
        order_id: text(event, "order_id"),
        source_message_id: text(event, "message_id"),
        source_sequence: number(event, "message_sequence"),
        buyer_principal_id: text(event, "buyer_principal_id"),
        buyer_instance_id: text(event, "buyer_instance_id"),
        service: text(event, "service") as SellerOrder["service"],
        request_hash: text(event, "request_hash"),
        created_at: text(event, "created_at"),
        status: text(event, "service") === "repair" ? "awaiting_payment" : "accepted",
      };
      state.ordersByMessage.set(order.source_message_id, order);
      state.ordersById.set(order.order_id, order);
    }
    if (event.kind === "payment_verified") {
      const order = state.ordersById.get(text(event, "order_id"));
      if (order) order.status = "payment_verified";
      state.consumedTransferIds.add(text(event, "transfer_id"));
    }
    if (event.kind === "delivery_intent") {
      state.pendingDeliveries.set(text(event, "order_id"), {
        content_hash: text(event, "content_hash"),
        source_sequence: number(event, "source_sequence"),
      });
    }
    if (event.kind === "delivery_confirmed") {
      const orderId = text(event, "order_id");
      const order = state.ordersById.get(orderId);
      if (order) order.status = "delivered";
      state.pendingDeliveries.delete(orderId);
    }
    if (event.kind === "round1_evaluated") {
      const evaluation = {
        product_id: text(event, "product_id"),
        seller_id: text(event, "seller_id"),
        evidence_hash: text(event, "evidence_hash"),
        disagreement: text(event, "disagreement"),
        score: number(event, "score"),
        latency_ms: number(event, "latency_ms"),
      };
      state.evaluatedProductIds.add(evaluation.product_id);
      state.evaluations.set(evaluation.product_id, evaluation);
    }
    if (event.kind === "ranking_prepared") state.rankingPrepared = true;
    if (event.kind === "ranking_submitted") {
      state.rankingSubmitted = true;
      state.rankingSubmissionId = text(event, "submission_id");
    }
    if (event.kind === "purchase_intent") {
      state.pendingPurchases.set(text(event, "purchase_id"), {
        product_id: text(event, "product_id"),
        target: text(event, "target"),
        seller_id: text(event, "seller_id"),
        amount: number(event, "amount"),
        memo: text(event, "memo"),
      });
    }
    if (event.kind === "purchase_payment_verified") {
      const purchaseId = text(event, "purchase_id");
      const pending = state.pendingPurchases.get(purchaseId);
      if (pending) pending.transfer_id = text(event, "transfer_id");
      state.purchasedProductIds.add(text(event, "product_id"));
      state.purchasedSellerIds.add(text(event, "seller_id"));
      state.consumedTransferIds.add(text(event, "transfer_id"));
      state.spentCredits += number(event, "amount");
    }
    if (event.kind === "purchase_payment_attempt") {
      const pending = state.pendingPurchases.get(text(event, "purchase_id"));
      if (pending) pending.payment_attempted = true;
    }
    if (event.kind === "purchase_confirmed" || event.kind === "purchase_invocation_failed") {
      const purchaseId = text(event, "purchase_id");
      state.pendingPurchases.delete(purchaseId);
      // Compatibility with checkpoint 6B2 ledgers where settlement and invocation
      // were represented by one purchase_confirmed event.
      if (event.kind === "purchase_confirmed" && text(event, "transfer_id")) {
        state.purchasedProductIds.add(text(event, "product_id"));
        state.purchasedSellerIds.add(text(event, "seller_id"));
        state.consumedTransferIds.add(text(event, "transfer_id"));
        state.spentCredits += number(event, "amount");
      }
    }
  }
  return state;
}

const TRANSITIONS: Record<ArenaPhase, readonly ArenaPhase[]> = {
  preflight: ["waiting", "halted"],
  waiting: ["critique", "halted"],
  critique: ["market", "halted"],
  market: ["completed", "halted"],
  completed: [],
  halted: [],
};

export class ArenaStateController {
  private constructor(
    readonly ledger: ActionLedger,
    readonly state: RecoveredArenaState,
  ) {}

  static async open(ledger: ActionLedger): Promise<ArenaStateController> {
    return new ArenaStateController(ledger, recoverArenaState(await ledger.readAll()));
  }

  async transition(to: ArenaPhase, reason: string): Promise<void> {
    if (!TRANSITIONS[this.state.phase].includes(to)) {
      throw new Error(`Invalid Arena phase transition from ${this.state.phase} to ${to}.`);
    }
    await this.ledger.append({ kind: "phase_changed", phase: this.state.phase, details: { from: this.state.phase, to, reason } });
    this.state.phase = to;
  }

  assertNewMessage(messageId: string, sequence: number): boolean {
    if (this.state.messageIds.has(messageId)) return false;
    const existing = this.state.sequenceMessages.get(sequence);
    if (existing !== undefined && existing !== messageId) throw new ArenaOperationalError("integrity", "sequence_rebinding", "A SharedNet sequence was replayed with a different message ID.");
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ArenaOperationalError("integrity", "invalid_sequence", "The SharedNet message sequence is invalid.");
    return true;
  }

  async ignoreMessage(messageId: string, sequence: number, reason: string): Promise<void> {
    await this.ledger.append({ kind: "message_ignored", phase: this.state.phase, details: { message_id: messageId, message_sequence: sequence, reason } });
    this.state.messageIds.add(messageId);
    this.state.sequenceMessages.set(sequence, messageId);
    this.state.cursor = Math.max(this.state.cursor, sequence);
  }

  async createOrder(order: SellerOrder): Promise<void> {
    const existing = this.state.ordersById.get(order.order_id);
    if (existing !== undefined && existing.source_message_id !== order.source_message_id) {
      throw new ArenaOperationalError("integrity", "order_id_collision", "The generated Arena order ID is not unique.");
    }
    await this.ledger.append({
      kind: "order_created",
      phase: this.state.phase,
      details: {
        order_id: order.order_id,
        message_id: order.source_message_id,
        message_sequence: order.source_sequence,
        buyer_principal_id: order.buyer_principal_id,
        buyer_instance_id: order.buyer_instance_id,
        service: order.service,
        request_hash: order.request_hash,
        created_at: order.created_at,
      },
    });
    this.state.ordersByMessage.set(order.source_message_id, order);
    this.state.ordersById.set(order.order_id, order);
    this.state.messageIds.add(order.source_message_id);
    this.state.sequenceMessages.set(order.source_sequence, order.source_message_id);
    this.state.cursor = Math.max(this.state.cursor, order.source_sequence);
  }

  async verifyPayment(order: SellerOrder, transfer: CreditTransfer): Promise<void> {
    await this.ledger.append({ kind: "payment_verified", phase: this.state.phase, details: { order_id: order.order_id, transfer_id: transfer.id, amount: transfer.amount } });
    order.status = "payment_verified";
    this.state.consumedTransferIds.add(transfer.id);
  }
}
