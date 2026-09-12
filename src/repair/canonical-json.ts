import type { JsonValue } from "../types.js";

/**
 * Serializes `value` per RFC 8785 (JSON Canonicalization Scheme) for the
 * subset of JSON that `JSON.parse` can ever produce: object keys are sorted
 * by UTF-16 code unit order, arrays keep source order, and numbers/strings
 * use `JSON.stringify`'s formatting, which already matches the ECMAScript
 * Number::toString and JSON string-escaping rules RFC 8785 requires. NaN and
 * Infinity are excluded by construction because they cannot appear in
 * parsed JSON.
 */
export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as JsonValue)}`);
  return `{${members.join(",")}}`;
}
