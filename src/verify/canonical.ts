import { createHash } from "node:crypto";

/**
 * Serializes a JSON-compatible value to an RFC 8785 canonical JSON string.
 *
 * Rules:
 * - Deterministic UTF-16 code unit sorting of object keys.
 * - No unnecessary whitespace.
 * - Standard JSON primitive representation.
 * - Rejects NaN, Infinity, undefined, functions, symbols, BigInt.
 * - Negative zero (-0) normalized to 0.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }

  const type = typeof value;

  if (type === "boolean") {
    return value ? "true" : "false";
  }

  if (type === "number") {
    const num = value as number;
    if (!Number.isFinite(num)) {
      throw new TypeError(`Cannot canonically serialize non-finite number: ${num}`);
    }
    // RFC 8785: -0 must be serialized as 0
    if (Object.is(num, -0) || num === 0) {
      return "0";
    }
    return JSON.stringify(num);
  }

  if (type === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const elements = value.map((item) => {
      if (item === undefined || typeof item === "symbol" || typeof item === "function") {
        return "null";
      }
      return canonicalJsonStringify(item);
    });
    return `[${elements.join(",")}]`;
  }

  if (type === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const entries: string[] = [];

    for (const key of keys) {
      const propVal = obj[key];
      if (propVal === undefined || typeof propVal === "symbol" || typeof propVal === "function") {
        continue;
      }
      entries.push(`${JSON.stringify(key)}:${canonicalJsonStringify(propVal)}`);
    }

    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`Unsupported type for canonical JSON serialization: ${type}`);
}

/**
 * Computes SHA-256 hash of raw UTF-8 text (e.g. source_text) formatted as `sha256:<hex>`.
 */
export function computeOriginalHash(sourceText: string): string {
  const hex = createHash("sha256").update(sourceText, "utf8").digest("hex");
  return `sha256:${hex}`;
}

/**
 * Computes SHA-256 hash of canonical RFC 8785 JSON representation formatted as `sha256:<hex>`.
 */
export function computeCanonicalHash(value: unknown): string {
  const canonical = canonicalJsonStringify(value);
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${hex}`;
}

/**
 * Validates whether a given hash matches the expected sha256:<64 hex> pattern.
 */
export function isValidHashFormat(hash: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(hash);
}
