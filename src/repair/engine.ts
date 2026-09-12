import { analyzeSlashDate, isAmbiguousCommaNumber, looksLikeCurrencySymbol, resolveCommaNumber, resolveSlashDateToIso } from "./ambiguity.js";
import { IMPLEMENTATION_VERSION, MAX_CHANGE_OPERATIONS, MAX_EXPLICIT_RULES, UNSAFE_KEYS } from "./constants.js";
import { hashJsonValue, hashText } from "./hashing.js";
import { escapeToken, findUnsafeKeys, getAt, hasAt, isPlainObject, parsePointer, removeAt, setAt } from "./json-pointer.js";
import { parseExplicitRules } from "./rules.js";
import type {
  ConstantRequirementDirective,
  Directive,
  IdentifierPreserveDirective,
} from "./rules.js";
import {
  collectFieldNames,
  fieldIsValid,
  fieldSchemaCompileFailed,
  fieldValidationErrors,
  fixedDigitPatternLength,
  isFlatObjectSchema,
  stringEnumValues,
} from "./schema-utils.js";
import { validateCandidate } from "../verify/validate.js";
import type {
  CannotRepairCode,
  CannotRepairResult,
  ChangeEvidence,
  DeliverCheckRequest,
  DeliverCheckResult,
  JsonObject,
  JsonValue,
  NeedsInformationResult,
  PassedChecksResult,
  UnresolvedIssue,
  VerificationCheck,
} from "../types.js";

