import type { DeliverCheckRequest } from "../types.js";

export type ArenaMode = "simulate" | "live";
export type ArenaPhase =
  | "preflight"
  | "waiting"
  | "critique"
  | "market"
  | "completed"
  | "halted";

export type PublicIdentityKind = "principal" | "agent" | "instance" | "node";
export type PaymentIdentityKind = Exclude<PublicIdentityKind, "node">;

export interface ConfirmedIdentity<K extends PublicIdentityKind = PublicIdentityKind> {
  kind: K;
  id: string;
  organizer_confirmed: true;
}

export interface ArenaTiming {
  arena_starts_at: string;
  round_1_ends_at: string;
  round_2_starts_at: string;
  round_2_ends_at: string;
  timezone: string;
}

export interface SimulationArenaConfig {
  mode: "simulate";
  delivercheck_origin?: string;
}

export interface LiveArenaConfig {
  mode: "live";
  explicit_live_enablement: true;
  protocol_profile_version: string;
  cli_version: "0.1.8";
  server_protocol_version: "1.0.0";
  arena_room_id: string;
  arena_instance_id: string;
  account_principal_id: string;
  submission_identity: ConfirmedIdentity;
  seller_payment_recipient: ConfirmedIdentity<PaymentIdentityKind>;
  seller_payment_principal_id: string;
  self_identities: ConfirmedIdentity[];
  ranking_method: {
    adapter: string;
    organizer_confirmed: true;
  };
  marketplace: {
    adapter: string;
    protocol_version: string;
    organizer_confirmed: true;
  };
  purchase_convention: {
    adapter: string;
    memo_prefix: string;
    canonical_recipient: "principal";
    exact_price: true;
    organizer_confirmed: true;
  };
  canonical_identity: {
    seller_key: "principal";
    mappings_verified: true;
    organizer_confirmed: true;
  };
  round_timing: ArenaTiming;
  delivercheck_origin: string;
  payment_room_binding: boolean;
  timeouts: ArenaTimeouts;
}

export type ArenaConfig = SimulationArenaConfig | LiveArenaConfig;

export interface SharedNetMessage {
  id: string;
  room_id: string;
  sequence: number;
  sender_principal_id: string | null;
  sender_agent_id: string | null;
  sender_instance_id: string | null;
  content: string;
  created_at: string;
}

export interface MessagePage {
  items: SharedNetMessage[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface CreditBalance {
  principal_id: string;
  balance: number;
  granted: number;
  sent: number;
  received: number;
}

export interface CreditTransfer {
  id: string;
  from_principal_id: string;
  to_principal_id: string;
  amount: number;
  memo: string | null;
  room_id: string | null;
  by_instance_id: string | null;
  addressed_to: string;
  code: string | null;
  created_at: string;
}

export interface SharedNetAdapter {
  readonly mode: ArenaMode;
  identity(): Promise<{ room_id: string | null; instance_id: string | null; principal_id: string | null }>;
  read(after: number, limit?: number): Promise<MessagePage>;
  wait(timeoutSeconds: number, minimum?: number, after?: number): Promise<MessagePage>;
  say(content: string): Promise<{ message_id: string }>;
  reply(messageId: string, content: string): Promise<{ message_id: string }>;
  balance(): Promise<CreditBalance>;
  ledger(limit?: number, before?: string): Promise<CreditTransfer[]>;
  pay(input: {
    target: string;
    amount: number;
    memo: string;
    bind_to_room: boolean;
  }): Promise<{ transfer: CreditTransfer; receipt_message_id?: string }>;
  protocolStatus(): Promise<{ cli_version: string; server_protocol_version: string }>;
}

export interface ParsedServiceRequest {
  service: "diagnose" | "repair";
  request: DeliverCheckRequest;
  syntax: "structured" | "natural_language";
}

export interface SellerOrder {
  order_id: string;
  source_message_id: string;
  source_sequence: number;
  buyer_principal_id: string;
  buyer_instance_id: string;
  service: "diagnose" | "repair";
  request_hash: string;
  created_at: string;
  status: "accepted" | "awaiting_payment" | "payment_verified" | "delivered" | "rejected";
}

export interface ProductAssertion {
  path: readonly string[];
  equals: unknown;
  description: string;
}

export interface ArenaProduct {
  product_id: string;
  name: string;
  seller: ConfirmedIdentity<PaymentIdentityKind>;
  /** Canonical seller owner. Required when seller.kind is not principal. */
  seller_principal_id?: string;
  /** Exact payment address with a verified mapping to the canonical Principal. */
  payment_recipient?: ConfirmedIdentity<PaymentIdentityKind> & { principal_id: string; mapping_verified: true };
  price_credits: number;
  useful_purpose: string;
  probe_input?: unknown;
  assertion?: ProductAssertion;
  endpoint?: string;
}

export interface ProductExecution {
  product_id: string;
  output: unknown;
  latency_ms: number;
  protocol_ok: boolean;
  evidence_provided: boolean;
}

export interface ProductMarketplace {
  readonly adapter_id?: string;
  readonly protocol_version?: string;
  discover(): Promise<unknown[]>;
  available(product: ArenaProduct): Promise<boolean>;
  invoke(product: ArenaProduct, orderId: string): Promise<ProductExecution>;
  critique?(product: ArenaProduct, execution: ProductExecution): ProductEvaluation | null;
}

export interface ProductEvaluation {
  product_id: string;
  seller_id: string;
  evidence_hash: string;
  disagreement: string;
  score: number;
  latency_ms: number;
}

export interface RankingEntry {
  rank: number;
  product_id: string;
  score: number;
  reason: string;
}

export interface RankingAdapter {
  readonly method: string;
  readonly idempotent: true;
  submit(entries: readonly RankingEntry[], operationId: string): Promise<{ submission_id: string }>;
}

export interface DeliverCheckClient {
  invoke(service: "diagnose" | "repair", request: DeliverCheckRequest): Promise<unknown>;
}

export interface ArenaTimeouts {
  sharednet_read_ms: number;
  ledger_ms: number;
  marketplace_ms: number;
  product_invocation_ms: number;
  delivercheck_ms: number;
}

export interface StoredSellerOrder {
  order: SellerOrder;
  request: DeliverCheckRequest;
}

export interface PendingOrderStore {
  put(value: StoredSellerOrder): Promise<void>;
  get(orderId: string): Promise<StoredSellerOrder | null>;
  list(): Promise<StoredSellerOrder[]>;
  delete(orderId: string): Promise<void>;
}

export type LedgerDetail = string | number | boolean | null;

export interface ArenaEventInput {
  kind: string;
  phase: ArenaPhase;
  details?: Readonly<Record<string, LedgerDetail>>;
}

export interface ArenaEvent extends ArenaEventInput {
  sequence: number;
  event_id: string;
  recorded_at: string;
  previous_hash: string;
  event_hash: string;
}

export interface ActionLedger {
  readAll(): Promise<readonly ArenaEvent[]>;
  append(input: ArenaEventInput): Promise<ArenaEvent>;
}
