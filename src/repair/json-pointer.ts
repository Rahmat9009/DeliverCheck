import { UNSAFE_KEYS } from "./constants.js";
import type { JsonObject, JsonValue } from "../types.js";

/** Escapes one reference token per RFC 6901 (`~` -> `~0`, `/` -> `~1`). */
export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Decodes one reference token per RFC 6901. */
function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Builds an RFC 6901 pointer from raw (unescaped) key segments. */
export function toPointer(segments: readonly string[]): string {
  if (segments.length === 0) {
    return "";
  }
  return segments.map((segment) => `/${escapeToken(segment)}`).join("");
}

/** Splits an RFC 6901 pointer into raw (unescaped) key segments. */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON pointer: "${pointer}"`);
  }
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => unescapeToken(segment));
}

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the value at `pointer`, or `undefined` if any segment is absent. */
export function getAt(root: JsonValue, pointer: string): JsonValue | undefined {
  const segments = parsePointer(pointer);
  let current: JsonValue = root;
  for (const segment of segments) {
    if (isPlainObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment] as JsonValue;
    } else if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index] as JsonValue;
    } else {
      return undefined;
    }
  }
  return current;
}

/** True when every segment up to and including the leaf exists. */
export function hasAt(root: JsonValue, pointer: string): boolean {
  const segments = parsePointer(pointer);
  let current: JsonValue = root;
  for (const segment of segments) {
    if (isPlainObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment] as JsonValue;
    } else {
      return false;
    }
  }
  return true;
}

/** Sets the value at `pointer` in place. The parent object must already exist. */
export function setAt(root: JsonValue, pointer: string, value: JsonValue): void {
  const segments = parsePointer(pointer);
  if (segments.length === 0) {
    throw new Error("Cannot replace the document root in place.");
  }
  const unsafeSegment = segments.find((segment) => UNSAFE_KEYS.has(segment));
  if (unsafeSegment !== undefined) {
    throw new Error(`Cannot set "${pointer}": unsafe JSON pointer segment.`);
  }
  const parentPointer = toPointer(segments.slice(0, -1));
  const parent = getAt(root, parentPointer);
  const key = segments[segments.length - 1] as string;
  if (!isPlainObject(parent)) {
    throw new Error(`Cannot set "${pointer}": parent is not an object.`);
  }
  parent[key] = value;
}

/** Removes the value at `pointer` in place. No-op if it does not exist. */
export function removeAt(root: JsonValue, pointer: string): void {
  const segments = parsePointer(pointer);
  if (segments.length === 0) {
    throw new Error("Cannot remove the document root.");
  }
  const parentPointer = toPointer(segments.slice(0, -1));
  const parent = getAt(root, parentPointer);
  const key = segments[segments.length - 1] as string;
  if (isPlainObject(parent)) {
    delete parent[key];
  }
}

/**
 * Recursively scans `value` for reserved keys (`__proto__`, `constructor`,
 * `prototype`) and returns the JSON pointers where they were found. An empty
 * array means the document is safe to process.
 */
export function findUnsafeKeys(value: JsonValue, pointer = ""): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...findUnsafeKeys(item, `${pointer}/${index}`));
    });
    return found;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) {
        found.push(`${pointer}/${escapeToken(key)}`);
      }
      found.push(...findUnsafeKeys(value[key] as JsonValue, `${pointer}/${escapeToken(key)}`));
    }
  }
  return found;
}