export interface RepairOptions {
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

const NEEDS_INFORMATION_CODES: ReadonlySet<string> = new Set([
  "ambiguous_date",
  "ambiguous_number",
  "ambiguous_currency",
  "contradictory_requirements",
  "missing_fact",
]);

interface RepairAttempt {
  value: JsonValue;
  justification: string;
  ruleIndexes: number[];
  identifierPreserved?: boolean;
}

function uniqueSorted(indexes: number[]): number[] {
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function formatRuleList(indexes: number[]): string {
  const sorted = uniqueSorted(indexes);
  return sorted.length === 1 ? String(sorted[0]) : sorted.join(" and ");
}

function coerceToSubschemaType(rawValue: string, subschema: JsonValue, originalValue: JsonValue): JsonValue | undefined {
  const declaredType = isPlainObject(subschema) ? subschema["type"] : undefined;
  const targetType = typeof declaredType === "string" ? declaredType : typeof originalValue;
  if (targetType === "number" || targetType === "integer") {
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (targetType === "boolean") {
    if (rawValue === "true") return true;
    if (rawValue === "false") return false;
    return undefined;
  }
  return rawValue;
}

function tryValue(
  key: string,
  candidateValue: JsonValue,
  subschema: JsonValue,
  required: boolean,
  justification: string,
  ruleIndexes: number[],
  identifierPreserved = false,
  rootSchema?: JsonObject,
): RepairAttempt | null {
  if (fieldIsValid(key, candidateValue, subschema, required, rootSchema)) {
    return { value: candidateValue, justification, ruleIndexes: uniqueSorted(ruleIndexes), identifierPreserved };
  }
  return null;
}

/**
 * Looks for exactly one deterministic, rule-backed transformation that turns
 * `value` into something valid for `subschema`. Strategies are tried in a
 * fixed, documented order (see `docs/repair-engine.md`); the first one that
 * both matches an explicit directive AND produces a schema-valid result
 * wins. Returns `null` when no explicit rule justifies a safe change.
 */
function findRepairStrategy(
  key: string,
  value: JsonValue,
  subschema: JsonValue,
  directives: readonly Directive[],
  required: boolean,
  skipConstantRequirement: boolean,
  rootSchema: JsonObject,
): RepairAttempt | null {
  const identifierDirectives = directives.filter(
    (directive): directive is IdentifierPreserveDirective => directive.kind === "identifier_preserve" && directive.field === key,
  );
  if (identifierDirectives.length > 0) {
    const targetLength = fixedDigitPatternLength(subschema);
    if (targetLength !== null) {
      let digits: string | null = null;
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        digits = String(value);
      } else if (typeof value === "string" && /^\d+$/.test(value)) {
        digits = value;
      }
      if (digits !== null && digits.length <= targetLength) {
        const padded = digits.padStart(targetLength, "0");
        const attempt = tryValue(
          key,
          padded,
          subschema,
          required,
          `Explicit rule ${formatRuleList(identifierDirectives.map((d) => d.ruleIndex))} defines a ${targetLength}-character identifier and requires preserving leading zeros.`,
          identifierDirectives.map((d) => d.ruleIndex),
          true,
          rootSchema,
        );
        if (attempt) return attempt;
      }
    }
  }

  if (!skipConstantRequirement) {
    const constantDirectives = directives.filter(
      (directive): directive is ConstantRequirementDirective => directive.kind === "constant_requirement" && directive.field === key,
    );
    if (constantDirectives.length > 0) {
      const required0 = constantDirectives[0] as ConstantRequirementDirective;
      const coerced = coerceToSubschemaType(required0.value, subschema, value);
      if (coerced !== undefined) {
        const attempt = tryValue(
          key,
          coerced,
          subschema,
          required,
          `Explicit rule ${formatRuleList(constantDirectives.map((d) => d.ruleIndex))} requires "${key}" to be "${required0.value}".`,
          constantDirectives.map((d) => d.ruleIndex),
          false,
          rootSchema,
        );
        if (attempt) return attempt;
      }
    }
  }

  for (const directive of directives) {
    if (directive.kind === "enum_normalize" && directive.field === key && String(value) === directive.fromValue) {
      const coerced = coerceToSubschemaType(directive.toValue, subschema, value);
      if (coerced !== undefined) {
        const attempt = tryValue(
          key,
          coerced,
          subschema,
          required,
          `Explicit rule ${directive.ruleIndex} normalizes "${key}" value "${directive.fromValue}" to "${directive.toValue}".`,
          [directive.ruleIndex],
          false,
          rootSchema,
        );
        if (attempt) return attempt;
      }
    }
  }

  if (typeof value === "string") {
    for (const directive of directives) {
      if (directive.kind === "trim_whitespace" && (directive.field === key || directive.field === "*")) {
        const trimmed: string = value.trim();
        if (trimmed !== value) {
          const attempt = tryValue(
            key,
            trimmed,
            subschema,
            required,
            `Explicit rule ${directive.ruleIndex} permits removing surrounding whitespace from "${key}".`,
            [directive.ruleIndex],
            false,
            rootSchema,
          );
          if (attempt) return attempt;
        }
      }
    }

    for (const directive of directives) {
      if (directive.kind === "date_format" && (directive.field === key || directive.field === "*")) {
        const iso = resolveSlashDateToIso(value, directive.order);
        if (iso) {
          const attempt = tryValue(
            key,
            iso,
            subschema,
            required,
            `Explicit rule ${directive.ruleIndex} fixes the day/month order for "${key}", so "${value}" reformats unambiguously to "${iso}".`,
            [directive.ruleIndex],
            false,
            rootSchema,
          );
          if (attempt) return attempt;
        }
      }
    }

    for (const directive of directives) {
      if (directive.kind === "currency_symbol" && directive.field === key && value === directive.symbol) {
        const attempt = tryValue(
          key,
          directive.code,
          subschema,
          required,
          `Explicit rule ${directive.ruleIndex} maps the "${directive.symbol}" symbol to "${directive.code}" for "${key}".`,
          [directive.ruleIndex],
          false,
          rootSchema,
        );
        if (attempt) return attempt;
      }
    }

    for (const directive of directives) {
      if (directive.kind === "number_separator" && directive.field === key) {
        const resolvedString = resolveCommaNumber(value, directive.commaMeans);
        if (resolvedString !== null) {
          const coerced = coerceToSubschemaType(resolvedString, subschema, value);
          if (coerced !== undefined) {
            const attempt = tryValue(
              key,
              coerced,
              subschema,
              required,
              `Explicit rule ${directive.ruleIndex} defines the comma in "${key}" as a ${directive.commaMeans} separator.`,
              [directive.ruleIndex],
              false,
              rootSchema,
            );
            if (attempt) return attempt;
          }
        }
      }
    }
  }

  return null;
}

function classifyUnresolved(
  key: string,
  value: JsonValue,
  subschema: JsonValue,
  pointer: string,
  required: boolean,
  rootSchema: JsonObject,
): UnresolvedIssue {
  if (fieldSchemaCompileFailed(key, value, subschema, required, rootSchema)) {
    return {
      code: "invalid_target_schema",
      message: `The target schema for "${key}" could not be compiled: ${fieldValidationErrors(key, value, subschema, required, rootSchema)}`,
      path: pointer,
    };
  }

  if (typeof value === "string") {
    const dateAnalysis = analyzeSlashDate(value);
    if (dateAnalysis.matches && dateAnalysis.ambiguous) {
      return {
        code: "ambiguous_date",
        message: `Specify whether "${value}" means day/month or month/day order for "${key}".`,
        path: pointer,
      };
    }

    if (isAmbiguousCommaNumber(value)) {
      return {
        code: "ambiguous_number",
        message: `"${value}" for "${key}" could use a decimal or a thousands comma; no rule specifies which.`,
        path: pointer,
      };
    }

    const enumValues = stringEnumValues(subschema);
    const looksCurrencyish = key.toLowerCase().includes("currency") || (enumValues?.some((v) => /^[A-Z]{3}$/.test(v)) ?? false);
    if (looksCurrencyish && looksLikeCurrencySymbol(value)) {
      return {
        code: "ambiguous_currency",
        message: `"${value}" for "${key}" is a currency symbol, not an ISO 4217 code, and no rule pins it to one.`,
        path: pointer,
      };
    }
  }

  return {
    code: "schema_violation",
    message: `"${key}" does not satisfy the target schema and no explicit rule justifies a safe transformation. ${fieldValidationErrors(key, value, subschema, required, rootSchema)}`,
    path: pointer,
  };
}

function directiveTargetsUnsafeKey(directive: Directive): boolean {
  if (directive.kind === "rename") {
    return UNSAFE_KEYS.has(directive.to);
  }
  if (directive.kind === "move") {
    const pointer = directive.to.startsWith("/") ? directive.to : `/${directive.to}`;
    return parsePointer(pointer).some((segment) => UNSAFE_KEYS.has(segment));
  }
  return false;
}

function applyStructuralDirectives(candidate: JsonValue, directives: readonly Directive[], pushChange: (change: ChangeEvidence) => boolean): void {
  if (!isPlainObject(candidate)) {
    return;
  }

  for (const directive of directives) {
    if (directive.kind === "rename") {
      const hasFrom = Object.prototype.hasOwnProperty.call(candidate, directive.from);
      const hasTo = Object.prototype.hasOwnProperty.call(candidate, directive.to);
      if (!hasFrom || hasTo) {
        continue;
      }
      const value = candidate[directive.from] as JsonValue;
      const removed = pushChange({
        path: `/${escapeToken(directive.from)}`,
        operation: "remove",
        before: value,
        justification: `Explicit rule ${directive.ruleIndex} renames "${directive.from}" to "${directive.to}".`,
        rule_indexes: [directive.ruleIndex],
      });
      if (!removed) continue;
      pushChange({
        path: `/${escapeToken(directive.to)}`,
        operation: "add",
        after: value,
        justification: `Explicit rule ${directive.ruleIndex} renames "${directive.from}" to "${directive.to}".`,
        rule_indexes: [directive.ruleIndex],
      });
      delete candidate[directive.from];
      candidate[directive.to] = value;
    }

    if (directive.kind === "move") {
      const fromPointer = directive.from.startsWith("/") ? directive.from : `/${directive.from}`;
      const toPointer = directive.to.startsWith("/") ? directive.to : `/${directive.to}`;
      if (!hasAt(candidate, fromPointer) || hasAt(candidate, toPointer)) {
        continue;
      }
      const toSegments = parsePointer(toPointer);
      const parentPointer = toSegments.length > 1 ? `/${toSegments.slice(0, -1).map(escapeToken).join("/")}` : "";
      const parent = parentPointer === "" ? candidate : getAt(candidate, parentPointer);
      if (!isPlainObject(parent)) {
        continue;
      }
      const value = getAt(candidate, fromPointer) as JsonValue;
      const removed = pushChange({
        path: fromPointer,
        operation: "remove",
        before: value,
        justification: `Explicit rule ${directive.ruleIndex} moves "${directive.from}" to "${directive.to}".`,
        rule_indexes: [directive.ruleIndex],
      });
      if (!removed) continue;
      pushChange({
        path: toPointer,
        operation: "add",
        after: value,
        justification: `Explicit rule ${directive.ruleIndex} moves "${directive.from}" to "${directive.to}".`,
        rule_indexes: [directive.ruleIndex],
      });
      removeAt(candidate, fromPointer);
      setAt(candidate, toPointer, value);
    }
  }
}

function elapsedMsSince(start: number, now: () => number): number {
  return Math.max(0, Math.round(now() - start));
}

function describeParseError(error: unknown): string {
  return error instanceof Error ? error.message : "The source text is not valid JSON.";
}

function baseChecks(): VerificationCheck[] {
  return [];
}

function buildCannotRepair(
  jobId: string,
  checks: VerificationCheck[],
  unresolved: UnresolvedIssue<CannotRepairCode>[],
  originalHash: string,
  schemaHash: string,
  elapsedMs: number,
  changes: ChangeEvidence[] = [],
): CannotRepairResult {
  return {
    job_id: jobId,
    status: "cannot_repair",
    changes,
    checks,
    unresolved: unresolved as unknown as [UnresolvedIssue<CannotRepairCode>, ...UnresolvedIssue<CannotRepairCode>[]],
    original_hash: originalHash,
    schema_hash: schemaHash,
    elapsed_ms: elapsedMs,
    implementation_version: IMPLEMENTATION_VERSION,
  };
}

function buildNeedsInformation(
  jobId: string,
  checks: VerificationCheck[],
  unresolved: UnresolvedIssue[],
  originalHash: string,
  schemaHash: string,
  elapsedMs: number,
  changes: ChangeEvidence[] = [],
): NeedsInformationResult {
  return {
    job_id: jobId,
    status: "needs_information",
    changes,
    checks,
    unresolved: unresolved as unknown as [UnresolvedIssue, ...UnresolvedIssue[]],
    original_hash: originalHash,
    schema_hash: schemaHash,
    elapsed_ms: elapsedMs,
    implementation_version: IMPLEMENTATION_VERSION,
  };
}

/**
 * Deterministically repairs `request.source_text` against `request.target_schema`,
 * applying only transformations backed by a matched explicit-rule directive.
 * Never mutates the parsed source; always returns a fresh candidate. See
 * `docs/repair-engine.md` for the supported rule grammar and status
 * decision table.
 */
export function repairJson(request: DeliverCheckRequest, options: RepairOptions = {}): DeliverCheckResult {
  const now = options.now ?? Date.now;
  const start = now();
  const jobId = request.request_id;
  const originalHash = hashText(request.source_text);
  const schemaHash = hashJsonValue(request.target_schema);
  const checks = baseChecks();

  if (request.explicit_rules.length > MAX_EXPLICIT_RULES) {
    checks.push({
      name: "explicit_rule_limit",
      status: "failed",
      evidence: `The request contains more than the supported ${MAX_EXPLICIT_RULES} explicit rules.`,
      proves_factual_truth: false,
    });
    return buildCannotRepair(
      jobId,
      checks,
      [{
        code: "schema_violation",
        message: `The request contains ${request.explicit_rules.length} explicit rules; the maximum is ${MAX_EXPLICIT_RULES}. No rules were processed.`,
      }],
      originalHash,
      schemaHash,
      elapsedMsSince(start, now),
    );
  }

  let parsedSource: JsonValue;
  try {
    parsedSource = JSON.parse(request.source_text) as JsonValue;
  } catch (error) {
    checks.push({
      name: "source_json_parse",
      status: "failed",
      evidence: describeParseError(error),
      proves_factual_truth: false,
    });
    return buildCannotRepair(
      jobId,
      checks,
      [
        {
          code: "invalid_source_json",
          message: "The source is not parseable JSON and no explicit rule justifies reconstructing the missing content.",
        },
      ],
      originalHash,
      schemaHash,
      elapsedMsSince(start, now),
    );
  }
  checks.push({
    name: "source_json_parse",
    status: "passed",
    evidence: "source_text parsed as valid JSON.",
    proves_factual_truth: false,
  });

  const unsafeSourcePaths = findUnsafeKeys(parsedSource);
  if (unsafeSourcePaths.length > 0) {
    checks.push({
      name: "unsafe_key_scan",
      status: "failed",
      evidence: `Reserved keys found at: ${unsafeSourcePaths.join(", ")}.`,
      proves_factual_truth: false,
    });
    return buildCannotRepair(
      jobId,
      checks,
      [
        {
          code: "schema_violation",
          message: "The source JSON contains a reserved key (__proto__, constructor, or prototype) that DeliverCheck refuses to process.",
          path: unsafeSourcePaths[0] as string,
        },
      ],
      originalHash,
      schemaHash,
      elapsedMsSince(start, now),
    );
  }
  checks.push({
    name: "unsafe_key_scan",
    status: "passed",
    evidence: "No reserved prototype keys found in the source.",
    proves_factual_truth: false,
  });

  const fieldNames = isPlainObject(request.target_schema) ? collectFieldNames(request.target_schema) : [];
  const { directives, contradictions } = parseExplicitRules(request.explicit_rules, fieldNames);

  checks.push({
    name: "rule_consistency",
    status: contradictions.length > 0 ? "failed" : "passed",
    evidence:
      contradictions.length > 0
        ? `${contradictions.length} field(s) have contradictory explicit rules.`
        : "No contradictory explicit rules were detected.",
    proves_factual_truth: false,
  });

  const contradictedFields = new Set(contradictions.map((issue) => (issue.path ?? "").replace(/^\//, "")));

  const unsafeDirective = directives.find((directive) => directiveTargetsUnsafeKey(directive));
  if (unsafeDirective) {
    checks.push({
      name: "unsafe_key_scan",
      status: "failed",
      evidence: `Explicit rule ${unsafeDirective.ruleIndex} targets a reserved key.`,
      proves_factual_truth: false,
    });
    return buildCannotRepair(
      jobId,
      checks,
      [
        {
          code: "schema_violation",
          message: "An explicit rule attempts to create or rename a field to a reserved key (__proto__, constructor, or prototype).",
          rule_indexes: [unsafeDirective.ruleIndex],
        },
      ],
      originalHash,
      schemaHash,
      elapsedMsSince(start, now),
    );
  }

  const candidate: JsonValue = structuredClone(parsedSource);
  const changes: ChangeEvidence[] = [];
  const unresolved: UnresolvedIssue[] = [...contradictions];
  let budgetExceeded = false;

  function pushChange(change: ChangeEvidence): boolean {
    if (changes.length >= MAX_CHANGE_OPERATIONS) {
      budgetExceeded = true;
      return false;
    }
    changes.push(change);
    return true;
  }

  applyStructuralDirectives(candidate, directives, pushChange);

  const identifierFieldsSeen = new Set<string>();

  if (!budgetExceeded && isFlatObjectSchema(request.target_schema) && isPlainObject(candidate)) {
    const properties = request.target_schema["properties"] as JsonObject;
    const requiredList = request.target_schema["required"];
    const required = new Set(Array.isArray(requiredList) ? requiredList.filter((v): v is string => typeof v === "string") : []);

    for (const [key, subschema] of Object.entries(properties)) {
      if (budgetExceeded) break;

      const pointer = `/${escapeToken(key)}`;
      const isRequired = required.has(key);
      const hasKey = Object.prototype.hasOwnProperty.call(candidate, key);

      if (!hasKey) {
        if (isRequired) {
          unresolved.push({
            code: "missing_fact",
            message: `Required field "${key}" is missing from the source and no rule supplies it.`,
            path: pointer,
          });
        }
        continue;
      }

      const currentValue = candidate[key] as JsonValue;
      if (fieldIsValid(key, currentValue, subschema, isRequired, request.target_schema)) {
        continue;
      }

      const attempt = findRepairStrategy(
        key,
        currentValue,
        subschema,
        directives,
        isRequired,
        contradictedFields.has(key),
        request.target_schema,
      );
      if (!attempt) {
        if (!contradictedFields.has(key)) {
          unresolved.push(classifyUnresolved(
            key,
            currentValue,
            subschema,
            pointer,
            isRequired,
            request.target_schema,
          ));
        }
        continue;
      }

      const applied = pushChange({
        path: pointer,
        operation: "replace",
        before: currentValue,
        after: attempt.value,
        justification: attempt.justification,
        rule_indexes: attempt.ruleIndexes,
      });
      if (!applied) {
        unresolved.push(classifyUnresolved(
          key,
          currentValue,
          subschema,
          pointer,
          isRequired,
          request.target_schema,
        ));
        continue;
      }

      candidate[key] = attempt.value;
      if (attempt.identifierPreserved) {
        identifierFieldsSeen.add(key);
      }
    }
  }

  if (budgetExceeded) {
    unresolved.push({
      code: "schema_violation",
      message: `Repair exceeded the maximum of ${MAX_CHANGE_OPERATIONS} operations permitted in this checkpoint.`,
    });
  }

  if (unresolved.length === 0) {
    const validation = validateCandidate(candidate, request.target_schema);
    if (!validation.valid) {
      const compileFailed = validation.errors.some((error) => error.keyword === "invalid_target_schema");
      checks.push({
        name: "target_schema",
        status: "failed",
        evidence: validation.errors.map((error) => `${error.instance_path || "/"}: ${error.message}`).join("; ") || "Schema validation failed.",
        proves_factual_truth: false,
      });
      if (identifierFieldsSeen.size > 0) {
        checks.push({
          name: "identifier_preservation",
          status: "failed",
          evidence: `Attempted to preserve exact representation for: ${[...identifierFieldsSeen].join(", ")}, but final validation still failed.`,
          proves_factual_truth: false,
        });
      }
      unresolved.push({
        code: compileFailed ? "invalid_target_schema" : "schema_violation",
        message: validation.errors.map((error) => `${error.instance_path || "/"}: ${error.message}`).join("; ") || "The candidate does not satisfy the target schema.",
      });
    } else {
      checks.push({
        name: "target_schema",
        status: "passed",
        evidence: "Candidate validates against the supplied target schema without coercion, defaults, or property removal.",
        proves_factual_truth: false,
      });
      if (identifierFieldsSeen.size > 0) {
        checks.push({
          name: "identifier_preservation",
          status: "passed",
          evidence: `Preserved exact identifier representation for: ${[...identifierFieldsSeen].join(", ")}.`,
          proves_factual_truth: false,
        });
      }

      const candidateHash = hashJsonValue(candidate);
      const result: PassedChecksResult = {
        job_id: jobId,
        status: "passed_checks",
        candidate,
        candidate_hash: candidateHash,
        changes,
        checks,
        unresolved: [],
        original_hash: originalHash,
        schema_hash: schemaHash,
        elapsed_ms: elapsedMsSince(start, now),
        implementation_version: IMPLEMENTATION_VERSION,
      };
      return result;
    }
  }

  if (unresolved.some((issue) => NEEDS_INFORMATION_CODES.has(issue.code))) {
    return buildNeedsInformation(jobId, checks, unresolved, originalHash, schemaHash, elapsedMsSince(start, now), changes);
  }

  return buildCannotRepair(
    jobId,
    checks,
    unresolved as UnresolvedIssue<CannotRepairCode>[],
    originalHash,
    schemaHash,
    elapsedMsSince(start, now),
    changes,
  );
}
