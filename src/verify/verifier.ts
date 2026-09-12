import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import type {
  ChangeEvidence,
  DeliverCheckRequest,
  DeliverCheckResult,
  UnresolvedIssue,
  ValidationError,
  VerificationCheck,
} from "../types.js";
import {
  canonicalJsonStringify,
  computeCanonicalHash,
  computeOriginalHash,
} from "./canonical.js";
import { auditChanges, type ChangeAuditResult } from "./diff.js";
import {
  assertSafePayloadSize,
  assertSafeStructure,
  assertSafeTargetSchema,
  DEFAULT_SECURITY_LIMITS,
  executeWithinTimeLimit,
  type SecurityLimits,
} from "./security.js";

export interface DetailedCheck {
  name: string;
  rule?: string | undefined;
  rule_index?: number | undefined;
  method: string;
  outcome: "passed" | "failed" | "skipped";
  diagnostic: string;
  evidence: string;
  proves_factual_truth: false;
}

export interface VerificationReport {
  valid: boolean;
  status: "passed_checks" | "needs_information" | "cannot_repair";
  checks: VerificationCheck[];
  detailedChecks: DetailedCheck[];
  unresolved: UnresolvedIssue[];
  hashes: {
    original: string;
    schema: string;
    candidate?: string | undefined;
  };
  hashMatches: {
    original: boolean;
    schema: boolean;
    candidate?: boolean | undefined;
  };
  changeAudit?: ChangeAuditResult | undefined;
  elapsedMs: number;
  proves_factual_truth: false;
}

export interface VerifyCandidateOptions {
  request: DeliverCheckRequest;
  candidate?: unknown | undefined;
  candidateHash?: string | undefined;
  changes?: ChangeEvidence[] | undefined;
  declaredOriginalHash?: string | undefined;
  declaredSchemaHash?: string | undefined;
  unresolved?: UnresolvedIssue[] | undefined;
  limits?: Partial<SecurityLimits> | undefined;
}

const ajvOptions = {
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateFormats: false,
} as const;

function formatAjvErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  return (errors ?? []).map((error) => ({
    instance_path: error.instancePath,
    schema_path: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "Schema validation failed.",
  }));
}

/**
 * Deep freezes an object in-place to ensure immutability during verification.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const prop = (obj as any)[key];
    if (prop !== null && (typeof prop === "object" || typeof prop === "function") && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  }
  return obj;
}

/**
 * Converts a DetailedCheck to a frozen contract-compliant VerificationCheck.
 */
export function toContractCheck(detailed: DetailedCheck): VerificationCheck {
  return {
    name: detailed.name,
    status: detailed.outcome,
    evidence: detailed.evidence,
    proves_factual_truth: false,
  };
}

/**
 * Independent candidate and evidence verifier.
 *
 * Validates candidate against schema without mutation, coercion, defaults, or property removal.
 * Hashes original, schema, and candidate using RFC 8785 and SHA-256.
 * Audits declared changes and detects undeclared changes.
 * Enforces security limits and prototype protections.
 * Always disclaims factual truth.
 */
