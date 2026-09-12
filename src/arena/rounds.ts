import { computeCanonicalHash } from "../verify/canonical.js";
import { identityMatchesKind } from "./config.js";
import type { ArenaStateController } from "./state.js";
import type {
  ArenaProduct,
  CreditTransfer,
  ProductEvaluation,
  ProductMarketplace,
  RankingAdapter,
  RankingEntry,
  SharedNetAdapter,
} from "./types.js";

export interface RoundOneResult {
  evaluations: ProductEvaluation[];
  ranking: RankingEntry[];
  submission_id: string;
}

export interface RoundTwoResult {
  products: string[];
  sellers: string[];
  spent_credits: number;
  starting_balance: number;
  ending_balance: number;
}

export interface RoundTwoPolicy {
  minimum_spend: number;
  maximum_spend: number;
  minimum_sellers: number;
  room_id: string;
  bind_payments_to_room: boolean;
  self_ids: ReadonlySet<string>;
  deadline_at?: number;
  now?: () => number;
}

const OPERATION_MARGIN_MS = 240_000;

function assertDeadline(deadlineAt: number | undefined, now: (() => number) | undefined): void {
  if (deadlineAt !== undefined && (now ?? Date.now)() + OPERATION_MARGIN_MS >= deadlineAt) {
    throw new Error("The Arena deadline safety margin has been reached.");
  }
}

