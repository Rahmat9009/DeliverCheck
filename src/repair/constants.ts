/**
 * Reserved object keys that must never be accepted from source JSON or rule
 * targets. JSON.parse in modern V8 stores these as ordinary own properties,
 * but downstream merges/spreads elsewhere in a caller's stack could still
 * turn them into a prototype-pollution vector, so the repair engine refuses
 * to touch any object carrying them.
 */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Upper bound on the number of change operations one repair run may record. */
export const MAX_CHANGE_OPERATIONS = 25;

/** Upper bound on the number of explicit rules one repair run will parse. */
export const MAX_EXPLICIT_RULES = 200;

/** Reported in every result; mirrors the checkpoint-1 package version. */
export const IMPLEMENTATION_VERSION = "0.1.0";
