import { describe, expect, it } from "vitest";

import validRequest from "./fixtures/request.valid.json" with { type: "json" };
import cannotRepairResult from "./fixtures/result.cannot-repair.json" with {
  type: "json",
};
import needsInformationResult from "./fixtures/result.needs-information.json" with {
  type: "json",
};
import passedResult from "./fixtures/result.passed.json" with { type: "json" };
import {
  validateCandidate,
  validateRequestContract,
  validateResultContract,
} from "../src/verify/validate.js";

describe("request contract", () => {
  it("accepts the version 1 JSON request fixture", () => {
    expect(validateRequestContract(validRequest)).toEqual({
      valid: true,
      value: validRequest,
      errors: [],
    });
  });

  it("rejects CSV and unknown properties", () => {
    const request = {
      ...validRequest,
      input_format: "csv",
      undocumented: true,
    };

    const result = validateRequestContract(request);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((error) => error.keyword)).toEqual(
        expect.arrayContaining(["additionalProperties", "const"]),
      );
    }
  });

  it("does not coerce request identifiers or remove extra data", () => {
    const request = {
      ...validRequest,
      request_id: 123,
      extra: "must remain",
    };
    const before = structuredClone(request);

    expect(validateRequestContract(request).valid).toBe(false);
    expect(request).toEqual(before);
  });
});

describe("result contract", () => {
  it("accepts evidence-bearing fixtures for all three statuses", () => {
    expect(validateResultContract(passedResult).valid).toBe(true);
    expect(validateResultContract(needsInformationResult).valid).toBe(true);
    expect(validateResultContract(cannotRepairResult).valid).toBe(true);
  });

  it("rejects passed_checks without a candidate hash", () => {
    const { candidate_hash: _candidateHash, ...invalid } = passedResult;

    expect(validateResultContract(invalid).valid).toBe(false);
  });

  it("rejects a failed check under passed_checks", () => {
    const invalid = structuredClone(passedResult);
    invalid.checks[0]!.status = "failed";

    expect(validateResultContract(invalid).valid).toBe(false);
  });

  it("rejects a candidate under cannot_repair", () => {
    const invalid = {
      ...needsInformationResult,
      status: "cannot_repair",
      candidate: { value: "unsupported" },
    };

    expect(validateResultContract(invalid).valid).toBe(false);
  });

  it.each([
    "ambiguous_date",
    "ambiguous_number",
    "ambiguous_currency",
    "contradictory_requirements",
    "missing_fact",
  ] as const)("requires needs_information for %s", (code) => {
    const invalid = structuredClone(needsInformationResult);
    invalid.status = "cannot_repair";
    invalid.unresolved[0]!.code = code;

    expect(validateResultContract(invalid).valid).toBe(false);
  });
});

describe("candidate validation", () => {
  it("validates without applying defaults or removing properties", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["identifier", "country"],
      properties: {
        identifier: { type: "string" },
        country: { type: "string", default: "QA" },
      },
    };
    const candidate = { identifier: "000123", extra: "keep me" };
    const before = structuredClone(candidate);

    const result = validateCandidate(candidate, schema);

    expect(result.valid).toBe(false);
    expect(result.proves_factual_truth).toBe(false);
    expect(candidate).toEqual(before);
    expect(candidate).not.toHaveProperty("country");
    expect(candidate).toHaveProperty("extra", "keep me");
  });

  it("does not coerce meaningful identifiers", () => {
    const candidate = { identifier: 123 };
    const result = validateCandidate(candidate, {
      type: "object",
      required: ["identifier"],
      properties: { identifier: { type: "string", pattern: "^[0-9]{6}$" } },
    });

    expect(result.valid).toBe(false);
    expect(candidate.identifier).toBe(123);
  });

  it("reports an invalid target schema without changing it", () => {
    const schema = { type: "not-a-json-schema-type" };
    const before = structuredClone(schema);

    const result = validateCandidate({}, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.keyword).toBe("invalid_target_schema");
    expect(schema).toEqual(before);
  });
});
