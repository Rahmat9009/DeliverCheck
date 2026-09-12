import { describe, expect, it } from "vitest";

import {
  createProofGrants,
  runSharedOSProof,
} from "../../src/sharedos/proof.js";

describe("embedded SharedOS proof", () => {
  it("uses only exact capability grants", () => {
    const grants = createProofGrants();

    expect(grants).toHaveLength(3);
    expect(
      grants.flatMap((grant) => grant.capabilities.map(({ scope }) => scope)),
    ).toEqual(["exact", "exact", "exact"]);
  });

  it("allows intake and denies role and cross-job boundary violations", async () => {
    const proof = await runSharedOSProof();

    expect(proof.operations).toMatchObject([
      { operation: "intake_allowed_source_write", status: "succeeded" },
      {
        operation: "repairer_denied_verdict_write",
        status: "denied",
        reason: "no_matching_grant",
      },
      {
        operation: "verifier_denied_candidate_write",
        status: "denied",
        reason: "no_matching_grant",
      },
      {
        operation: "repairer_denied_cross_job_write",
        status: "denied",
        reason: "no_matching_grant",
      },
    ]);
    expect(proof.provider_invocations).toHaveLength(1);
    expect(proof.operations.every(({ authority_hash }) => /^[a-f0-9]{64}$/u.test(authority_hash))).toBe(true);
    expect(proof.operations[1]?.authority_hash).toBe(
      proof.operations[3]?.authority_hash,
    );
  });

  it("sanitizes grant IDs and audit metadata from proof output", async () => {
    const serialized = JSON.stringify(await runSharedOSProof());

    expect(serialized).not.toContain("grant:intake");
    expect(serialized).not.toContain("grant:repair");
    expect(serialized).not.toContain("grant:verifier");
    expect(serialized).not.toContain('"metadata"');
  });
});
