import { describe, expect, it } from "vitest";

import validRequestFixture from "../fixtures/request.valid.json" with { type: "json" };
import { MAX_CHANGE_OPERATIONS } from "../../src/repair/constants.js";
import { repairJson } from "../../src/repair/engine.js";
import { validateResultContract } from "../../src/verify/validate.js";
import type { DeliverCheckRequest, JsonObject } from "../../src/types.js";

const FIXED_NOW = () => 1_000;

function request(overrides: Partial<DeliverCheckRequest>): DeliverCheckRequest {
  return {
    request_id: "req-test",
    input_format: "json",
    source_text: "{}",
    target_schema: {},
    explicit_rules: ["a rule must exist."],
    ...overrides,
  };
}

describe("repairJson - golden path (leading-zero identifier)", () => {
  const validRequest = validRequestFixture as DeliverCheckRequest;

  it("pads a numeric invoice id into the required six-digit string", () => {
    const result = repairJson(validRequest, { now: FIXED_NOW });

    expect(result.status).toBe("passed_checks");
    expect(validateResultContract(result).valid).toBe(true);
    if (result.status !== "passed_checks") throw new Error("expected passed_checks");

    expect(result.candidate).toEqual({ invoice_id: "000123", currency: "QAR", amount: "17.50" });
    expect(result.changes).toEqual([
      {
        path: "/invoice_id",
        operation: "replace",
        before: 123,
        after: "000123",
        justification: "Explicit rule 0 defines a 6-character identifier and requires preserving leading zeros.",
        rule_indexes: [0],
      },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("never mutates the caller's request object", () => {
    const before = structuredClone(validRequest);
    repairJson(validRequest, { now: FIXED_NOW });
    expect(validRequest).toEqual(before);
  });

  it("is deterministic across repeated runs on identical input", () => {
    const first = repairJson(validRequest, { now: FIXED_NOW });
    const second = repairJson(validRequest, { now: FIXED_NOW });
    expect(second).toEqual(first);
  });

  it("does not let a mutated result leak into the next run", () => {
    const first = repairJson(validRequest, { now: FIXED_NOW });
    if (first.status === "passed_checks" && typeof first.candidate === "object" && first.candidate !== null) {
      (first.candidate as JsonObject)["invoice_id"] = "TAMPERED";
    }
    const second = repairJson(validRequest, { now: FIXED_NOW });
    expect(second.status).toBe("passed_checks");
    if (second.status === "passed_checks") {
      expect(second.candidate).toEqual({ invoice_id: "000123", currency: "QAR", amount: "17.50" });
    }
  });

  it("refuses to pad an identifier that would need truncation to fit", () => {
    const overflow = request({
      source_text: JSON.stringify({ invoice_id: 1234567, currency: "QAR", amount: "1.00" }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["invoice_id", "currency", "amount"],
        properties: {
          invoice_id: { type: "string", pattern: "^[0-9]{6}$" },
          currency: { const: "QAR" },
          amount: { type: "string", pattern: "^[0-9]+\\.[0-9]{2}$" },
        },
      },
      explicit_rules: ["invoice_id is a six-character identifier and meaningful leading zeros must be preserved."],
    });

    const result = repairJson(overflow, { now: FIXED_NOW });
    expect(result.status).toBe("cannot_repair");
    if (result.status === "cannot_repair") {
      expect(result.unresolved.map((issue) => issue.code)).toContain("schema_violation");
      expect(result).not.toHaveProperty("candidate");
    }
  });
});

describe("repairJson - already-valid data", () => {
  it("returns passed_checks with no changes when the source already conforms", () => {
    const req = request({
      source_text: JSON.stringify({ invoice_id: "000123", currency: "QAR", amount: "17.50" }),
      target_schema: validRequestFixture.target_schema as JsonObject,
      explicit_rules: validRequestFixture.explicit_rules,
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("passed_checks");
    expect(result.changes).toEqual([]);
    if (result.status === "passed_checks") {
      expect(result.candidate).toEqual({ invoice_id: "000123", currency: "QAR", amount: "17.50" });
    }
  });
});

describe("repairJson - supported transformations", () => {
  it("applies an explicit field rename", () => {
    const req = request({
      source_text: JSON.stringify({ name: "Alice" }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["full_name"],
        properties: { full_name: { type: "string" } },
      },
      explicit_rules: ['Rename field "name" to "full_name".'],
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("passed_checks");
    if (result.status === "passed_checks") {
      expect(result.candidate).toEqual({ full_name: "Alice" });
    }
    expect(result.changes).toEqual([
      {
        path: "/name",
        operation: "remove",
        before: "Alice",
        justification: 'Explicit rule 0 renames "name" to "full_name".',
        rule_indexes: [0],
      },
      {
        path: "/full_name",
        operation: "add",
        after: "Alice",
        justification: 'Explicit rule 0 renames "name" to "full_name".',
        rule_indexes: [0],
      },
    ]);
  });

  it("applies an explicitly requested field movement", () => {
    const req = request({
      source_text: JSON.stringify({ address: { zip: "12345" } }),
      target_schema: {
        type: "object",
        additionalProperties: true,
        required: ["zip"],
        properties: { zip: { type: "string" } },
      },
      explicit_rules: ['Move "/address/zip" to "/zip".'],
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("passed_checks");
    if (result.status === "passed_checks") {
      expect(result.candidate).toMatchObject({ zip: "12345" });
    }
  });

  it("applies explicit enum normalization", () => {
    const req = request({
      source_text: JSON.stringify({ status: "done" }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string", enum: ["complete", "pending"] } },
      },
      explicit_rules: ['Normalize "status" value "done" to "complete".'],
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("passed_checks");
    if (result.status === "passed_checks") {
      expect(result.candidate).toEqual({ status: "complete" });
    }
  });

  it("trims accidental surrounding whitespace only when a rule permits it", () => {
    const req = request({
      source_text: JSON.stringify({ code: " ABC " }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } },
      },
      explicit_rules: ['Trim whitespace from "code".'],
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("passed_checks");
    if (result.status === "passed_checks") {
      expect(result.candidate).toEqual({ code: "ABC" });
    }
  });

  it("does not trim whitespace without a permitting rule", () => {
    const req = request({
      source_text: JSON.stringify({ code: " ABC " }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } },
      },
      explicit_rules: ["code must be three uppercase letters."],
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("cannot_repair");
  });

  it("resolves an ambiguous date once a rule fixes the day/month order", () => {
    const req = request({
      source_text: JSON.stringify({ delivery_date: "03/04/2026" }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["delivery_date"],
        properties: { delivery_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
      },
      explicit_rules: ['Dates in "delivery_date" use the format DD/MM/YYYY.'],
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("passed_checks");
    if (result.status === "passed_checks") {
      expect(result.candidate).toEqual({ delivery_date: "2026-04-03" });
    }
  });
});

describe("repairJson - needs_information", () => {
  it("flags a missing required fact", () => {
    const req = request({
      source_text: JSON.stringify({ currency: "QAR" }),
      target_schema: {
        type: "object",
        additionalProperties: true,
        required: ["customer_id", "currency"],
        properties: {
          customer_id: { type: "string" },
          currency: { const: "QAR" },
        },
      },
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("needs_information");
    expect(result.unresolved).toEqual([
      {
        code: "missing_fact",
        message: 'Required field "customer_id" is missing from the source and no rule supplies it.',
        path: "/customer_id",
      },
    ]);
    expect(result).not.toHaveProperty("candidate");
  });

  it("flags an ambiguous date with no disambiguating rule", () => {
    const req = request({
      source_text: JSON.stringify({ delivery_date: "03/04/2026" }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["delivery_date"],
        properties: { delivery_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
      },
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("needs_information");
    expect(result.unresolved).toEqual([
      {
        code: "ambiguous_date",
        message: 'Specify whether "03/04/2026" means day/month or month/day order for "delivery_date".',
        path: "/delivery_date",
      },
    ]);
  });

  it("flags an ambiguous comma-formatted number with no disambiguating rule", () => {
    const req = request({
      source_text: JSON.stringify({ amount: "1,234" }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["amount"],
        properties: { amount: { type: "string", pattern: "^[0-9]+\\.[0-9]{2}$" } },
      },
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("needs_information");
    expect(result.unresolved[0]?.code).toBe("ambiguous_number");
  });

  it("flags an ambiguous currency symbol with no pinning rule", () => {
    const req = request({
      source_text: JSON.stringify({ currency: "$" }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["currency"],
        properties: { currency: { type: "string", enum: ["USD", "EUR", "GBP"] } },
      },
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("needs_information");
    expect(result.unresolved[0]?.code).toBe("ambiguous_currency");
  });

  it("flags contradictory explicit rules for the same field", () => {
    const req = request({
      source_text: JSON.stringify({ currency: "EUR" }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["currency"],
        properties: { currency: { const: "QAR" } },
      },
      explicit_rules: ["currency must be QAR.", "currency must be USD."],
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("needs_information");
    expect(result.unresolved).toEqual([
      {
        code: "contradictory_requirements",
        message: 'Explicit rules disagree about the required value of "currency": "QAR" vs. "USD".',
        path: "/currency",
        rule_indexes: [0, 1],
      },
    ]);
  });
});

describe("repairJson - cannot_repair", () => {
  it("rejects unparseable source JSON", () => {
    const req = request({ source_text: "{not json" });
    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("cannot_repair");
    expect(result.unresolved[0]?.code).toBe("invalid_source_json");
    expect(result).not.toHaveProperty("candidate");
  });

  it("rejects a target schema ajv cannot compile", () => {
    const req = request({
      source_text: "{}",
      target_schema: { type: "not-a-json-schema-type" },
    });
    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("cannot_repair");
    expect(result.unresolved[0]?.code).toBe("invalid_target_schema");
  });

  it("rejects source JSON containing a reserved prototype key", () => {
    const req = request({ source_text: '{"__proto__": {"polluted": true}}' });
    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("cannot_repair");
    expect(result.unresolved[0]).toMatchObject({ code: "schema_violation", path: "/__proto__" });
  });

  it("rejects a rule that targets a reserved key as a rename destination", () => {
    const req = request({
      source_text: JSON.stringify({ name: "Alice" }),
      target_schema: { type: "object", properties: { name: { type: "string" } } },
      explicit_rules: ['Rename field "name" to "__proto__".'],
    });
    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("cannot_repair");
    expect(result.unresolved[0]).toMatchObject({ code: "schema_violation", rule_indexes: [0] });
  });

  it("does not guess a schema-mismatched value with no supporting rule", () => {
    const req = request({
      source_text: JSON.stringify({ status: "done" }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string", enum: ["complete", "pending"] } },
      },
      explicit_rules: ["status must be a recognized lifecycle stage."],
    });
    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("cannot_repair");
    expect(result.unresolved[0]?.code).toBe("schema_violation");
  });
});

describe("repairJson - operation budget", () => {
  it("stops and reports cannot_repair once the change budget is exceeded", () => {
    const fieldCount = MAX_CHANGE_OPERATIONS + 5;
    const properties: JsonObject = {};
    const sourceObject: Record<string, string> = {};
    const rules: string[] = [];
    for (let i = 0; i < fieldCount; i += 1) {
      const key = `field_${i}`;
      properties[key] = { type: "string", const: "OK" };
      sourceObject[key] = "no";
      rules.push(`${key} must be OK.`);
    }

    const req = request({
      source_text: JSON.stringify(sourceObject),
      target_schema: { type: "object", additionalProperties: false, properties },
      explicit_rules: rules,
    });

    const result = repairJson(req, { now: FIXED_NOW });
    expect(result.status).toBe("cannot_repair");
    expect(result.changes).toHaveLength(MAX_CHANGE_OPERATIONS);
    expect(result.unresolved.some((issue) => issue.message.includes("exceeded the maximum"))).toBe(true);
  });
});
