import type { CreditTransfer, SharedNetAdapter, SharedNetMessage } from "./types.js";
import { withTimeout } from "./resilience.js";

export const DEFAULT_LEDGER_PAGE_LIMIT = 20;
export const DEFAULT_MESSAGE_PAGE_LIMIT = 20;

export async function scanLedger(
  sharednet: SharedNetAdapter,
  predicate: (transfer: CreditTransfer) => boolean,
  options: { not_before?: string; max_pages?: number; timeout_ms?: number; stop_after_first?: boolean } = {},
): Promise<{ matches: CreditTransfer[]; pages: number; exhausted: boolean }> {
  const maxPages = options.max_pages ?? DEFAULT_LEDGER_PAGE_LIMIT;
  const timeout = options.timeout_ms ?? 30_000;
  const boundary = options.not_before === undefined ? Number.NEGATIVE_INFINITY : Date.parse(options.not_before);
  const matches: CreditTransfer[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  for (let page = 1; page <= maxPages; page += 1) {
    const items = await withTimeout(sharednet.ledger(100, before), timeout, "ledger_timeout");
    for (const item of items) {
      if (!seen.has(item.id) && predicate(item)) {
        matches.push(item);
        if (options.stop_after_first) return { matches, pages: page, exhausted: false };
      }
      seen.add(item.id);
    }
    if (items.length < 100) return { matches, pages: page, exhausted: true };
    const oldest = items.at(-1)!;
    if (Number.isFinite(boundary) && Date.parse(oldest.created_at) < boundary) return { matches, pages: page, exhausted: true };
    if (before === oldest.id) break;
    before = oldest.id;
  }
  return { matches, pages: maxPages, exhausted: false };
}

export async function readMessagesPaginated(
  sharednet: SharedNetAdapter,
  after: number,
  options: { max_pages?: number; timeout_ms?: number } = {},
): Promise<{ items: SharedNetMessage[]; cursor: number; truncated: boolean }> {
  const maxPages = options.max_pages ?? DEFAULT_MESSAGE_PAGE_LIMIT;
  const timeout = options.timeout_ms ?? 30_000;
  const found: SharedNetMessage[] = [];
  const ids = new Set<string>();
  let cursor = after;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await withTimeout(sharednet.read(cursor, 100), timeout, "sharednet_read_timeout");
    const ordered = [...response.items].filter((item) => item.sequence > cursor).sort((left, right) => left.sequence - right.sequence);
    for (const message of ordered) {
      if (!ids.has(message.id)) found.push(message);
      ids.add(message.id);
      cursor = Math.max(cursor, message.sequence);
    }
    if (ordered.length < 100 && !response.has_more) return { items: found, cursor, truncated: false };
    if (ordered.length === 0) return { items: found, cursor, truncated: response.has_more };
  }
  return { items: found, cursor, truncated: true };
}
