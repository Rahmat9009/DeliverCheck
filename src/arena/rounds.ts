import { computeCanonicalHash } from "../verify/canonical.js";
import { identityMatchesKind } from "./config.js";
import { scanLedger } from "./pagination.js";
import { ArenaOperationalError, withTimeout } from "./resilience.js";
import type { ArenaStateController } from "./state.js";
import type { ArenaProduct, CreditBalance, CreditTransfer, ProductEvaluation, ProductExecution, ProductMarketplace, RankingAdapter, RankingEntry, SharedNetAdapter } from "./types.js";

export interface RoundOneResult { evaluations: ProductEvaluation[]; ranking: RankingEntry[]; submission_id: string }
export interface RoundTwoResult { products: string[]; sellers: string[]; spent_credits: number; starting_balance: number; ending_balance: number }
export interface RoundTwoPolicy {
  minimum_spend: number; maximum_spend: number; minimum_sellers: number; room_id: string;
  bind_payments_to_room: boolean; self_ids: ReadonlySet<string>; deadline_at?: number; now?: () => number;
  ledger_timeout_ms?: number; discovery_timeout_ms?: number; invocation_timeout_ms?: number;
  purchase_memo_prefix?: string; after_external_action?: () => Promise<void>;
}
export interface RoundOneOptions {
  deadline_at?: number; now?: () => number; self_ids?: ReadonlySet<string>; timeout_ms?: number;
  discovery_timeout_ms?: number; after_external_action?: () => Promise<void>;
}

const OPERATION_MARGIN_MS = 240_000;
const MAX_CATALOGUE_ITEMS = 500;
const MAX_PRODUCT_JSON_BYTES = 64 * 1024;

function assertDeadline(deadlineAt: number | undefined, now: (() => number) | undefined): void {
  if (deadlineAt !== undefined && (now ?? Date.now)() + OPERATION_MARGIN_MS >= deadlineAt) throw new ArenaOperationalError("configuration", "deadline_margin", "The Arena deadline safety margin has been reached.");
}

function jsonHash(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text, "utf8") > 256 * 1024) throw new Error("Product evidence is not bounded JSON.");
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

export function canonicalSellerPrincipal(product: ArenaProduct): string {
  if (product.seller.kind === "principal") return product.seller.id;
  if (typeof product.seller_principal_id === "string" && identityMatchesKind("principal", product.seller_principal_id)) return product.seller_principal_id;
  throw new Error("The product lacks a verified canonical seller Principal mapping.");
}

function paymentRecipient(product: ArenaProduct): { target: string; principal: string } {
  const principal = canonicalSellerPrincipal(product);
  if (product.seller.kind === "principal" && product.payment_recipient === undefined) return { target: principal, principal };
  const recipient = product.payment_recipient;
  if (recipient?.organizer_confirmed !== true || recipient.mapping_verified !== true || recipient.principal_id !== principal || !identityMatchesKind(recipient.kind, recipient.id)) throw new Error("The product payment recipient lacks a verified mapping to its canonical Principal.");
  return { target: recipient.id, principal };
}

function validateProduct(value: unknown): { accepted: true; product: ArenaProduct } | { accepted: false; reason: string; product_id: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { accepted: false, reason: "not_an_object", product_id: "unknown" };
  const product = value as Partial<ArenaProduct>;
  const productId = typeof product.product_id === "string" ? product.product_id : "unknown";
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_PRODUCT_JSON_BYTES) throw new Error("metadata_limit");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(productId)) throw new Error("invalid_product_id");
    if (typeof product.name !== "string" || !product.name.trim() || product.name.length > 160) throw new Error("invalid_name");
    if (typeof product.useful_purpose !== "string" || !product.useful_purpose.trim() || product.useful_purpose.length > 500) throw new Error("invalid_purpose");
    if (!Number.isSafeInteger(product.price_credits) || (product.price_credits ?? 0) < 1 || (product.price_credits ?? 0) > 100) throw new Error("invalid_price");
    if (product.seller?.organizer_confirmed !== true || !identityMatchesKind(product.seller.kind, product.seller.id)) throw new Error("invalid_seller_identity");
    canonicalSellerPrincipal(product as ArenaProduct);
    paymentRecipient(product as ArenaProduct);
    if (product.endpoint !== undefined) {
      if (product.endpoint.length > 2_048) throw new Error("endpoint_limit");
      const endpoint = new URL(product.endpoint);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("unsafe_endpoint");
    }
    if (product.assertion !== undefined) {
      if (!Array.isArray(product.assertion.path) || product.assertion.path.length === 0 || product.assertion.path.length > 16 || product.assertion.path.some((segment) => typeof segment !== "string" || !segment || segment.length > 128)) throw new Error("invalid_probe_profile");
      jsonHash(product.assertion.equals);
    }
    if (product.probe_input !== undefined) jsonHash(product.probe_input);
    return { accepted: true, product: structuredClone(product as ArenaProduct) };
  } catch (error) {
    return { accepted: false, reason: error instanceof Error ? error.message : "invalid_listing", product_id: productId };
  }
}

