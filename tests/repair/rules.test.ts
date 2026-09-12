import { describe, expect, it } from "vitest";

import { parseExplicitRules } from "../../src/repair/rules.js";

describe("parseExplicitRules", () => {
  it("parses a rename directive", () => {
    const { directives } = parseExplicitRules(['rename field "name" to "full_name".'], ["name", "full_name"]);
    expect(directives).toEqual([{ kind: "rename", ruleIndex: 0, from: "name", to: "full_name" }]);
  });

  it("parses a move directive", () => {
    const { directives } = parseExplicitRules(['move "/address/zip" to "/zip".'], []);
    expect(directives).toEqual([{ kind: "move", ruleIndex: 0, from: "/address/zip", to: "/zip" }]);
  });

  it("parses an enum normalization directive", () => {
    const { directives } = parseExplicitRules(['normalize "status" value "done" to "complete".'], []);
    expect(directives).toEqual([
      { kind: "enum_normalize", ruleIndex: 0, field: "status", fromValue: "done", toValue: "complete" },
    ]);
  });

  it("parses a whitespace-trim directive scoped to one field", () => {
    const { directives } = parseExplicitRules(['Trim whitespace from "code".'], []);
    expect(directives).toEqual([{ kind: "trim_whitespace", ruleIndex: 0, field: "code" }]);
  });

  it("parses a whitespace-trim directive scoped to all fields", () => {
    const { directives } = parseExplicitRules(["Remove surrounding whitespace from all fields."], []);
    expect(directives).toEqual([{ kind: "trim_whitespace", ruleIndex: 0, field: "*" }]);
  });

  it("ties a leading-zero sentence to a known schema field", () => {
    const { directives } = parseExplicitRules(
      ["invoice_id is a six-character identifier and meaningful leading zeros must be preserved."],
      ["invoice_id", "currency"],
    );
    expect(directives).toEqual([{ kind: "identifier_preserve", ruleIndex: 0, field: "invoice_id" }]);
  });

  it("parses a date-format directive", () => {
    const { directives } = parseExplicitRules(['Dates in "delivery_date" use the format DD/MM/YYYY.'], []);
    expect(directives).toEqual([{ kind: "date_format", ruleIndex: 0, field: "delivery_date", order: "DMY" }]);
  });

  it("parses a constant-requirement directive", () => {
    const { directives } = parseExplicitRules(["currency must be QAR."], []);
    expect(directives).toEqual([{ kind: "constant_requirement", ruleIndex: 0, field: "currency", value: "QAR" }]);
  });

  it("leaves purely descriptive prose with no matching directive", () => {
    const { directives } = parseExplicitRules(["amount is a decimal string with exactly two fractional digits."], []);
    expect(directives).toEqual([]);
  });

  it("detects contradictory constant requirements for the same field", () => {
    const { contradictions } = parseExplicitRules(["currency must be QAR.", "currency must be USD."], []);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]).toMatchObject({
      code: "contradictory_requirements",
      path: "/currency",
      rule_indexes: [0, 1],
    });
  });

  it("does not flag matching constant requirements as contradictory", () => {
    const { contradictions } = parseExplicitRules(["currency must be QAR.", "currency must be QAR."], []);
    expect(contradictions).toEqual([]);
  });
});
