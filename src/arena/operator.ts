import { validateLiveConfig } from "./config.js";
import { readMessagesPaginated } from "./pagination.js";
import { classifyArenaFailure, withTimeout } from "./resilience.js";
import { runRoundOne, runRoundTwo, type RoundOneResult, type RoundTwoPolicy, type RoundTwoResult } from "./rounds.js";
import { DeliverCheckSellerWorkflow, type SellerOutcome, type SellerPolicy } from "./seller.js";
import type { ArenaStateController } from "./state.js";
import type {
  ArenaConfig,
  DeliverCheckClient,
  ProductMarketplace,
  RankingAdapter,
  SharedNetAdapter,
  SharedNetMessage,
  PendingOrderStore,
  ArenaTimeouts,
} from "./types.js";

export interface ArenaOperatorOptions {
  config?: ArenaConfig;
  state: ArenaStateController;
  sharednet: SharedNetAdapter;
  delivercheck: DeliverCheckClient;
  marketplace: ProductMarketplace;
  ranking: RankingAdapter;
  seller_policy: SellerPolicy;
  round_two_policy: RoundTwoPolicy;
  order_id?: (message: SharedNetMessage) => string;
  now?: () => number;
  orders?: PendingOrderStore;
  timeouts?: ArenaTimeouts;
  after_external_action?: () => Promise<void>;
}

export class ArenaOperator {
  readonly #config: ArenaConfig;
  readonly #state: ArenaStateController;
  readonly #sharednet: SharedNetAdapter;
  readonly #marketplace: ProductMarketplace;
  readonly #ranking: RankingAdapter;
  readonly #seller: DeliverCheckSellerWorkflow;
  readonly #sellerPolicy: SellerPolicy;
  readonly #roundTwoPolicy: RoundTwoPolicy;
  readonly #now: () => number;
  readonly #timeouts: ArenaTimeouts;
  readonly #afterExternalAction: (() => Promise<void>) | undefined;

