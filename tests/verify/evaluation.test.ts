import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCandidate } from "../../src/verify/verifier.js";
import {
  assertSafeStructure,
  assertSafeTargetSchema,
  SecurityViolationError,
} from "../../src/verify/security.js";
import type { DeliverCheckRequest } from "../../src/types.js";

const CASES_DIR = join(process.cwd(), "evaluation", "cases");

describe("Held-out Evaluation Cases", () => {
  const caseFiles = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json"));

  it("has at least 12 held-out evaluation cases", () => {
    expect(caseFiles.length).toBeGreaterThanOrEqual(12);
  });

  for (const caseFile of caseFiles) {
    const filePath = join(CASES_DIR, caseFile);
    const caseData = JSON.parse(readFileSync(filePath, "utf8"));

    it(`evaluates ${caseData.case_id}: ${caseData.name}`, () => {
      // Depth bomb case handling
      if (caseData.depth_bomb) {
        let deep: any = { leaf: true };
        for (let i = 0; i < caseData.depth; i++) {
          deep = { nested: deep };
        }
        expect(() => assertSafeStructure(deep, { maxDepth: 32 })).toThrowError(
          SecurityViolationError,
        );
        return;
      }

      // Security error expected in schema or payload
      if (caseData.expected_outcome?.security_error === "prototype_pollution_key") {
        expect(() => assertSafeStructure(caseData.candidate)).toThrowError(
          SecurityViolationError,
        );
        return;
      }

      if (caseData.expected_outcome?.security_error === "unsupported_remote_reference") {
        expect(() =>
          assertSafeTargetSchema(caseData.request.target_schema),
        ).toThrowError(SecurityViolationError);
        return;
      }

      const report = verifyCandidate({
        request: caseData.request as DeliverCheckRequest,
        candidate: caseData.candidate,
        candidateHash: caseData.declared_candidate_hash,
        changes: caseData.declared_changes,
      });

      if (caseData.expected_outcome.status === "passed_checks") {
        expect(report.valid).toBe(true);
        expect(report.status).toBe("passed_checks");
        expect(report.unresolved).toHaveLength(0);
      } else if (caseData.expected_outcome.valid === false) {
        expect(report.valid).toBe(false);

        if (caseData.expected_outcome.failed_check) {
          const check = report.detailedChecks.find(
            (c) => c.name === caseData.expected_outcome.failed_check,
          );
          expect(check?.outcome).toBe("failed");
        }

        if (caseData.expected_outcome.has_undeclared_changes) {
          expect(report.changeAudit?.undeclaredChanges.length).toBeGreaterThan(0);
        }
      }
    });
  }
});