async function catalogue(state: ArenaStateController, marketplace: ProductMarketplace, timeoutMs: number): Promise<ArenaProduct[]> {
  await state.ledger.append({ kind: "marketplace_discovery_intent", phase: state.state.phase, details: { adapter: marketplace.adapter_id ?? "unspecified", item_limit: MAX_CATALOGUE_ITEMS } });
  const raw = await withTimeout(marketplace.discover(), timeoutMs, "marketplace_discovery_timeout");
  if (!Array.isArray(raw)) throw new ArenaOperationalError("integrity", "invalid_catalogue", "The marketplace catalogue is not an array.");
  const valid: ArenaProduct[] = [];
  const ids = new Set<string>();
  for (const value of raw.slice(0, MAX_CATALOGUE_ITEMS)) {
    const checked = validateProduct(value);
    if (!checked.accepted) {
      await state.ledger.append({ kind: "catalogue_item_skipped", phase: state.state.phase, details: { product_id: checked.product_id, reason: checked.reason } });
      continue;
    }
    if (ids.has(checked.product.product_id)) {
      await state.ledger.append({ kind: "catalogue_item_skipped", phase: state.state.phase, details: { product_id: checked.product.product_id, reason: "duplicate_product_id" } });
      continue;
    }
    ids.add(checked.product.product_id);
    valid.push(checked.product);
  }
  if (raw.length > MAX_CATALOGUE_ITEMS) await state.ledger.append({ kind: "catalogue_truncated", phase: state.state.phase, details: { received: raw.length, accepted_limit: MAX_CATALOGUE_ITEMS } });
  await state.ledger.append({ kind: "marketplace_discovery_observed", phase: state.state.phase, details: { received: raw.length, accepted: valid.length } });
  return valid;
}

function evaluate(product: ArenaProduct, execution: ProductExecution, marketplace: ProductMarketplace): ProductEvaluation | null {
  const custom = marketplace.critique?.(product, execution);
  if (custom !== undefined) {
    if (custom === null) return null;
    if (!custom.disagreement.trim() || custom.disagreement.length > 1_000 || !Number.isFinite(custom.score)) throw new Error("The configured critique strategy returned invalid bounded evidence.");
    return { ...custom, product_id: product.product_id, seller_id: canonicalSellerPrincipal(product), evidence_hash: jsonHash(execution.output), latency_ms: execution.latency_ms };
  }
  if (product.assertion === undefined) {
    if (execution.protocol_ok && execution.evidence_provided) return null;
    return { product_id: product.product_id, seller_id: canonicalSellerPrincipal(product), evidence_hash: jsonHash(execution.output), disagreement: `Actual invocation lacked ${execution.protocol_ok ? "the advertised evidence" : "a protocol-compatible response"}.`, score: execution.protocol_ok ? 40 : 0, latency_ms: execution.latency_ms };
  }
  const observed = valueAt(execution.output, product.assertion.path);
  if (jsonHash(observed ?? null) === jsonHash(product.assertion.equals)) return null;
  const score = (execution.protocol_ok ? 40 : 0) + (execution.evidence_provided ? 30 : 0) + (execution.output !== null && typeof execution.output === "object" ? 20 : 0) + Math.max(0, 10 - Math.floor(execution.latency_ms / 100));
  return { product_id: product.product_id, seller_id: canonicalSellerPrincipal(product), evidence_hash: jsonHash(execution.output), disagreement: `${product.assertion.description}; expected ${compact(product.assertion.equals)} at /${product.assertion.path.join("/")}, observed ${compact(observed)}.`, score, latency_ms: execution.latency_ms };
}

