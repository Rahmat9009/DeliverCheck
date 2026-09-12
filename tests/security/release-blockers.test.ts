import { describe, expect, it } from "vitest";

import { repairJson } from "../../src/repair/engine.js";
import { resolveSlashDateToIso } from "../../src/repair/ambiguity.js";
import { setAt } from "../../src/repair/json-pointer.js";
import { parseExplicitRules } from "../../src/repair/rules.js";
import { MAX_EXPLICIT_RULES } from "../../src/repair/constants.js";
import { SERVICE_DEADLINE_MS } from "../../src/service/types.js";
import { createServiceHandlers } from "../../src/service/handlers.js";
import type { DeliverCheckRequest, JsonObject, JsonValue } from "../../src/types.js";
import { auditChanges } from "../../src/verify/diff.js";
import { assertSafeTargetSchema } from "../../src/verify/security.js";
import { validateCandidate } from "../../src/verify/validate.js";
import { verifyCandidate } from "../../src/verify/verifier.js";

const FIXED_NOW = () => 1_000;

function request(overrides: Partial<DeliverCheckRequest> = {}): DeliverCheckRequest {
  return {
    request_id: "release-blocker",
    input_format: "json",
    source_text: "{}",
    target_schema: { type: "object" },
    explicit_rules: ["The supplied JSON must meet the target schema."],
    ...overrides,
  };
}

describe("release blocker: exact leaf change declarations", () => {
  it("rejects a root declaration that hides discount tampering", () => {
    const original = { order_id: "A-1", status: "pending", discount: 0 };
    const candidate = { order_id: "A-1", status: "approved", discount: 90 };
    const audit = auditChanges(
      original,
      candidate,
      [{
        path: "",
        operation: "replace",
        before: original,
        after: candidate,
        justification: "The status normalization rule was applied.",
        rule_indexes: [0],
      }],
      1,
    );

    expect(audit.valid).toBe(false);
    expect(audit.undeclaredChanges.map((change) => change.path)).toEqual([
      "/status",
      "/discount",
    ]);
  });

  it("preserves exact add/remove evidence used for a legitimate rename", () => {
    const audit = auditChanges(
      { name: "Alice" },
      { full_name: "Alice" },
      [
        {
          path: "/name",
          operation: "remove",
          before: "Alice",
          justification: "Explicit rename.",
          rule_indexes: [0],
        },
        {
          path: "/full_name",
          operation: "add",
          after: "Alice",
          justification: "Explicit rename.",
          rule_indexes: [0],
        },
      ],
      1,
    );

    expect(audit.valid).toBe(true);
  });
});

describe("release blocker: constant rule parsing", () => {
  it("does not turn descriptive prose into constants or contradictions", () => {
    const parsed = parseExplicitRules(
      [
        "code must be uppercase letters.",
        "code must be three uppercase letters.",
        "currency must be QAR.",
        'status must be "DONE".',
      ],
      ["code", "currency", "status"],
    );
    const constants = parsed.directives.filter((directive) =>
      directive.kind === "constant_requirement"
    );

    expect(constants).toMatchObject([
      { field: "currency", value: "QAR", ruleIndex: 2 },
      { field: "status", value: "DONE", ruleIndex: 3 },
    ]);
    expect(parsed.contradictions).toEqual([]);
  });

  it("keeps already-valid descriptive-rule data at passed_checks", () => {
    const result = repairJson(request({
      source_text: JSON.stringify({ code: "ABC" }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } },
      },
      explicit_rules: [
        "code must be uppercase letters.",
        "code must be three uppercase letters.",
      ],
    }), { now: FIXED_NOW });

    expect(result.status).toBe("passed_checks");
  });
});

describe("release blocker: JSON Schema formats", () => {
  it.each([
    ["date", "2023-02-29", "2024-02-29"],
    ["date-time", "2024-02-30T10:00:00Z", "2024-02-29T10:00:00Z"],
    ["email", "not-an-email", "agent@example.com"],
    ["uri", "not a uri", "https://example.com/a?b=c"],
  ])("enforces the supported %s format", (format, invalid, valid) => {
    const schema: JsonObject = { type: "string", format };
    expect(validateCandidate(invalid, schema).valid).toBe(false);
    expect(validateCandidate(valid, schema).valid).toBe(true);
  });

  it("uses format validation during repair field checks", () => {
    const result = repairJson(request({
      source_text: JSON.stringify({ email: " agent@example.com " }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["email"],
        properties: { email: { type: "string", format: "email" } },
      },
      explicit_rules: ['Trim whitespace from "email".'],
    }), { now: FIXED_NOW });

    expect(result.status).toBe("passed_checks");
    if (result.status === "passed_checks") {
      expect(result.candidate).toEqual({ email: "agent@example.com" });
    }
  });

  it("uses format validation during independent verification", () => {
    const candidate = { delivery_date: "2023-02-29" };
    const report = verifyCandidate({
      request: request({
        source_text: JSON.stringify(candidate),
        target_schema: {
          type: "object",
          properties: { delivery_date: { type: "string", format: "date" } },
        },
      }),
      candidate,
      changes: [],
    });

    expect(report.valid).toBe(false);
    expect(report.detailedChecks).toContainEqual(
      expect.objectContaining({ name: "candidate_schema_validation", outcome: "failed" }),
    );
  });
});

