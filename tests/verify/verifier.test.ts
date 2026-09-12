import { describe, expect, it } from "vitest";
import validRequest from "../fixtures/request.valid.json" with { type: "json" };
import passedResult from "../fixtures/result.passed.json" with { type: "json" };
import needsInfoResult from "../fixtures/result.needs-information.json" with {
  type: "json",
};
import cannotRepairResult from "../fixtures/result.cannot-repair.json" with {
  type: "json",
};
import {
  computeCanonicalHash,
  computeOriginalHash,
} from "../../src/verify/canonical.js";
import {
  deepFreeze,
  verifyCandidate,
  verifyDeliverCheckResult,
} from "../../src/verify/verifier.js";
import type { DeliverCheckRequest } from "../../src/types.js";

describe("Independent Candidate Verifier", () => {
  it("verifies a valid candidate and produces machine-readable checks with proves_factual_truth: false", () => {
    const request = validRequest as DeliverCheckRequest;
    const candidate = {
      invoice_id: "000123",
      currency: "QAR",
      amount: "17.50",
    };
    const declaredChanges = [
      {
        path: "/invoice_id",
        operation: "replace" as const,
        before: 123,
        after: "000123",
        justification: "Explicit rule 0 defines a six-character identifier and requires preserving leading zeros.",
        rule_indexes: [0],
      },
    ];

    const report = verifyCandidate({
      request,
      candidate,
      changes: declaredChanges,
    });

    expect(report.valid).toBe(true);
    expect(report.status).toBe("passed_checks");
    expect(report.proves_factual_truth).toBe(false);
    expect(report.unresolved).toHaveLength(0);

    // Verify machine-readable detailedChecks
    expect(report.detailedChecks.length).toBeGreaterThan(0);
    for (const check of report.detailedChecks) {
      expect(check.outcome).toBe("passed");
      expect(check.method).toBeDefined();
      expect(check.diagnostic).toBeDefined();
      expect(check.evidence).toBeDefined();
      expect(check.proves_factual_truth).toBe(false);
    }

    // Verify contract checks
    for (const check of report.checks) {
      expect(check.status).toBe("passed");
      expect(check.evidence).toBeDefined();
      expect(check.proves_factual_truth).toBe(false);
    }

    // Verify hashes
    expect(report.hashes.original).toBe(computeOriginalHash(request.source_text));
    expect(report.hashes.schema).toBe(computeCanonicalHash(request.target_schema));
    expect(report.hashes.candidate).toBe(computeCanonicalHash(candidate));
    expect(report.hashMatches.original).toBe(true);
    expect(report.hashMatches.schema).toBe(true);
    expect(report.hashMatches.candidate).toBe(true);
  });

  it("never modifies the candidate or target schema", () => {
    const request = structuredClone(validRequest) as DeliverCheckRequest;
    const candidate = {
      invoice_id: "000123",
      currency: "QAR",
      amount: "17.50",
    };

    deepFreeze(candidate);
    deepFreeze(request.target_schema);

    const beforeCand = structuredClone(candidate);
    const beforeSchema = structuredClone(request.target_schema);

    const report = verifyCandidate({
      request,
      candidate,
      changes: [
        {
          path: "/invoice_id",
          operation: "replace",
          before: 123,
          after: "000123",
          justification: "Zero pad",
          rule_indexes: [0],
        },
      ],
    });

    expect(report.valid).toBe(true);
    expect(candidate).toEqual(beforeCand);
    expect(request.target_schema).toEqual(beforeSchema);
  });

  it("fails verification when candidate does not match schema", () => {
    const request = validRequest as DeliverCheckRequest;
    const invalidCandidate = {
      invoice_id: "123", // Needs 6 digits per pattern ^[0-9]{6}$
      currency: "QAR",
      amount: "17.50",
    };

    const report = verifyCandidate({
      request,
      candidate: invalidCandidate,
      changes: [],
    });

    expect(report.valid).toBe(false);
    expect(report.unresolved.some((u) => u.code === "schema_violation")).toBe(true);
    const schemaCheck = report.detailedChecks.find(
      (c) => c.name === "candidate_schema_validation",
    );
    expect(schemaCheck?.outcome).toBe("failed");
  });

  it("fails verification on candidate_hash mismatch", () => {
    const request = validRequest as DeliverCheckRequest;
    const candidate = {
      invoice_id: "000123",
      currency: "QAR",
      amount: "17.50",
    };

    const report = verifyCandidate({
      request,
      candidate,
      candidateHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      changes: [
        {
          path: "/invoice_id",
          operation: "replace",
          before: 123,
          after: "000123",
          justification: "Pad",
          rule_indexes: [0],
        },
      ],
    });

    expect(report.valid).toBe(false);
    expect(report.hashMatches.candidate).toBe(false);
    const hashCheck = report.detailedChecks.find(
      (c) => c.name === "candidate_hash_verification",
    );
    expect(hashCheck?.outcome).toBe("failed");
  });

  it("fails verification when undeclared changes exist in candidate", () => {
    const request = validRequest as DeliverCheckRequest;
    const candidate = {
      invoice_id: "000123",
      currency: "QAR",
      amount: "20.00", // Undeclared change from 17.50!
    };

    const report = verifyCandidate({
      request,
      candidate,
      changes: [
        {
          path: "/invoice_id",
          operation: "replace",
          before: 123,
          after: "000123",
          justification: "Zero pad",
          rule_indexes: [0],
        },
      ],
    });

    expect(report.valid).toBe(false);
    const auditCheck = report.detailedChecks.find(
      (c) => c.name === "change_evidence_audit",
    );
    expect(auditCheck?.outcome).toBe("failed");
    expect(report.changeAudit?.undeclaredChanges).toHaveLength(1);
    expect(report.changeAudit?.undeclaredChanges[0]?.path).toBe("/amount");
  });

  it("verifies deliver check result fixtures correctly", () => {
    const request = validRequest as DeliverCheckRequest;
    const resultWithActualHashes = {
      ...passedResult,
      original_hash: computeOriginalHash(request.source_text),
      schema_hash: computeCanonicalHash(request.target_schema),
      candidate_hash: computeCanonicalHash(passedResult.candidate),
    };

    const passedReport = verifyDeliverCheckResult(request, resultWithActualHashes as any);
    expect(passedReport.valid).toBe(true);
    expect(passedReport.status).toBe("passed_checks");

    const needsInfoRequest: DeliverCheckRequest = {
      request_id: "req-date-1",
      input_format: "json",
      source_text: "{\"delivery_date\":\"03/04/2026\"}",
      target_schema: {
        type: "object",
        required: ["delivery_date"],
        properties: { "delivery_date": { "type": "string" } },
      },
      explicit_rules: ["date must be formatted."],
    };
    const needsInfoWithActualHashes = {
      ...needsInfoResult,
      original_hash: computeOriginalHash(needsInfoRequest.source_text),
      schema_hash: computeCanonicalHash(needsInfoRequest.target_schema),
    };

    const needsInfoReport = verifyDeliverCheckResult(needsInfoRequest, needsInfoWithActualHashes as any);
    expect(needsInfoReport.status).toBe("needs_information");

    const cannotRepairRequest: DeliverCheckRequest = {
      request_id: "req-invalid-1",
      input_format: "json",
      source_text: "{\"unclosed",
      target_schema: { type: "object" },
      explicit_rules: ["valid object required."],
    };
    const cannotRepairWithActualHashes = {
      ...cannotRepairResult,
      original_hash: computeOriginalHash(cannotRepairRequest.source_text),
      schema_hash: computeCanonicalHash(cannotRepairRequest.target_schema),
    };

    const cannotRepairReport = verifyDeliverCheckResult(cannotRepairRequest, cannotRepairWithActualHashes as any);
    expect(cannotRepairReport.status).toBe("cannot_repair");
  });
});