export async function runRoundOne(state: ArenaStateController, marketplace: ProductMarketplace, rankingAdapter: RankingAdapter, options: RoundOneOptions = {}): Promise<RoundOneResult> {
  const products = await catalogue(state, marketplace, options.discovery_timeout_ms ?? 30_000);
  const evaluations = [...state.state.evaluations.values()];
  const sellerIds = new Set(evaluations.map((entry) => entry.seller_id));
  for (const product of products) {
    if (evaluations.length >= 3) break;
    const seller = canonicalSellerPrincipal(product);
    const identities = [product.seller.id, seller, product.payment_recipient?.id].filter((value): value is string => value !== undefined);
    if (identities.some((id) => options.self_ids?.has(id)) || sellerIds.has(seller) || state.state.evaluatedProductIds.has(product.product_id)) continue;
    let available: boolean;
    await state.ledger.append({ kind: "product_availability_intent", phase: state.state.phase, details: { product_id: product.product_id, round: 1 } });
    try { available = await withTimeout(marketplace.available(product), options.timeout_ms ?? 60_000, "product_availability_timeout"); }
    catch { await state.ledger.append({ kind: "round1_product_skipped", phase: state.state.phase, details: { product_id: product.product_id, reason: "availability_failure" } }); continue; }
    if (!available) continue;
    await state.ledger.append({ kind: "product_availability_observed", phase: state.state.phase, details: { product_id: product.product_id, available: true, round: 1 } });
    assertDeadline(options.deadline_at, options.now);
    const operationId = `round1:${product.product_id}`;
    await state.ledger.append({ kind: "round1_invocation_intent", phase: state.state.phase, details: { product_id: product.product_id, seller_id: seller, operation_id: operationId } });
    let result: ProductEvaluation | null;
    try {
      const execution = await withTimeout(marketplace.invoke(product, operationId), options.timeout_ms ?? 60_000, "product_invocation_timeout");
      result = evaluate(product, execution, marketplace);
      await state.ledger.append({ kind: "round1_invocation_observed", phase: state.state.phase, details: { product_id: product.product_id, evidence_hash: jsonHash(execution.output), latency_ms: execution.latency_ms } });
    } catch (error) {
      const code = error instanceof ArenaOperationalError ? error.code : "product_invocation_failed";
      result = { product_id: product.product_id, seller_id: seller, evidence_hash: jsonHash({ outcome: "failed", code }), disagreement: `Actual invocation failed with bounded outcome ${code}; the advertised service did not return a usable result.`, score: 0, latency_ms: options.timeout_ms ?? 60_000 };
      await state.ledger.append({ kind: "round1_invocation_failed", phase: state.state.phase, details: { product_id: product.product_id, reason: code } });
    }
    await options.after_external_action?.();
    if (result === null) { await state.ledger.append({ kind: "round1_no_disagreement", phase: state.state.phase, details: { product_id: product.product_id } }); continue; }
    evaluations.push(result); sellerIds.add(seller);
    await state.ledger.append({ kind: "round1_evaluated", phase: state.state.phase, details: { product_id: result.product_id, seller_id: result.seller_id, evidence_hash: result.evidence_hash, disagreement: result.disagreement, score: result.score, latency_ms: result.latency_ms } });
    state.state.evaluatedProductIds.add(result.product_id); state.state.evaluations.set(result.product_id, result);
  }
  if (evaluations.length < 3 || sellerIds.size < 3) throw new ArenaOperationalError("transient", "round1_insufficient_products", "Round 1 requires three attempted products from distinct canonical sellers with one specific disagreement each.");
  const ranking = [...evaluations].sort((left, right) => right.score - left.score || left.latency_ms - right.latency_ms || left.product_id.localeCompare(right.product_id)).map((entry, index) => ({ rank: index + 1, product_id: entry.product_id, score: entry.score, reason: `Actual invocation evidence ${entry.evidence_hash}; disagreement: ${entry.disagreement}` }));
  if (!state.state.rankingPrepared) { await state.ledger.append({ kind: "ranking_prepared", phase: state.state.phase, details: { products: ranking.length, ranking_hash: jsonHash(ranking), method: rankingAdapter.method } }); state.state.rankingPrepared = true; }
  if (state.state.rankingSubmitted && state.state.rankingSubmissionId !== null) return { evaluations, ranking, submission_id: state.state.rankingSubmissionId };
  assertDeadline(options.deadline_at, options.now);
  await state.ledger.append({ kind: "ranking_submission_intent", phase: state.state.phase, details: { operation_id: "round1-ranking", ranking_hash: jsonHash(ranking), method: rankingAdapter.method } });
  const submitted = await withTimeout(rankingAdapter.submit(ranking, "round1-ranking"), options.timeout_ms ?? 60_000, "ranking_timeout");
  await state.ledger.append({ kind: "ranking_submitted", phase: state.state.phase, details: { submission_id: submitted.submission_id, method: rankingAdapter.method } });
  state.state.rankingSubmitted = true; state.state.rankingSubmissionId = submitted.submission_id;
  await options.after_external_action?.();
  return { evaluations, ranking, submission_id: submitted.submission_id };
}