export function verifyCandidate(options: VerifyCandidateOptions): VerificationReport {
  const limits: SecurityLimits = {
    ...DEFAULT_SECURITY_LIMITS,
    ...(options.limits ?? {}),
  };

  return executeWithinTimeLimit(() => {
    const detailedChecks: DetailedCheck[] = [];
    const unresolved: UnresolvedIssue[] = options.unresolved ? [...options.unresolved] : [];

    // Factuality disclaimer check (always present, always false)
    detailedChecks.push({
      name: "factual_truth_disclaimer",
      method: "independent_safety_invariant",
      outcome: "passed",
      diagnostic: "Verifier structural checks verify schema and contract rules only; they do not attest to real-world factual truth.",
      evidence: "Independent verifier enforces that schema validity does not prove real-world factual truth.",
      proves_factual_truth: false,
    });

    // 1. Enforce payload size limit on request.source_text
    try {
      assertSafePayloadSize(options.request.source_text, limits);
      detailedChecks.push({
        name: "payload_size_check",
        method: "bounded_resource_inspection",
        outcome: "passed",
        diagnostic: `Payload size (${Buffer.byteLength(options.request.source_text, "utf8")} bytes) is within limit (${limits.maxPayloadBytes} bytes).`,
        evidence: `Payload size is within the allowed ${limits.maxPayloadBytes} bytes limit.`,
        proves_factual_truth: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Payload size exceeded limit.";
      detailedChecks.push({
        name: "payload_size_check",
        method: "bounded_resource_inspection",
        outcome: "failed",
        diagnostic: msg,
        evidence: msg,
        proves_factual_truth: false,
      });
      unresolved.push({
        code: "invalid_source_json",
        message: msg,
      });

      return buildReport(false, "cannot_repair", detailedChecks, unresolved, {
        original: computeOriginalHash(options.request.source_text),
        schema: computeCanonicalHash(options.request.target_schema),
      }, { original: false, schema: false });
    }

    // 2. Compute canonical original and schema hashes
    const computedOriginalHash = computeOriginalHash(options.request.source_text);
    const originalHashMatches = options.declaredOriginalHash
      ? options.declaredOriginalHash === computedOriginalHash
      : true;

    detailedChecks.push({
      name: "original_hash_verification",
      method: "utf8_sha256",
      outcome: originalHashMatches ? "passed" : "failed",
      diagnostic: originalHashMatches
        ? `Computed original hash ${computedOriginalHash} matches.`
        : `Declared original hash ${options.declaredOriginalHash} does not match computed ${computedOriginalHash}.`,
      evidence: `Original UTF-8 text hash: ${computedOriginalHash}.`,
      proves_factual_truth: false,
    });

    if (!originalHashMatches) {
      unresolved.push({
        code: "schema_violation",
        message: `Original hash mismatch: expected ${computedOriginalHash}, got ${options.declaredOriginalHash}.`,
      });
    }

    // 3. Security checks on target_schema
    try {
      assertSafeTargetSchema(options.request.target_schema, limits);
      detailedChecks.push({
        name: "target_schema_security",
        method: "ast_inspection",
        outcome: "passed",
        diagnostic: "Target schema contains no dangerous prototype keys, bounded depth/nodes, and no unsupported remote references.",
        evidence: "Target schema passed prototype pollution, remote reference, and depth checks.",
        proves_factual_truth: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Schema security violation.";
      detailedChecks.push({
        name: "target_schema_security",
        method: "ast_inspection",
        outcome: "failed",
        diagnostic: msg,
        evidence: msg,
        proves_factual_truth: false,
      });
      unresolved.push({
        code: "invalid_target_schema",
        message: msg,
      });

      const computedSchemaHash = computeCanonicalHash(options.request.target_schema);
      return buildReport(false, "cannot_repair", detailedChecks, unresolved, {
        original: computedOriginalHash,
        schema: computedSchemaHash,
      }, { original: originalHashMatches, schema: true });
    }

    // 4. Schema canonical hash
    const computedSchemaHash = computeCanonicalHash(options.request.target_schema);
    const schemaHashMatches = options.declaredSchemaHash
      ? options.declaredSchemaHash === computedSchemaHash
      : true;

    detailedChecks.push({
      name: "schema_hash_verification",
      method: "rfc8785_canonical_sha256",
      outcome: schemaHashMatches ? "passed" : "failed",
      diagnostic: schemaHashMatches
        ? `Computed schema hash ${computedSchemaHash} matches.`
        : `Declared schema hash ${options.declaredSchemaHash} does not match computed ${computedSchemaHash}.`,
      evidence: `Schema RFC 8785 canonical hash: ${computedSchemaHash}.`,
      proves_factual_truth: false,
    });

    if (!schemaHashMatches) {
      unresolved.push({
        code: "schema_violation",
        message: `Schema hash mismatch: expected ${computedSchemaHash}, got ${options.declaredSchemaHash}.`,
      });
    }

    // 5. Parse source_text
    let parsedOriginal: unknown = undefined;
    let sourceJsonValid = false;
    try {
      parsedOriginal = JSON.parse(options.request.source_text);
      assertSafeStructure(parsedOriginal, limits);
      sourceJsonValid = true;
      detailedChecks.push({
        name: "source_json_parse",
        method: "json_parse_and_ast_inspection",
        outcome: "passed",
        diagnostic: "Source text is valid JSON with safe structure and depth.",
        evidence: "Source text parsed successfully into JSON without prototype pollution keys.",
        proves_factual_truth: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Source text failed JSON parsing.";
      detailedChecks.push({
        name: "source_json_parse",
        method: "json_parse_and_ast_inspection",
        outcome: "failed",
        diagnostic: msg,
        evidence: msg,
        proves_factual_truth: false,
      });
      unresolved.push({
        code: "invalid_source_json",
        message: `Source JSON parsing failed: ${msg}`,
      });
    }

    // 6. Compile target_schema with Ajv2020
    let validator: ValidateFunction | undefined;
    try {
      const schemaClone = structuredClone(options.request.target_schema);
      const ajv = new Ajv2020(ajvOptions);
      validator = ajv.compile(schemaClone);
      detailedChecks.push({
        name: "target_schema_compilation",
        method: "ajv_2020_strict_compile",
        outcome: "passed",
        diagnostic: "Target schema compiled successfully as JSON Schema Draft 2020-12.",
        evidence: "Target schema compiled successfully.",
        proves_factual_truth: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Target schema compilation failed.";
      detailedChecks.push({
        name: "target_schema_compilation",
        method: "ajv_2020_strict_compile",
        outcome: "failed",
        diagnostic: msg,
        evidence: msg,
        proves_factual_truth: false,
      });
      unresolved.push({
        code: "invalid_target_schema",
        message: msg,
      });
    }

    // If candidate is not provided, this is a non-candidate assessment (e.g. cannot_repair or needs_information)
    if (options.candidate === undefined) {
      const status = unresolved.some((u) =>
        [
          "ambiguous_date",
          "ambiguous_number",
          "ambiguous_currency",
          "contradictory_requirements",
          "missing_fact",
        ].includes(u.code),
      )
        ? "needs_information"
        : "cannot_repair";

      return buildReport(
        false,
        status,
        detailedChecks,
        unresolved,
        { original: computedOriginalHash, schema: computedSchemaHash },
        { original: originalHashMatches, schema: schemaHashMatches },
      );
    }

    // 7. Security check on candidate
    try {
      assertSafeStructure(options.candidate, limits);
      detailedChecks.push({
        name: "candidate_structure_safety",
        method: "ast_inspection",
        outcome: "passed",
        diagnostic: "Candidate structure does not contain dangerous prototype keys and respects depth limit.",
        evidence: "Candidate structure verified safe.",
        proves_factual_truth: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Candidate structure security violation.";
      detailedChecks.push({
        name: "candidate_structure_safety",
        method: "ast_inspection",
        outcome: "failed",
        diagnostic: msg,
        evidence: msg,
        proves_factual_truth: false,
      });
      unresolved.push({
        code: "schema_violation",
        message: msg,
      });
    }

    // 8. Canonical candidate hash
    const computedCandidateHash = computeCanonicalHash(options.candidate);
    const candidateHashMatches = options.candidateHash
      ? options.candidateHash === computedCandidateHash
      : true;

    detailedChecks.push({
      name: "candidate_hash_verification",
      method: "rfc8785_canonical_sha256",
      outcome: candidateHashMatches ? "passed" : "failed",
      diagnostic: candidateHashMatches
        ? `Computed candidate hash ${computedCandidateHash} matches declared hash.`
        : `Declared candidate hash ${options.candidateHash} does not match computed ${computedCandidateHash}.`,
      evidence: `Candidate RFC 8785 canonical hash: ${computedCandidateHash}.`,
      proves_factual_truth: false,
    });

    if (!candidateHashMatches) {
      unresolved.push({
        code: "schema_violation",
        message: `Candidate hash mismatch: expected ${computedCandidateHash}, got ${options.candidateHash}.`,
      });
    }

    // 9. Exact Candidate Schema Validation (no coercion, no defaults, no removal)
    if (validator) {
      // Ensure candidate cannot be mutated
      const candidateSnapshot = canonicalJsonStringify(options.candidate);
      const isValid = validator(options.candidate);
      const afterSnapshot = canonicalJsonStringify(options.candidate);

      if (candidateSnapshot !== afterSnapshot) {
        throw new Error("Critical invariant violated: candidate was mutated during schema validation.");
      }

      if (isValid) {
        detailedChecks.push({
          name: "candidate_schema_validation",
          method: "ajv_strict_validate",
          outcome: "passed",
          diagnostic: "Candidate matches target schema exactly without coercion, defaults, or property removal.",
          evidence: "Candidate validates against target schema without coercion, defaults, or property removal.",
          proves_factual_truth: false,
        });
      } else {
        const errors = formatAjvErrors(validator.errors);
        const errorDesc = errors.map((e) => `${e.instance_path || "/"}: ${e.message} (${e.keyword})`).join("; ");
        detailedChecks.push({
          name: "candidate_schema_validation",
          method: "ajv_strict_validate",
          outcome: "failed",
          diagnostic: `Validation failed: ${errorDesc}`,
          evidence: `Candidate failed target schema validation: ${errorDesc}`,
          proves_factual_truth: false,
        });
        unresolved.push({
          code: "schema_violation",
          message: `Candidate does not conform to target schema: ${errorDesc}`,
          path: errors[0]?.instance_path || "",
        });
      }
    }

    // 10. Audit declared repair changes vs actual difference
    let changeAudit: ChangeAuditResult | undefined = undefined;
    if (sourceJsonValid && options.changes !== undefined) {
      changeAudit = auditChanges(
        parsedOriginal,
        options.candidate,
        options.changes,
        options.request.explicit_rules.length,
      );

      if (changeAudit.valid) {
        detailedChecks.push({
          name: "change_evidence_audit",
          method: "rfc6901_diff_audit",
          outcome: "passed",
          diagnostic: `All ${options.changes.length} declared change(s) match actual diffs, rule indexes valid, no undeclared changes.`,
          evidence: `All ${options.changes.length} declared changes accurately match the original-to-candidate difference without undeclared edits.`,
          proves_factual_truth: false,
        });
      } else {
        const reasons: string[] = [];
        if (changeAudit.mismatchedChanges.length > 0) {
          reasons.push(
            `Mismatched changes: ${changeAudit.mismatchedChanges.map((m) => `${m.change.path}: ${m.reason}`).join("; ")}`,
          );
        }
        if (changeAudit.undeclaredChanges.length > 0) {
          reasons.push(
            `Undeclared changes detected: ${changeAudit.undeclaredChanges.map((u) => `${u.path} (${u.operation})`).join(", ")}`,
          );
        }
        if (changeAudit.spuriousChanges.length > 0) {
          reasons.push(
            `Spurious declared changes (no actual edit): ${changeAudit.spuriousChanges.map((s) => s.path).join(", ")}`,
          );
        }

        const reasonStr = reasons.join(" | ");
        detailedChecks.push({
          name: "change_evidence_audit",
          method: "rfc6901_diff_audit",
          outcome: "failed",
          diagnostic: reasonStr,
          evidence: `Change audit failed: ${reasonStr}`,
          proves_factual_truth: false,
        });

        unresolved.push({
          code: "contradictory_requirements",
          message: `Change evidence audit failed: ${reasonStr}`,
        });
      }
    }

    // Determine final status
    const allChecksPassed = detailedChecks.every((c) => c.outcome === "passed");
    const valid = allChecksPassed && unresolved.length === 0;

    let status: "passed_checks" | "needs_information" | "cannot_repair";
    if (valid) {
      status = "passed_checks";
    } else if (
      unresolved.some((u) =>
        [
          "ambiguous_date",
          "ambiguous_number",
          "ambiguous_currency",
          "contradictory_requirements",
          "missing_fact",
        ].includes(u.code),
      )
    ) {
      status = "needs_information";
    } else {
      status = "cannot_repair";
    }

    return buildReport(
      valid,
      status,
      detailedChecks,
      unresolved,
      {
        original: computedOriginalHash,
        schema: computedSchemaHash,
        candidate: computedCandidateHash,
      },
      {
        original: originalHashMatches,
        schema: schemaHashMatches,
        candidate: candidateHashMatches,
      },
      changeAudit,
    );
  }, limits.maxExecutionMs).result;
}

function buildReport(
  valid: boolean,
  status: "passed_checks" | "needs_information" | "cannot_repair",
  detailedChecks: DetailedCheck[],
  unresolved: UnresolvedIssue[],
  hashes: { original: string; schema: string; candidate?: string | undefined },
  hashMatches: { original: boolean; schema: boolean; candidate?: boolean | undefined },
  changeAudit?: ChangeAuditResult | undefined,
): VerificationReport {
  return {
    valid,
    status,
    checks: detailedChecks.map(toContractCheck),
    detailedChecks,
    unresolved,
    hashes,
    hashMatches,
    changeAudit,
    elapsedMs: 0,
    proves_factual_truth: false,
  };
}

/**
 * Verifies an entire DeliverCheckResult against a DeliverCheckRequest.
 */
export function verifyDeliverCheckResult(
  request: DeliverCheckRequest,
  result: DeliverCheckResult,
  limits?: Partial<SecurityLimits> | undefined,
): VerificationReport {
  const verifyOptions: VerifyCandidateOptions = {
    request,
    candidate: result.status === "passed_checks" ? result.candidate : (result as any).candidate,
    candidateHash: result.status === "passed_checks" ? result.candidate_hash : (result as any).candidate_hash,
    changes: result.changes,
    declaredOriginalHash: result.original_hash,
    declaredSchemaHash: result.schema_hash,
    unresolved: result.unresolved,
  };

  if (limits !== undefined) {
    verifyOptions.limits = limits;
  }

  return verifyCandidate(verifyOptions);
}