describe("release blocker: recursive and unsafe schemas", () => {
  it("rejects a bare root self-reference", () => {
    expect(() => assertSafeTargetSchema({ $ref: "#" })).toThrow();
  });

  it.each(["$dynamicRef", "$recursiveRef"])("rejects %s", (keyword) => {
    expect(() => assertSafeTargetSchema({ [keyword]: "#/$defs/value" })).toThrow();
  });

  it("rejects cyclic local references through $defs", () => {
    expect(() => assertSafeTargetSchema({
      $defs: {
        a: { $ref: "#/$defs/b" },
        b: { $ref: "#/$defs/a" },
      },
      $ref: "#/$defs/a",
    })).toThrow();
  });

  it("permits bounded acyclic local references", () => {
    expect(() => assertSafeTargetSchema({
      type: "object",
      properties: { code: { $ref: "#/$defs/code" } },
      $defs: { code: { type: "string", pattern: "^[A-Z]{3}$" } },
    })).not.toThrow();
  });

  it("returns a sanitized schema-security diagnosis instead of recursing", async () => {
    const result = await createServiceHandlers().diagnose(request({
      target_schema: { $ref: "#" },
    }));
    expect(result).toMatchObject({
      outcome: "security_rejected",
      problems: [{ code: "invalid_target_schema" }],
    });
  });

  it("returns an invalid_target_schema verifier report instead of throwing", () => {
    const recursiveRequest = request({ target_schema: { $ref: "#" } });
    expect(() => verifyCandidate({
      request: recursiveRequest,
      candidate: {},
      changes: [],
    })).not.toThrow();
    const report = verifyCandidate({
      request: recursiveRequest,
      candidate: {},
      changes: [],
    });
    expect(report.valid).toBe(false);
    expect(report.status).toBe("cannot_repair");
    expect(report.unresolved).toContainEqual(
      expect.objectContaining({ code: "invalid_target_schema" }),
    );
  });

  it("sanitizes verifier schema-compilation faults", () => {
    const privateFormatName = "private-customer-format-name";
    const report = verifyCandidate({
      request: request({
        source_text: JSON.stringify({ value: "x" }),
        target_schema: {
          type: "object",
          properties: { value: { type: "string", format: privateFormatName } },
        },
      }),
      candidate: { value: "x" },
      changes: [],
    });

    expect(report.valid).toBe(false);
    expect(JSON.stringify(report.checks)).not.toContain(privateFormatName);
    expect(JSON.stringify(report.unresolved)).not.toContain(privateFormatName);
    expect(report.unresolved).toContainEqual({
      code: "invalid_target_schema",
      message: "Target schema was rejected or could not be compiled safely.",
    });
  });

  it.each([
    "^(a+)+$",
    "^(a|aa)+$",
    `^${"a".repeat(300)}$`,
  ])("rejects an unsafe or excessive pattern", (pattern) => {
    expect(() => assertSafeTargetSchema({ type: "string", pattern })).toThrow();
  });

  it("applies the same pattern policy to patternProperties", () => {
    expect(() => assertSafeTargetSchema({
      type: "object",
      patternProperties: { "^(a+)+$": { type: "string" } },
    })).toThrow();
  });
});

describe("release blocker: JSON pointer mutation", () => {
  it.each([
    [JSON.parse("{}") as JsonValue, "/__proto__"],
    [JSON.parse('{"constructor":{}}') as JsonValue, "/constructor/value"],
    [JSON.parse('{"safe":{"prototype":{}}}') as JsonValue, "/safe/prototype/value"],
  ])("rejects every unsafe pointer segment in %s", (root, pointer) => {
    expect(() => setAt(root, pointer, { polluted: true })).toThrow(/unsafe/i);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("release blocker: real calendar dates", () => {
  it("rejects impossible and non-leap slash dates", () => {
    expect(resolveSlashDateToIso("31/02/2024", "DMY")).toBeNull();
    expect(resolveSlashDateToIso("29/02/2023", "DMY")).toBeNull();
  });

  it("preserves a valid leap date", () => {
    expect(resolveSlashDateToIso("29/02/2024", "DMY")).toBe("2024-02-29");
  });
});

describe("release blocker: root definitions in field validation", () => {
  it.each(["$defs", "definitions"])("repairs a field that uses %s", (keyword) => {
    const result = repairJson(request({
      source_text: JSON.stringify({ code: " ABC " }),
      target_schema: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: { code: { $ref: `#/${keyword}/code` } },
        [keyword]: { code: { type: "string", pattern: "^[A-Z]{3}$" } },
      },
      explicit_rules: ['Trim whitespace from "code".'],
    }), { now: FIXED_NOW });

    expect(result.status).toBe("passed_checks");
    if (result.status === "passed_checks") {
      expect(result.candidate).toEqual({ code: "ABC" });
    }
  });
});

describe("release blocker: explicit rule limit", () => {
  it("refuses all rules when the documented limit is exceeded", () => {
    const result = repairJson(request({
      explicit_rules: Array.from(
        { length: MAX_EXPLICIT_RULES + 1 },
        (_, index) => `Context note ${index}.`,
      ),
    }), { now: FIXED_NOW });

    expect(result.status).toBe("cannot_repair");
    expect(result.unresolved[0]?.message).toContain(String(MAX_EXPLICIT_RULES));
  });

  it("rejects over-limit service requests with the actual limit", async () => {
    await expect(createServiceHandlers().diagnose(request({
      explicit_rules: Array.from(
        { length: MAX_EXPLICIT_RULES + 1 },
        (_, index) => `Context note ${index}.`,
      ),
    }))).rejects.toMatchObject({
      code: "explicit_rule_limit_exceeded",
      message: expect.stringContaining(String(MAX_EXPLICIT_RULES)),
    });
  });
});

describe("release blocker: deployment deadline margin", () => {
  it("uses a 240-second internal application deadline", () => {
    expect(SERVICE_DEADLINE_MS).toBe(240_000);
  });
});