function validPrice(product: ArenaProduct): boolean { return Number.isSafeInteger(product.price_credits) && product.price_credits >= 1 && product.price_credits <= 100 && product.useful_purpose.trim().length > 0; }
function isSelf(product: ArenaProduct, selfIds: ReadonlySet<string>): boolean { return [product.seller.id, canonicalSellerPrincipal(product), product.payment_recipient?.id].some((id) => id !== undefined && selfIds.has(id)); }

function choosePlan(products: readonly ArenaProduct[], policy: RoundTwoPolicy): ArenaProduct[] {
  const usable = products.filter(validPrice).filter((product) => !isSelf(product, policy.self_ids)).sort((a, b) => a.product_id.localeCompare(b.product_id));
  let best: ArenaProduct[] | null = null;
  const search = (index: number, selected: ArenaProduct[], total: number, sellers: Set<string>): void => {
    if (total > policy.maximum_spend) return;
    if (total >= policy.minimum_spend && sellers.size >= policy.minimum_sellers) {
      const bestTotal = best?.reduce((sum, item) => sum + item.price_credits, 0) ?? Number.POSITIVE_INFINITY;
      if (total < bestTotal || (total === bestTotal && selected.length < (best?.length ?? Number.POSITIVE_INFINITY))) best = [...selected];
      return;
    }
    for (let cursor = index; cursor < usable.length; cursor += 1) {
      const product = usable[cursor]!; const seller = canonicalSellerPrincipal(product);
      if (sellers.has(seller)) continue;
      selected.push(product); sellers.add(seller); search(cursor + 1, selected, total + product.price_credits, sellers); sellers.delete(seller); selected.pop();
    }
  };
  search(0, [], 0, new Set());
  if (best === null) throw new ArenaOperationalError("transient", "purchase_plan_unavailable", "No useful three-seller purchase plan satisfies the configured 80–100 credit budget.");
  return best;
}

function outgoingMatch(transfer: CreditTransfer, principalId: string, recipient: { target: string; principal: string }, amount: number, memo: string, roomId: string, bindRoom: boolean): boolean {
  return transfer.from_principal_id === principalId && transfer.to_principal_id === recipient.principal && transfer.addressed_to === recipient.target && transfer.amount === amount && transfer.memo === memo && (!bindRoom || transfer.room_id === roomId);
}

async function findOutgoing(sharednet: SharedNetAdapter, predicate: (transfer: CreditTransfer) => boolean, timeout: number, stopAfterFirst = false): Promise<CreditTransfer[]> { return (await scanLedger(sharednet, predicate, { timeout_ms: timeout, stop_after_first: stopAfterFirst })).matches; }

async function recordSettled(state: ArenaStateController, input: { purchaseId: string; product: ArenaProduct; transfer: CreditTransfer }): Promise<void> {
  if (state.state.purchasedProductIds.has(input.product.product_id)) return;
  const seller = canonicalSellerPrincipal(input.product);
  await state.ledger.append({ kind: "purchase_payment_verified", phase: state.state.phase, details: { purchase_id: input.purchaseId, product_id: input.product.product_id, seller_id: seller, transfer_id: input.transfer.id, amount: input.product.price_credits } });
  state.state.purchasedProductIds.add(input.product.product_id); state.state.purchasedSellerIds.add(seller); state.state.consumedTransferIds.add(input.transfer.id); state.state.spentCredits += input.product.price_credits;
  const pending = state.state.pendingPurchases.get(input.purchaseId); if (pending) pending.transfer_id = input.transfer.id;
}