function jsonHash(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Product output is not JSON serializable.");
  return computeCanonicalHash(JSON.parse(text) as never);
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const segment of path) {
    if (value === null || typeof value !== "object" || !(segment in value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function compact(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return "undefined";
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

function evaluate(product: ArenaProduct, execution: Awaited<ReturnType<ProductMarketplace["invoke"]>>): ProductEvaluation | null {
  const observed = valueAt(execution.output, product.assertion.path);
  if (jsonHash(observed ?? null) === jsonHash(product.assertion.equals)) return null;
  const score = (execution.protocol_ok ? 40 : 0) + (execution.evidence_provided ? 30 : 0) +
    (execution.output !== null && typeof execution.output === "object" ? 20 : 0) + Math.max(0, 10 - Math.floor(execution.latency_ms / 100));
  return {
    product_id: product.product_id,
    seller_id: product.seller.id,
    evidence_hash: jsonHash(execution.output),
    disagreement: `${product.assertion.description}; expected ${compact(product.assertion.equals)} at /${product.assertion.path.join("/")}, observed ${compact(observed)}.`,
    score,
    latency_ms: execution.latency_ms,
  };
}

function validateCatalogue(products: readonly ArenaProduct[]): void {
  const ids = new Set<string>();
  for (const product of products) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(product.product_id) || ids.has(product.product_id)) throw new Error("The product catalogue contains an invalid or duplicate product ID.");
    ids.add(product.product_id);
    if (!validPrice(product) || !product.name.trim() || product.name.length > 160 || product.useful_purpose.length > 500) throw new Error("The product catalogue contains invalid product metadata.");
    if (product.seller.organizer_confirmed !== true || !identityMatchesKind(product.seller.kind, product.seller.id)) throw new Error("The product catalogue contains an unconfirmed or invalid seller identity.");
    if (product.assertion.path.length === 0 || product.assertion.path.length > 16 || product.assertion.path.some((segment) => !segment || segment.length > 128)) throw new Error("The product catalogue contains an invalid evaluation assertion.");
    jsonHash(product.probe_input);
    jsonHash(product.assertion.equals);
  }
}

export async function runRoundOne(
  state: ArenaStateController,
  marketplace: ProductMarketplace,
  rankingAdapter: RankingAdapter,
  deadline?: { deadline_at: number; now: () => number },
): Promise<RoundOneResult> {
  const products = await marketplace.discover();
  validateCatalogue(products);
  const evaluations: ProductEvaluation[] = [...state.state.evaluations.values()];
  const attempted = new Set<string>();
  for (const product of products) {
    if (evaluations.length >= 3) break;
    if (attempted.has(product.product_id) || state.state.evaluatedProductIds.has(product.product_id)) continue;
    attempted.add(product.product_id);
    if (!(await marketplace.available(product))) continue;
    assertDeadline(deadline?.deadline_at, deadline?.now);
    const execution = await marketplace.invoke(product, `round1:${product.product_id}`);
    const result = evaluate(product, execution);
    if (result === null) continue;
    evaluations.push(result);
    await state.ledger.append({ kind: "round1_evaluated", phase: state.state.phase, details: { product_id: result.product_id, seller_id: result.seller_id, evidence_hash: result.evidence_hash, disagreement: result.disagreement, score: result.score, latency_ms: result.latency_ms } });
    state.state.evaluatedProductIds.add(result.product_id);
    state.state.evaluations.set(result.product_id, result);
    if (evaluations.length === 3) break;
  }
  if (evaluations.length < 3) throw new Error("Round 1 requires three executed products with one specific disagreement each.");

  const ranking = [...evaluations]
    .sort((left, right) => right.score - left.score || left.latency_ms - right.latency_ms || left.product_id.localeCompare(right.product_id))
    .map((entry, index) => ({ rank: index + 1, product_id: entry.product_id, score: entry.score, reason: `Ranked by protocol compliance, evidence, structured output, and measured latency; disagreement: ${entry.disagreement}` }));
  await state.ledger.append({ kind: "ranking_prepared", phase: state.state.phase, details: { products: ranking.length, ranking_hash: jsonHash(ranking), method: rankingAdapter.method } });
  state.state.rankingPrepared = true;
  if (state.state.rankingSubmitted && state.state.rankingSubmissionId !== null) {
    return { evaluations, ranking, submission_id: state.state.rankingSubmissionId };
  }
  assertDeadline(deadline?.deadline_at, deadline?.now);
  const submitted = await rankingAdapter.submit(ranking, "round1-ranking");
  await state.ledger.append({ kind: "ranking_submitted", phase: state.state.phase, details: { submission_id: submitted.submission_id, method: rankingAdapter.method } });
  state.state.rankingSubmitted = true;
  state.state.rankingSubmissionId = submitted.submission_id;
  return { evaluations, ranking, submission_id: submitted.submission_id };
}

function validPrice(product: ArenaProduct): boolean {
  return Number.isSafeInteger(product.price_credits) && product.price_credits >= 1 && product.price_credits <= 100 && product.useful_purpose.trim().length > 0;
}

function choosePlan(products: readonly ArenaProduct[], policy: RoundTwoPolicy): ArenaProduct[] {
  const usable = products
    .filter(validPrice)
    .filter((product) => !policy.self_ids.has(product.seller.id))
    .sort((a, b) => a.product_id.localeCompare(b.product_id));
  let best: ArenaProduct[] | null = null;
  const search = (index: number, selected: ArenaProduct[], total: number, sellers: Set<string>): void => {
    if (total > policy.maximum_spend) return;
    if (total >= policy.minimum_spend && sellers.size >= policy.minimum_sellers) {
      if (best === null || total < best.reduce((sum, product) => sum + product.price_credits, 0) ||
        (total === best.reduce((sum, product) => sum + product.price_credits, 0) && selected.length < best.length)) best = [...selected];
      return;
    }
    for (let cursor = index; cursor < usable.length; cursor += 1) {
      const product = usable[cursor]!;
      if (sellers.has(product.seller.id)) continue;
      selected.push(product);
      sellers.add(product.seller.id);
      search(cursor + 1, selected, total + product.price_credits, sellers);
      sellers.delete(product.seller.id);
      selected.pop();
    }
  };
  search(0, [], 0, new Set());
  if (best === null) throw new Error("No useful three-seller purchase plan satisfies the configured 80–100 credit budget.");
  return best;
}

function outgoingMatch(transfer: CreditTransfer, principalId: string, target: string, amount: number, memo: string, roomId: string, bindRoom: boolean): boolean {
  return transfer.from_principal_id === principalId && transfer.addressed_to === target && transfer.amount === amount && transfer.memo === memo && (!bindRoom || transfer.room_id === roomId);
}

export async function runRoundTwo(
  state: ArenaStateController,
  sharednet: SharedNetAdapter,
  marketplace: ProductMarketplace,
  policy: RoundTwoPolicy,
): Promise<RoundTwoResult> {
  if (policy.minimum_spend < 80 || policy.maximum_spend > 100 || policy.minimum_spend > policy.maximum_spend || policy.minimum_sellers < 3) {
    throw new Error("Round 2 budget policy must require 80–100 credits across at least three sellers.");
  }
  const discovered = await marketplace.discover();
  validateCatalogue(discovered);
  const available: ArenaProduct[] = [];
  for (const product of discovered) {
    if (state.state.purchasedProductIds.has(product.product_id)) continue;
    if (await marketplace.available(product)) available.push(product);
  }
  const remainingMinimum = Math.max(0, policy.minimum_spend - state.state.spentCredits);
  const remainingMaximum = policy.maximum_spend - state.state.spentCredits;
  const remainingSellers = Math.max(0, policy.minimum_sellers - state.state.purchasedSellerIds.size);
  const plan = remainingMinimum === 0 && remainingSellers === 0 ? [] : choosePlan(available, { ...policy, minimum_spend: remainingMinimum, maximum_spend: remainingMaximum, minimum_sellers: remainingSellers });
  const starting = await sharednet.balance();
  const initialTransfers = await sharednet.ledger(100);
  const unpaidTotal = plan.reduce((sum, product) => {
    const memo = `arena:purchase:${product.product_id}`;
    const alreadyPaid = initialTransfers.some((candidate) => outgoingMatch(candidate, starting.principal_id, product.seller.id, product.price_credits, memo, policy.room_id, policy.bind_payments_to_room));
    return sum + (alreadyPaid ? 0 : product.price_credits);
  }, 0);
  if (starting.balance < unpaidTotal) throw new Error("The official balance is below the planned Round 2 spend.");
  let expectedBalance = starting.balance;

  for (const product of plan) {
    assertDeadline(policy.deadline_at, policy.now);
    if (state.state.purchasedProductIds.has(product.product_id)) throw new Error("Duplicate product purchase denied.");
    if (policy.self_ids.has(product.seller.id)) throw new Error("Payment to DeliverCheck itself is denied.");
    const purchaseId = `purchase:${product.product_id}`;
    const memo = `arena:${purchaseId}`;
    await state.ledger.append({ kind: "purchase_intent", phase: state.state.phase, details: { purchase_id: purchaseId, product_id: product.product_id, target: product.seller.id, amount: product.price_credits, memo } });
    state.state.pendingPurchases.set(purchaseId, { product_id: product.product_id, target: product.seller.id, amount: product.price_credits, memo });

    const beforePayment = await sharednet.balance();
    let transfer = (await sharednet.ledger(100)).find((candidate) => outgoingMatch(candidate, starting.principal_id, product.seller.id, product.price_credits, memo, policy.room_id, policy.bind_payments_to_room));
    const recoveredTransfer = transfer !== undefined;
    if (transfer === undefined) {
      try {
        transfer = (await sharednet.pay({ target: product.seller.id, amount: product.price_credits, memo, bind_to_room: policy.bind_payments_to_room })).transfer;
      } catch (error) {
        transfer = (await sharednet.ledger(100)).find((candidate) => outgoingMatch(candidate, starting.principal_id, product.seller.id, product.price_credits, memo, policy.room_id, policy.bind_payments_to_room));
        if (transfer === undefined) throw error;
      }
    }
    const officialTransfer = (await sharednet.ledger(100)).find((candidate) => candidate.id === transfer!.id);
    if (officialTransfer === undefined || !outgoingMatch(officialTransfer, starting.principal_id, product.seller.id, product.price_credits, memo, policy.room_id, policy.bind_payments_to_room)) {
      throw new Error("The official outgoing transfer does not match its purchase intent.");
    }
    transfer = officialTransfer;
    if (state.state.consumedTransferIds.has(transfer.id)) throw new Error("Duplicate transfer use denied.");
    const after = await sharednet.balance();
    const expectedAfter = recoveredTransfer ? beforePayment.balance : beforePayment.balance - product.price_credits;
    if (after.balance !== expectedAfter) throw new Error("The official balance change does not match the confirmed transfer.");
    expectedBalance = after.balance;
    const execution = await marketplace.invoke(product, purchaseId);
    await state.ledger.append({ kind: "purchase_confirmed", phase: state.state.phase, details: { purchase_id: purchaseId, product_id: product.product_id, seller_id: product.seller.id, transfer_id: transfer.id, amount: product.price_credits, evidence_hash: jsonHash(execution.output) } });
    state.state.pendingPurchases.delete(purchaseId);
    state.state.purchasedProductIds.add(product.product_id);
    state.state.purchasedSellerIds.add(product.seller.id);
    state.state.consumedTransferIds.add(transfer.id);
    state.state.spentCredits += product.price_credits;
  }

  if (state.state.spentCredits < policy.minimum_spend || state.state.spentCredits > policy.maximum_spend || state.state.purchasedSellerIds.size < policy.minimum_sellers) {
    throw new Error("Round 2 completion invariants were not met.");
  }
  return { products: [...state.state.purchasedProductIds], sellers: [...state.state.purchasedSellerIds], spent_credits: state.state.spentCredits, starting_balance: starting.balance, ending_balance: expectedBalance };
}

export class SimulationRankingAdapter implements RankingAdapter {
  readonly method = "simulation-only";
  readonly idempotent = true as const;
  submitted: RankingEntry[] | null = null;

  async submit(entries: readonly RankingEntry[], _operationId: string): Promise<{ submission_id: string }> {
    this.submitted = structuredClone([...entries]);
    return { submission_id: "simulation-ranking-1" };
  }
}
