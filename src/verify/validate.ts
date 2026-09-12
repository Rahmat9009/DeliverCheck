import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import requestSchema from "../../contracts/request.schema.json" with { type: "json" };
import resultSchema from "../../contracts/result.schema.json" with { type: "json" };
import type {
  CandidateValidation,
  ContractValidation,
  DeliverCheckRequest,
  DeliverCheckResult,
  JsonObject,
  ValidationError,
} from "../types.js";

const ajvOptions = {
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateFormats: false,
} as const;

const contractAjv = new Ajv2020(ajvOptions);
const requestValidator = contractAjv.compile(requestSchema);
const resultValidator = contractAjv.compile(resultSchema);

function normalizeErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  return (errors ?? []).map((error) => ({
    instance_path: error.instancePath,
    schema_path: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "Schema validation failed.",
  }));
}

function validateContract<T>(
  validator: ValidateFunction,
  input: unknown,
): ContractValidation<T> {
  if (validator(input)) {
    return { valid: true, value: input as T, errors: [] };
  }

  return { valid: false, errors: normalizeErrors(validator.errors) };
}

export function validateRequestContract(
  input: unknown,
): ContractValidation<DeliverCheckRequest> {
  return validateContract<DeliverCheckRequest>(requestValidator, input);
}

export function validateResultContract(
  input: unknown,
): ContractValidation<DeliverCheckResult> {
  return validateContract<DeliverCheckResult>(resultValidator, input);
}

export function validateCandidate(
  candidate: unknown,
  targetSchema: JsonObject,
): CandidateValidation {
  const candidateAjv = new Ajv2020(ajvOptions);

  try {
    const schemaCopy = structuredClone(targetSchema);
    const validator = candidateAjv.compile(schemaCopy);
    const valid = validator(candidate);

    return {
      valid,
      errors: normalizeErrors(validator.errors),
      proves_factual_truth: false,
    };
  } catch (error: unknown) {
    return {
      valid: false,
      errors: [
        {
          instance_path: "",
          schema_path: "",
          keyword: "invalid_target_schema",
          message:
            error instanceof Error ? error.message : "Target schema compilation failed.",
        },
      ],
      proves_factual_truth: false,
    };
  }
}