async function invokePurchased(state: ArenaStateController, marketplace: ProductMarketplace, product: ArenaProduct, purchaseId: string, timeout: number, after?: () => Promise<void>): Promise<void> {
  await state.ledger.append({ kind: "purchase_invocation_intent", phase: state.state.phase, details: { purchase_id: purchaseId, product_id: product.product_id } });
  try {
    const execution = await withTimeout(marketplace.invoke(product, purchaseId), timeout, "product_invocation_timeout");
    await state.ledger.append({ kind: "purchase_confirmed", phase: state.state.phase, details: { purchase_id: purchaseId, product_id: product.product_id, seller_id: canonicalSellerPrincipal(product), evidence_hash: jsonHash(execution.output) } });
  } catch (error) {
    const code = error instanceof ArenaOperationalError ? error.code : "product_invocation_failed";
    await state.ledger.append({ kind: "purchase_invocation_failed", phase: state.state.phase, details: { purchase_id: purchaseId, product_id: product.product_id, reason: code } });
  }
  state.state.pendingPurchases.delete(purchaseId); await after?.();
}

export async function runRoundTwo(state: ArenaStateController, sharednet: SharedNetAdapter, marketplace: ProductMarketplace, policy: RoundTwoPolicy): Promise<RoundTwoResult> {
  if (policy.minimum_spend < 80 || policy.maximum_spend > 100 || policy.minimum_spend > policy.maximum_spend || policy.minimum_sellers < 3) throw new ArenaOperationalError("configuration", "invalid_budget", "Round 2 budget policy must require 80–100 credits across at least three sellers.");
  const products = await catalogue(state, marketplace, policy.discovery_timeout_ms ?? 30_000);
  const byId = new Map(products.map((product) => [product.product_id, product]));
  for (const [purchaseId, pending] of [...state.state.pendingPurchases]) {
    if (!pending.transfer_id) continue;
    const product = byId.get(pending.product_id);
    if (product === undefined) { await state.ledger.append({ kind: "purchase_invocation_failed", phase: state.state.phase, details: { purchase_id: purchaseId, product_id: pending.product_id, reason: "product_missing_after_restart" } }); state.state.pendingPurchases.delete(purchaseId); continue; }
    await invokePurchased(state, marketplace, product, purchaseId, policy.invocation_timeout_ms ?? 60_000, policy.after_external_action);
  }
  const available: ArenaProduct[] = [];
  for (const product of products) {
    if (state.state.purchasedProductIds.has(product.product_id) || state.state.purchasedSellerIds.has(canonicalSellerPrincipal(product)) || isSelf(product, policy.self_ids)) continue;
    await state.ledger.append({ kind: "product_availability_intent", phase: state.state.phase, details: { product_id: product.product_id, round: 2 } });
    try { if (await withTimeout(marketplace.available(product), policy.invocation_timeout_ms ?? 60_000, "product_availability_timeout")) { available.push(product); await state.ledger.append({ kind: "product_availability_observed", phase: state.state.phase, details: { product_id: product.product_id, available: true, round: 2 } }); } }
    catch { await state.ledger.append({ kind: "market_product_skipped", phase: state.state.phase, details: { product_id: product.product_id, reason: "availability_failure" } }); }
  }
  const remainingMinimum = Math.max(0, policy.minimum_spend - state.state.spentCredits);
  const remainingMaximum = policy.maximum_spend - state.state.spentCredits;
  const remainingSellers = Math.max(0, policy.minimum_sellers - state.state.purchasedSellerIds.size);
  const plan = remainingMinimum === 0 && remainingSellers === 0 ? [] : choosePlan(available, { ...policy, minimum_spend: remainingMinimum, maximum_spend: remainingMaximum, minimum_sellers: remainingSellers });
  const starting = await withTimeout(sharednet.balance(), policy.ledger_timeout_ms ?? 30_000, "balance_timeout");
  if (starting.balance < plan.reduce((sum, product) => sum + product.price_credits, 0)) throw new ArenaOperationalError("integrity", "insufficient_balance", "The official balance is below the planned Round 2 spend.");
  let ending: CreditBalance = starting;
  for (const product of plan) {
    assertDeadline(policy.deadline_at, policy.now);
    if (isSelf(product, policy.self_ids)) throw new ArenaOperationalError("integrity", "self_payment", "Payment to a DeliverCheck identity is denied.");
    const recipient = paymentRecipient(product); const purchaseId = `purchase:${product.product_id}`; const memo = `${policy.purchase_memo_prefix ?? "arena:purchase:"}${product.product_id}`;
    if (!state.state.pendingPurchases.has(purchaseId)) {
      await state.ledger.append({ kind: "purchase_intent", phase: state.state.phase, details: { purchase_id: purchaseId, product_id: product.product_id, target: recipient.target, seller_id: recipient.principal, amount: product.price_credits, memo } });
      state.state.pendingPurchases.set(purchaseId, { product_id: product.product_id, target: recipient.target, seller_id: recipient.principal, amount: product.price_credits, memo });
    }
    const predicate = (candidate: CreditTransfer) => outgoingMatch(candidate, starting.principal_id, recipient, product.price_credits, memo, policy.room_id, policy.bind_payments_to_room);
    let matches = await findOutgoing(sharednet, predicate, policy.ledger_timeout_ms ?? 30_000);
    if (matches.length > 1) throw new ArenaOperationalError("integrity", "duplicate_outgoing_transfers", "More than one official outgoing transfer matches one purchase intent.");
    let transfer = matches.sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at) || left.id.localeCompare(right.id))[0];
    const before = await withTimeout(sharednet.balance(), policy.ledger_timeout_ms ?? 30_000, "balance_timeout");
    if (transfer === undefined) {
      const pending = state.state.pendingPurchases.get(purchaseId)!;
      if (pending.payment_attempted) {
        await state.ledger.append({ kind: "purchase_payment_pending", phase: state.state.phase, details: { purchase_id: purchaseId, reason: "previous_attempt_not_yet_observed" } });
        continue;
      }
      await state.ledger.append({ kind: "purchase_payment_attempt", phase: state.state.phase, details: { purchase_id: purchaseId, amount: product.price_credits, target: recipient.target } });
      pending.payment_attempted = true;
      try {
        const attempted = await withTimeout(sharednet.pay({ target: recipient.target, amount: product.price_credits, memo, bind_to_room: policy.bind_payments_to_room }), policy.ledger_timeout_ms ?? 30_000, "payment_timeout");
        matches = await findOutgoing(sharednet, (candidate) => candidate.id === attempted.transfer.id && predicate(candidate), policy.ledger_timeout_ms ?? 30_000, true); transfer = matches[0];
      } catch {
        matches = await findOutgoing(sharednet, predicate, policy.ledger_timeout_ms ?? 30_000);
        if (matches.length > 1) throw new ArenaOperationalError("integrity", "duplicate_outgoing_transfers", "More than one official outgoing transfer matches one purchase intent.");
        transfer = matches.sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at) || left.id.localeCompare(right.id))[0];
      }
    }
    if (transfer === undefined) { await state.ledger.append({ kind: "purchase_payment_pending", phase: state.state.phase, details: { purchase_id: purchaseId, reason: "official_transfer_not_observed" } }); continue; }
    if (state.state.consumedTransferIds.has(transfer.id)) throw new ArenaOperationalError("integrity", "duplicate_transfer", "Duplicate transfer use is denied.");
    await recordSettled(state, { purchaseId, product, transfer });
    ending = await withTimeout(sharednet.balance(), policy.ledger_timeout_ms ?? 30_000, "balance_timeout"); const sentDelta = ending.sent - before.sent;
    await state.ledger.append({ kind: "balance_consistency_observed", phase: state.state.phase, details: { purchase_id: purchaseId, sent_delta: sentDelta, expected_amount: product.price_credits, consistent: sentDelta === 0 || sentDelta >= product.price_credits } });
    await policy.after_external_action?.();
    await invokePurchased(state, marketplace, product, purchaseId, policy.invocation_timeout_ms ?? 60_000, policy.after_external_action);
  }
  if (state.state.spentCredits < policy.minimum_spend || state.state.spentCredits > policy.maximum_spend || state.state.purchasedSellerIds.size < policy.minimum_sellers) throw new ArenaOperationalError("transient", "round2_incomplete", "Round 2 completion invariants are not yet met.");
  return { products: [...state.state.purchasedProductIds], sellers: [...state.state.purchasedSellerIds], spent_credits: state.state.spentCredits, starting_balance: starting.balance, ending_balance: ending.balance };
}

export class SimulationRankingAdapter implements RankingAdapter {
  readonly method = "simulation-only"; readonly idempotent = true as const; submitted: RankingEntry[] | null = null; submissions = 0;
  async submit(entries: readonly RankingEntry[], _operationId: string): Promise<{ submission_id: string }> { this.submissions += 1; this.submitted = structuredClone([...entries]); return { submission_id: "simulation-ranking-1" }; }
}
