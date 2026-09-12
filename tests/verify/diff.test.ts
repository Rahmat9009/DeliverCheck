import { describe, expect, it } from "vitest";
import {
  auditChanges,
  buildPointer,
  computeActualDiffs,
  getValueAtPointer,
  parsePointer,
} from "../../src/verify/diff.js";
import type { ChangeEvidence } from "../../src/types.js";

describe("RFC 6901 JSON Pointer handling", () => {
  it("encodes and parses JSON pointers with escaping", () => {
    expect(buildPointer([])).toBe("");
    expect(buildPointer(["a", "b"])).toBe("/a/b");
    expect(buildPointer(["a/b", "c~d"])).toBe("/a~1b/c~0d");

    expect(parsePointer("")).toEqual([]);
    expect(parsePointer("/a/b")).toEqual(["a", "b"]);
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
  });

  it("retrieves values at pointer location", () => {
    const doc = {
      nested: {
        list: [10, 20, 30],
        key: "value",
      },
    };

    expect(getValueAtPointer(doc, "")).toEqual({ found: true, value: doc });
    expect(getValueAtPointer(doc, "/nested/key")).toEqual({ found: true, value: "value" });
    expect(getValueAtPointer(doc, "/nested/list/1")).toEqual({ found: true, value: 20 });
    expect(getValueAtPointer(doc, "/nested/list/5")).toEqual({ found: false });
    expect(getValueAtPointer(doc, "/nonexistent")).toEqual({ found: false });
  });
});

describe("Structural Diff and Change Audit", () => {
  it("computes diff between original and modified candidate", () => {
    const original = { id: 123, status: "pending" };
    const candidate = { id: "000123", status: "pending", verified: true };

    const diffs = computeActualDiffs(original, candidate);
    expect(diffs).toEqual([
      { path: "/id", operation: "replace", before: 123, after: "000123" },
      { path: "/verified", operation: "add", after: true },
    ]);
  });

  it("passes audit when declared changes match actual diff exactly", () => {
    const original = { id: 123, status: "pending" };
    const candidate = { id: "000123", status: "pending" };

    const declared: ChangeEvidence[] = [
      {
        path: "/id",
        operation: "replace",
        before: 123,
        after: "000123",
        justification: "Zero pad id to 6 digits",
        rule_indexes: [0],
      },
    ];

    const audit = auditChanges(original, candidate, declared, 1);
    expect(audit.valid).toBe(true);
    expect(audit.mismatchedChanges).toHaveLength(0);
    expect(audit.undeclaredChanges).toHaveLength(0);
    expect(audit.spuriousChanges).toHaveLength(0);
  });

  it("detects undeclared changes", () => {
    const original = { id: 123, price: "100.00" };
    const candidate = { id: "000123", price: "80.00" }; // price secretly changed!

    const declared: ChangeEvidence[] = [
      {
        path: "/id",
        operation: "replace",
        before: 123,
        after: "000123",
        justification: "Zero pad id",
        rule_indexes: [0],
      },
    ];

    const audit = auditChanges(original, candidate, declared, 1);
    expect(audit.valid).toBe(false);
    expect(audit.undeclaredChanges).toHaveLength(1);
    expect(audit.undeclaredChanges[0]?.path).toBe("/price");
    expect(audit.undeclaredChanges[0]?.operation).toBe("replace");
  });

  it("detects mismatched before value in declared change", () => {
    const original = { id: 123 };
    const candidate = { id: "000123" };

    const declared: ChangeEvidence[] = [
      {
        path: "/id",
        operation: "replace",
        before: 999, // Wrong before value!
        after: "000123",
        justification: "Zero pad id",
        rule_indexes: [0],
      },
    ];

    const audit = auditChanges(original, candidate, declared, 1);
    expect(audit.valid).toBe(false);
    expect(audit.mismatchedChanges).toHaveLength(1);
    expect(audit.mismatchedChanges[0]?.reason).toContain("declared 'before' does not match");
  });

  it("detects out-of-bounds rule_indexes", () => {
    const original = { id: 123 };
    const candidate = { id: "000123" };

    const declared: ChangeEvidence[] = [
      {
        path: "/id",
        operation: "replace",
        before: 123,
        after: "000123",
        justification: "Zero pad id",
        rule_indexes: [5], // Rules count is 1, so index 5 is out of bounds
      },
    ];

    const audit = auditChanges(original, candidate, declared, 1);
    expect(audit.valid).toBe(false);
    expect(audit.mismatchedChanges).toHaveLength(1);
    expect(audit.mismatchedChanges[0]?.reason).toContain("rule_index 5 is out of bounds");
  });

  it("detects spurious declared change when document was not modified", () => {
    const original = { id: "000123" };
    const candidate = { id: "000123" };

    const declared: ChangeEvidence[] = [
      {
        path: "/id",
        operation: "replace",
        before: "000123",
        after: "000123",
        justification: "No-op declared replace",
        rule_indexes: [0],
      },
    ];

    const audit = auditChanges(original, candidate, declared, 1);
    expect(audit.valid).toBe(false);
    expect(audit.spuriousChanges).toHaveLength(1);
  });
});
