import { computeCanonicalHash } from "../verify/canonical.js";
import { validateRequestContract } from "../verify/validate.js";
import type { ParsedServiceRequest, SharedNetMessage } from "./types.js";

const MAX_MESSAGE_BYTES = 32_768;

export type MessageParseResult =
  | { accepted: true; value: ParsedServiceRequest; request_hash: string }
  | { accepted: false; code: "not_delivercheck_request" | "malformed_request" | "oversized_message" };

function candidateFromStructured(value: unknown): Omit<ParsedServiceRequest, "syntax"> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record["type"] !== "delivercheck.request" || record["version"] !== 1) return null;
  if (record["service"] !== "diagnose" && record["service"] !== "repair") return null;
  return { service: record["service"], request: record["request"] as never };
}

export function parseServiceRequest(message: SharedNetMessage): MessageParseResult {
  if (Buffer.byteLength(message.content, "utf8") > MAX_MESSAGE_BYTES) return { accepted: false, code: "oversized_message" };

  let candidate: Omit<ParsedServiceRequest, "syntax"> | null = null;
  let syntax: ParsedServiceRequest["syntax"] = "structured";
  try {
    candidate = candidateFromStructured(JSON.parse(message.content) as unknown);
  } catch {
    // Natural-language parsing below is deliberately prefix-bounded.
  }

  if (candidate === null) {
    const match = /^DeliverCheck\s+(diagnose|repair)\s*:\s*(\{[\s\S]*\})\s*$/i.exec(message.content);
    if (match === null) {
      return /^DeliverCheck\s+(?:diagnose|repair)\s*:/i.test(message.content)
        ? { accepted: false, code: "malformed_request" }
        : { accepted: false, code: "not_delivercheck_request" };
    }
    syntax = "natural_language";
    try {
      candidate = { service: match[1]!.toLowerCase() as "diagnose" | "repair", request: JSON.parse(match[2]!) as never };
    } catch {
      return { accepted: false, code: "malformed_request" };
    }
  }

  const validated = validateRequestContract(candidate.request);
  if (!validated.valid) return { accepted: false, code: "malformed_request" };
  const value: ParsedServiceRequest = { service: candidate.service, request: structuredClone(validated.value), syntax };
  return { accepted: true, value, request_hash: computeCanonicalHash(value.request) };
}

export function productPresentation(): string {
  return [
    "DeliverCheck — Make one agent’s output usable by the next.",
    "diagnose: 0 Arena credits; validates bounded top-level JSON without modification.",
    "repair: 7 Arena credits; SharedOS-authorized repair followed by independent verification.",
    "Limits: JSON only, 64 KiB request, no factual-truth proof. Billing is verified externally from the SharedNet ledger.",
  ].join("\n");
}