  constructor(options: ArenaOperatorOptions) {
    this.#config = options.config ?? { mode: "simulate" };
    this.#state = options.state;
    this.#sharednet = options.sharednet;
    this.#marketplace = options.marketplace;
    this.#ranking = options.ranking;
    this.#roundTwoPolicy = options.round_two_policy;
    this.#sellerPolicy = options.seller_policy;
    this.#now = options.now ?? Date.now;
    this.#timeouts = options.timeouts ?? {
      sharednet_read_ms: 30_000,
      ledger_ms: 30_000,
      marketplace_ms: 30_000,
      product_invocation_ms: 60_000,
      delivercheck_ms: 240_000,
    };
    this.#afterExternalAction = options.after_external_action;
    this.#seller = new DeliverCheckSellerWorkflow(
      options.state,
      options.sharednet,
      options.delivercheck,
      options.seller_policy,
      options.order_id ?? ((message) => `order:${message.id}`),
      options.orders,
      this.#timeouts,
    );
  }

  get phase() { return this.#state.state.phase; }
  get state() { return this.#state.state; }

  async preflight(): Promise<void> {
    if (this.#config.mode === "live") {
      const live = validateLiveConfig(this.#config);
      if (this.#sharednet.mode !== "live") throw new Error("Live Arena mode requires the live SharedNet adapter.");
      if (this.#ranking.method !== live.ranking_method.adapter) throw new Error("The ranking adapter does not match the organizer-confirmed method.");
      if (this.#marketplace.adapter_id !== live.marketplace.adapter || this.#marketplace.protocol_version !== live.marketplace.protocol_version) {
        throw new Error("The marketplace adapter does not match the organizer-confirmed method.");
      }
      if (
        this.#sellerPolicy.room_id !== live.arena_room_id ||
        this.#sellerPolicy.seller_principal_id !== live.account_principal_id ||
        this.#sellerPolicy.payment_recipient.kind !== live.seller_payment_recipient.kind ||
        this.#sellerPolicy.payment_recipient.id !== live.seller_payment_recipient.id ||
        this.#sellerPolicy.require_room_binding !== live.payment_room_binding
      ) throw new Error("The seller policy does not match the organizer-confirmed live profile.");
      for (const selfId of live.self_identities.map((identity) => identity.id)) {
        if (!this.#roundTwoPolicy.self_ids.has(selfId)) throw new Error("Round 2 self-payment protection is incomplete.");
      }
      const identity = await this.#sharednet.identity();
      if (identity.room_id !== live.arena_room_id || identity.instance_id !== live.arena_instance_id || identity.principal_id !== live.account_principal_id) {
        throw new Error("The selected SharedNet seat does not match the live Arena profile.");
      }
      const protocol = await this.#sharednet.protocolStatus();
      if (protocol.cli_version !== live.cli_version || protocol.server_protocol_version !== live.server_protocol_version) {
        throw new Error("The active SharedNet CLI or server protocol version does not match the reviewed live profile.");
      }
    } else if (this.#sharednet.mode !== "simulate") {
      throw new Error("Simulation mode refuses a live SharedNet adapter.");
    }
    if (this.#state.state.phase === "preflight") {
      await this.#state.ledger.append({ kind: "preflight_passed", phase: "preflight", details: { mode: this.#config.mode } });
      await this.#state.transition("waiting", `${this.#config.mode}_preflight_passed`);
    }
  }

  async publishPresentation(): Promise<string> {
    if (this.phase !== "waiting") throw new Error("Product presentation is only allowed in the waiting phase.");
    return this.#seller.publishPresentation();
  }

  async handleSellerMessage(message: SharedNetMessage): Promise<SellerOutcome> {
    if (!["waiting", "critique", "market"].includes(this.phase)) throw new Error("Seller requests are not accepted in the current Arena phase.");
    if (this.#config.mode === "live" && this.#now() + 240_000 >= Date.parse(this.#config.round_timing.round_2_ends_at)) {
      throw new Error("The Arena deadline safety margin has been reached.");
    }
    return this.#seller.handleMessage(structuredClone(message));
  }

  async monitorOnce(timeoutSeconds = 25): Promise<SellerOutcome[]> {
    if (!["waiting", "critique", "market"].includes(this.phase)) throw new Error("Room monitoring is not allowed in the current Arena phase.");
    const outcomes: SellerOutcome[] = [];
    let messages = (await readMessagesPaginated(this.#sharednet, this.state.cursor, { timeout_ms: this.#timeouts.sharednet_read_ms })).items;
    if (messages.length === 0) messages = (await withTimeout(this.#sharednet.wait(timeoutSeconds, 1, this.state.cursor), this.#timeouts.sharednet_read_ms, "sharednet_wait_timeout")).items.filter((item) => item.sequence > this.state.cursor);
    for (const message of [...messages].sort((left, right) => left.sequence - right.sequence)) {
      if (this.state.messageIds.has(message.id)) {
        const pendingOrder = this.state.ordersByMessage.get(message.id);
        if (pendingOrder === undefined || pendingOrder.status === "delivered" || pendingOrder.status === "rejected") continue;
      }
      try {
        outcomes.push(await this.handleSellerMessage(message));
      } catch (error) {
        await this.#state.ledger.append({ kind: "message_processing_failed", phase: this.phase, details: { message_id: message.id, message_sequence: message.sequence, reason: "isolated_operational_failure" } });
        if (classifyArenaFailure(error) !== "transient") throw error;
        outcomes.push({ status: "operational_failure", order_id: this.state.ordersByMessage.get(message.id)?.order_id ?? "uncreated", code: "isolated_message_failure" });
      }
    }
    outcomes.push(...await this.#seller.reconcilePendingOrders());
    return outcomes;
  }

  private assertRoundWindow(round: 1 | 2): void {
    if (this.#config.mode !== "live") return;
    const timing = this.#config.round_timing;
    const now = this.#now();
    const start = Date.parse(round === 1 ? timing.arena_starts_at : timing.round_2_starts_at);
    const end = Date.parse(round === 1 ? timing.round_1_ends_at : timing.round_2_ends_at);
    if (now < start || now >= end) throw new Error(`Round ${round} is outside its organizer-confirmed execution window.`);
  }

  async runRoundOne(): Promise<RoundOneResult> {
    if (this.phase !== "waiting" && this.phase !== "critique") throw new Error("Round 1 must begin or resume from the waiting/critique phase.");
    this.assertRoundWindow(1);
    if (this.phase === "waiting") await this.#state.transition("critique", "round_1_started");
    const deadline = this.#config.mode === "live" ? { deadline_at: Date.parse(this.#config.round_timing.round_1_ends_at), now: this.#now } : undefined;
    const result = await runRoundOne(this.#state, this.#marketplace, this.#ranking, {
      ...deadline,
      self_ids: this.#roundTwoPolicy.self_ids,
      timeout_ms: this.#timeouts.product_invocation_ms,
      discovery_timeout_ms: this.#timeouts.marketplace_ms,
      ...(this.#afterExternalAction === undefined ? {} : { after_external_action: this.#afterExternalAction }),
    });
    await this.#state.transition("market", "round_1_completed");
    return result;
  }

  async runRoundTwo(): Promise<RoundTwoResult> {
    if (this.phase !== "market") throw new Error("Round 2 must begin from the market phase.");
    this.assertRoundWindow(2);
    const policy = this.#config.mode === "live" ? { ...this.#roundTwoPolicy, deadline_at: Date.parse(this.#config.round_timing.round_2_ends_at), now: this.#now } : this.#roundTwoPolicy;
    const result = await runRoundTwo(this.#state, this.#sharednet, this.#marketplace, {
      ...policy,
      ledger_timeout_ms: this.#timeouts.ledger_ms,
      discovery_timeout_ms: this.#timeouts.marketplace_ms,
      invocation_timeout_ms: this.#timeouts.product_invocation_ms,
      ...(this.#afterExternalAction === undefined ? {} : { after_external_action: this.#afterExternalAction }),
    });
    await this.#state.transition("completed", "round_2_completed");
    return result;
  }

  async halt(reason: string): Promise<void> {
    if (this.phase !== "halted" && this.phase !== "completed") await this.#state.transition("halted", reason);
  }

  async recordOperationalFailure(kind: "transient" | "integrity" | "configuration", code: string): Promise<void> {
    await this.#state.ledger.append({ kind: "operator_failure", phase: this.phase, details: { failure_kind: kind, code } });
  }
}
