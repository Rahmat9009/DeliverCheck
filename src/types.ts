export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

export interface DeliverCheckRequest {
  request_id: string;
  input_format: "json";
  source_text: string;
  target_schema: JsonObject;
  explicit_rules: string[];
  downstream_error?: string;
}

export type ResultStatus =
  | "passed_checks"
  | "needs_information"
  | "cannot_repair";

export type ChangeOperation = "add" | "replace" | "remove";

export interface ChangeEvidence {
  path: string;
  operation: ChangeOperation;
  before?: JsonValue;
  after?: JsonValue;
  justification: string;
  rule_indexes: number[];
}

export type CheckStatus = "passed" | "failed" | "skipped";

export interface VerificationCheck {
  name: string;
  status: CheckStatus;
  evidence: string;
  proves_factual_truth: false;
}

export type UnresolvedCode =
  | "ambiguous_date"
  | "ambiguous_number"
  | "ambiguous_currency"
  | "contradictory_requirements"
  | "missing_fact"
  | "invalid_source_json"
  | "invalid_target_schema"
  | "schema_violation"
  | "unsupported_input_format";

export type InformationRequiredCode =
  | "ambiguous_date"
  | "ambiguous_number"
  | "ambiguous_currency"
  | "contradictory_requirements"
  | "missing_fact";

export type CannotRepairCode = Exclude<UnresolvedCode, InformationRequiredCode>;

export interface UnresolvedIssue<Code extends UnresolvedCode = UnresolvedCode> {
  code: Code;
  message: string;
  path?: string;
  rule_indexes?: number[];
}

interface DeliverCheckResultBase {
  job_id: string;
  changes: ChangeEvidence[];
  checks: VerificationCheck[];
  unresolved: UnresolvedIssue[];
  original_hash: string;
  schema_hash: string;
  elapsed_ms: number;
  implementation_version: string;
}

export interface PassedChecksResult extends DeliverCheckResultBase {
  status: "passed_checks";
  candidate: JsonValue;
  candidate_hash: string;
  unresolved: [];
}

export interface NeedsInformationResult extends DeliverCheckResultBase {
  status: "needs_information";
  candidate?: JsonValue;
  candidate_hash?: string;
  unresolved: [UnresolvedIssue, ...UnresolvedIssue[]];
}

export interface CannotRepairResult extends DeliverCheckResultBase {
  status: "cannot_repair";
  unresolved: [
    UnresolvedIssue<CannotRepairCode>,
    ...UnresolvedIssue<CannotRepairCode>[],
  ];
}

export type DeliverCheckResult =
  | PassedChecksResult
  | NeedsInformationResult
  | CannotRepairResult;

export interface ValidationError {
  instance_path: string;
  schema_path: string;
  keyword: string;
  message: string;
}

export type ContractValidation<T> =
  | { valid: true; value: T; errors: [] }
  | { valid: false; errors: ValidationError[] };

export interface CandidateValidation {
  valid: boolean;
  errors: ValidationError[];
  proves_factual_truth: false;
}
