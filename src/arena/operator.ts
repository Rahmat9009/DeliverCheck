import { validateLiveConfig } from "./config.js";
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

  constructor(options: ArenaOperatorOptions) {
    this.#config = options.config ?? { mode: "simulate" };
    this.#state = options.state;
    this.#sharednet = options.sharednet;
    this.#marketplace = options.marketplace;
    this.#ranking = options.ranking;
    this.#roundTwoPolicy = options.round_two_policy;
    this.#sellerPolicy = options.seller_policy;
    this.#now = options.now ?? Date.now;
    this.#seller = new DeliverCheckSellerWorkflow(
      options.state,
      options.sharednet,
      options.delivercheck,
      options.seller_policy,
      options.order_id ?? ((message) => `order:${message.id}`),
    );
  }

  get phase() { return this.#state.state.phase; }
  get state() { return this.#state.state; }

  async preflight(): Promise<void> {
    if (this.#config.mode === "live") {
      const live = validateLiveConfig(this.#config);
      if (this.#sharednet.mode !== "live") throw new Error("Live Arena mode requires the live SharedNet adapter.");
      if (this.#ranking.method !== live.ranking_method.adapter) throw new Error("The ranking adapter does not match the organizer-confirmed method.");
      if (
        this.#sellerPolicy.room_id !== live.arena_room_id ||
        this.#sellerPolicy.seller_principal_id !== live.account_principal_id ||
        this.#sellerPolicy.payment_recipient.kind !== live.seller_payment_recipient.kind ||
        this.#sellerPolicy.payment_recipient.id !== live.seller_payment_recipient.id ||
        this.#sellerPolicy.require_room_binding !== live.payment_room_binding
      ) throw new Error("The seller policy does not match the organizer-confirmed live profile.");
      for (const selfId of [live.account_principal_id, live.arena_instance_id, live.seller_payment_recipient.id]) {
        if (!this.#roundTwoPolicy.self_ids.has(selfId)) throw new Error("Round 2 self-payment protection is incomplete.");
      }
      const identity = await this.#sharednet.identity();
      if (identity.room_id !== live.arena_room_id || identity.instance_id !== live.arena_instance_id || identity.principal_id !== live.account_principal_id) {
        throw new Error("The selected SharedNet seat does not match the live Arena profile.");
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
    let page = await this.#sharednet.read(this.state.cursor, 100);
    if (page.items.length === 0) page = await this.#sharednet.wait(timeoutSeconds, 1);
    for (const message of [...page.items].sort((left, right) => left.sequence - right.sequence)) {
      if (this.state.messageIds.has(message.id)) {
        const pendingOrder = this.state.ordersByMessage.get(message.id);
        if (pendingOrder === undefined || pendingOrder.status === "delivered" || pendingOrder.status === "rejected") continue;
      }
      outcomes.push(await this.handleSellerMessage(message));
    }
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
    if (this.phase !== "waiting") throw new Error("Round 1 must begin from the waiting phase.");
    this.assertRoundWindow(1);
    await this.#state.transition("critique", "round_1_started");
    try {
      const result = await runRoundOne(this.#state, this.#marketplace, this.#ranking, this.#config.mode === "live" ? { deadline_at: Date.parse(this.#config.round_timing.round_1_ends_at), now: this.#now } : undefined);
      await this.#state.transition("market", "round_1_completed");
      return result;
    } catch (error) {
      await this.halt("round_1_failed");
      throw error;
    }
  }

  async runRoundTwo(): Promise<RoundTwoResult> {
    if (this.phase !== "market") throw new Error("Round 2 must begin from the market phase.");
    this.assertRoundWindow(2);
    try {
      const policy = this.#config.mode === "live" ? { ...this.#roundTwoPolicy, deadline_at: Date.parse(this.#config.round_timing.round_2_ends_at), now: this.#now } : this.#roundTwoPolicy;
      const result = await runRoundTwo(this.#state, this.#sharednet, this.#marketplace, policy);
      await this.#state.transition("completed", "round_2_completed");
      return result;
    } catch (error) {
      await this.halt("round_2_failed");
      throw error;
    }
  }

  async halt(reason: string): Promise<void> {
    if (this.phase !== "halted" && this.phase !== "completed") await this.#state.transition("halted", reason);
  }
}
