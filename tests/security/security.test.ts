import { describe, expect, it } from "vitest";
import ambiguityFixture from "./fixtures/ambiguity.json" with { type: "json" };
import leadingZerosFixture from "./fixtures/leading_zeros.json" with {
  type: "json",
};
import missingFactsFixture from "./fixtures/missing_facts.json" with {
  type: "json",
};
import protoPollutionFixture from "./fixtures/prototype_pollution.json" with {
  type: "json",
};
import remoteRefsFixture from "./fixtures/remote_references.json" with {
  type: "json",
};
import contradictoryRulesFixture from "./fixtures/contradictory_rules.json" with {
  type: "json",
};
import promptInjectionFixture from "./fixtures/prompt_injection.json" with {
  type: "json",
};
import undeclaredChangesFixture from "./fixtures/undeclared_changes.json" with {
  type: "json",
};
import candidateHashMismatchFixture from "./fixtures/candidate_hash_mismatch.json" with {
  type: "json",
};
import {
  assertSafeStructure,
  assertSafeTargetSchema,
  SecurityViolationError,
} from "../../src/verify/security.js";
import { verifyCandidate } from "../../src/verify/verifier.js";
import type { DeliverCheckRequest } from "../../src/types.js";
import { createAgentCard, createServiceListing } from "../../src/discovery/documents.js";

describe("Discovery safety claims", () => {
  it("keeps production guidance bounded and authentication external", () => {
    const listing = createServiceListing();
    const card = createAgentCard("https://delivercheck.vercel.app");

    expect(listing.buyer_guide.not_for).toEqual([
      "Proving factual truth.",
      "Evaluating seller reputation.",
      "Inventing missing or ambiguous information.",
      "Arbitrary nested-document transformation.",
    ]);
    expect(listing.compatibility_profiles.limitation).toBe(
      "These profiles cover supported top-level normalization only.",
    );
    expect(listing.caller_identity.status).toBe("external_arena_authentication_pending");
    expect(card.authentication.status).toBe("external_arena_authentication_pending");
    expect(listing.pricing.payment_verification).toBe("not_implemented");
    expect(JSON.stringify({ listing, card })).not.toMatch(
      /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/iu,
    );
  });
});

describe("Adversarial Security Test Suites", () => {
  // 1. Ambiguity
  it("rejects ambiguity (date and currency) with needs_information", () => {
    const report = verifyCandidate({
      request: ambiguityFixture.request as DeliverCheckRequest,
      candidate: ambiguityFixture.candidate,
      changes: ambiguityFixture.declared_changes as any,
    });

    expect(report.status).not.toBe("passed_checks");
  });

  // 2. Leading Zeros
  it("strictly enforces leading zeros preservation without coercion", () => {
    const request = leadingZerosFixture.request as DeliverCheckRequest;

    for (const testCase of leadingZerosFixture.adversarial_candidates) {
      const report = verifyCandidate({
        request,
        candidate: testCase.candidate,
        changes: [],
      });

      if (testCase.expected_valid) {
        expect(
          report.detailedChecks.find((c) => c.name === "candidate_schema_validation")
            ?.outcome,
        ).toBe("passed");
      } else {
        expect(
          report.detailedChecks.find((c) => c.name === "candidate_schema_validation")
            ?.outcome,
        ).toBe("failed");
      }
    }
  });

  // 3. Missing Facts
  it("requires needs_information when required facts are missing", () => {
    const report = verifyCandidate({
      request: missingFactsFixture.request as DeliverCheckRequest,
    });

    expect(report.valid).toBe(false);
  });

  // 4. Prototype Pollution
  it("rejects dangerous prototype keys (__proto__, constructor, prototype) in payload and schema", () => {
    for (const testCase of protoPollutionFixture.adversarial_cases) {
      if ("candidate" in testCase) {
        expect(() =>
          assertSafeStructure(testCase.candidate),
        ).toThrowError(SecurityViolationError);
      } else if ("schema" in testCase) {
        expect(() =>
          assertSafeTargetSchema(testCase.schema),
        ).toThrowError(SecurityViolationError);
      }
    }
  });

  // 5. Remote References
  it("rejects schemas containing remote $ref URIs to prevent SSRF and network calls", () => {
    for (const testCase of remoteRefsFixture.adversarial_schemas) {
      expect(() =>
        assertSafeTargetSchema(testCase.schema),
      ).toThrowError(SecurityViolationError);
    }
  });

  // 6. Deep Objects / Depth Bomb
  it("rejects objects exceeding maximum nesting depth limit to prevent stack overflow", () => {
    let deep: any = { value: "deepest" };
    for (let i = 0; i < 40; i++) {
      deep = { level: deep };
    }

    expect(() => assertSafeStructure(deep, { maxDepth: 32 })).toThrowError(
      SecurityViolationError,
    );
  });

  // 7. Contradictory Rules
  it("flags contradictory requirements and does not pass checks", () => {
    const report = verifyCandidate({
      request: contradictoryRulesFixture.request as DeliverCheckRequest,
    });

    expect(report.status).not.toBe("passed_checks");
  });

  // 8. Prompt Injection
  it("treats prompt-like text inside JSON as ordinary inert data and enforces schema", () => {
    const report = verifyCandidate({
      request: promptInjectionFixture.request as DeliverCheckRequest,
      candidate: promptInjectionFixture.candidate,
      changes: [],
    });

    expect(report.valid).toBe(false);
    const schemaCheck = report.detailedChecks.find(
      (c) => c.name === "candidate_schema_validation",
    );
    expect(schemaCheck?.outcome).toBe("failed");
  });

  // 9. Undeclared Changes
  it("detects undeclared changes in candidate payload", () => {
    const report = verifyCandidate({
      request: undeclaredChangesFixture.request as DeliverCheckRequest,
      candidate: undeclaredChangesFixture.candidate,
      changes: undeclaredChangesFixture.declared_changes as any,
    });

    expect(report.valid).toBe(false);
    expect(report.changeAudit?.valid).toBe(false);
    const undeclaredPaths = report.changeAudit?.undeclaredChanges.map((u) => u.path);
    for (const expectedPath of undeclaredChangesFixture.expected_undeclared_paths) {
      expect(undeclaredPaths).toContain(expectedPath);
    }
  });

  // 10. Candidate Hash Mismatch
  it("detects candidate hash mismatch when declared hash does not match canonical SHA-256", () => {
    const report = verifyCandidate({
      request: candidateHashMismatchFixture.request as DeliverCheckRequest,
      candidate: candidateHashMismatchFixture.candidate,
      candidateHash: candidateHashMismatchFixture.declared_candidate_hash,
      changes: [],
    });

    expect(report.valid).toBe(false);
    expect(report.hashMatches.candidate).toBe(false);
    const hashCheck = report.detailedChecks.find(
      (c) => c.name === "candidate_hash_verification",
    );
    expect(hashCheck?.outcome).toBe("failed");
  });
});
