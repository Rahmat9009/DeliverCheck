import { isPlainObject } from "./json-pointer.js";
import { validateCandidate } from "../verify/validate.js";
import type { JsonObject, JsonValue } from "../types.js";

function isSchemaObject(value: unknown): value is JsonObject {
  return isPlainObject(value);
}

/** True when `schema` describes a flat JSON object with a `properties` map. */
export function isFlatObjectSchema(schema: JsonObject): boolean {
  return schema["type"] === "object" && isPlainObject(schema["properties"]);
}

/**
 * Collects every property name reachable from `schema.properties`, recursing
 * into nested object subschemas up to `maxDepth` levels. Used only to give
 * the rule parser field names it can match against rule text (e.g. tying a
 * "leading zeros" sentence to the field it describes) — it never drives
 * repair of nested objects, which this checkpoint does not attempt.
 */
export function collectFieldNames(schema: JsonObject, maxDepth = 4): string[] {
  const names = new Set<string>();

  function visit(node: JsonObject, depth: number): void {
    const properties = node["properties"];
    if (!isPlainObject(properties) || depth > maxDepth) {
      return;
    }
    for (const [key, subschema] of Object.entries(properties)) {
      names.add(key);
      if (isSchemaObject(subschema)) {
        visit(subschema, depth + 1);
      }
    }
  }

  visit(schema, 0);
  return [...names];
}

function wrapperSchemaFor(
  key: string,
  subschema: JsonValue,
  required: boolean,
  rootSchema?: JsonObject,
): JsonObject {
  return {
    type: "object",
    additionalProperties: true,
    properties: { [key]: subschema },
    ...(required ? { required: [key] } : {}),
    ...(rootSchema?.["$defs"] === undefined
      ? {}
      : { $defs: structuredClone(rootSchema["$defs"]) }),
    ...(rootSchema?.["definitions"] === undefined
      ? {}
      : { definitions: structuredClone(rootSchema["definitions"]) }),
  };
}

/**
 * Validates a single field's current value against its subschema by
 * wrapping it in a minimal object schema and delegating to the frozen
 * `validateCandidate`. Keeps this module's schema semantics identical to
 * `src/verify/validate.ts` instead of re-implementing JSON Schema checks.
 *
 * Root `$defs` and `definitions` are retained so local references have the
 * same meaning during field-level and whole-document validation.
 */
export function fieldIsValid(
  key: string,
  value: JsonValue,
  subschema: JsonValue,
  required: boolean,
  rootSchema?: JsonObject,
): boolean {
  return validateCandidate(
    { [key]: value },
    wrapperSchemaFor(key, subschema, required, rootSchema),
  ).valid;
}

/** True when a field's validation failure came from a target schema ajv could not compile. */
export function fieldSchemaCompileFailed(
  key: string,
  value: JsonValue,
  subschema: JsonValue,
  required: boolean,
  rootSchema?: JsonObject,
): boolean {
  const result = validateCandidate(
    { [key]: value },
    wrapperSchemaFor(key, subschema, required, rootSchema),
  );
  return result.errors.some((error) => error.keyword === "invalid_target_schema");
}

/** Joins ajv error messages for a single field's validation failure into one human-readable string. */
export function fieldValidationErrors(
  key: string,
  value: JsonValue,
  subschema: JsonValue,
  required: boolean,
  rootSchema?: JsonObject,
): string {
  const result = validateCandidate(
    { [key]: value },
    wrapperSchemaFor(key, subschema, required, rootSchema),
  );
  const messages = result.errors.map((error) => `${error.instance_path || `/${key}`}: ${error.message}`);
  return messages.length > 0 ? messages.join("; ") : "Schema validation failed.";
}

/** Matches an exact `^[0-9]{N}$` pattern and returns `N`, or `null` otherwise. */
export function fixedDigitPatternLength(subschema: JsonValue): number | null {
  if (!isPlainObject(subschema) || subschema["type"] !== "string") {
    return null;
  }
  const pattern = subschema["pattern"];
  if (typeof pattern !== "string") {
    return null;
  }
  const match = /^\^\[0-9\]\{(\d+)\}\$$/.exec(pattern);
  return match ? Number(match[1]) : null;
}

/** Returns the subschema's `enum` values as strings, or `null` if it has none / they are not all strings. */
export function stringEnumValues(subschema: JsonValue): string[] | null {
  if (!isPlainObject(subschema)) {
    return null;
  }
  const values = subschema["enum"];
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  return values.every((value): value is string => typeof value === "string") ? (values as string[]) : null;
}
