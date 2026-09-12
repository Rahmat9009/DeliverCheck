import { describe, expect, it } from "vitest";

import {
  CorePipelineError,
  createCorePipeline,
  createRepairAdapter,
  createVerifierAdapter,
} from "../../src/coordinator/index.js";
import type {
  RepairAgentPort,
  VerificationAgentPort,
} from "../../src/coordinator/ports.js";
import type { DeliverCheckRequest, JsonObject } from "../../src/types.js";
import { computeCanonicalHash } from "../../src/verify/canonical.js";

const FIXED_NOW = () => 1_000;
const ZERO_HASH = `sha256:${"0".repeat(64)}`;

function request(overrides: Partial<DeliverCheckRequest>): DeliverCheckRequest {
  return {
    request_id: "req-core",
    input_format: "json",
    source_text: "{}",
    target_schema: {},
    explicit_rules: ["The supplied JSON must meet the target schema."],
    ...overrides,
  };
}

function objectSchema(properties: JsonObject, required: string[]): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

async function expectPipelineError(
  run: Promise<unknown>,
  expected: Partial<CorePipelineError>,
): Promise<void> {
  try {
    await run;
    throw new Error("Expected pipeline to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CorePipelineError);
    expect(error).toMatchObject(expected);
  }
}

describe("DeliverCheck core pipeline", () => {
  it("independently accepts already-valid JSON through both authorized stages", async () => {
    const pipeline = createCorePipeline({ now: FIXED_NOW });
    const result = await pipeline.run(
      request({
        source_text: JSON.stringify({ status: "complete" }),
        target_schema: objectSchema(
          { status: { type: "string", enum: ["complete", "pending"] } },
          ["status"],
        ),
      }),
    );

    expect(result.status).toBe("passed_checks");
    expect(result.changes).toEqual([]);
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
    expect(result.checks.map((check) => check.name)).toContain(
      "candidate_hash_verification",
    );

    const allowed = pipeline
      .auditSnapshot()
      .filter((event) => event.type === "authorization.checked");
    expect(allowed).toMatchObject([
      {
        outcome: "allowed",
        actor: "agent:repair.delivercheck",
        resource_leaf: "candidate",
      },
      {
        outcome: "allowed",
        actor: "agent:verifier.delivercheck",
        resource_leaf: "verdict",
      },
    ]);
  });

  it("publishes an explicitly justified field rename after verification", async () => {
    const result = await createCorePipeline({ now: FIXED_NOW }).run(
      request({
        source_text: JSON.stringify({ name: "Alice" }),
        target_schema: objectSchema({ full_name: { type: "string" } }, ["full_name"]),
        explicit_rules: ['Rename field "name" to "full_name".'],
      }),
    );

    expect(result.status).toBe("passed_checks");
    if (result.status === "passed_checks") {
      expect(result.candidate).toEqual({ full_name: "Alice" });
    }
    expect(result.changes).toHaveLength(2);
  });

  it("publishes an explicit enum normalization after verification", async () => {
    const result = await createCorePipeline({ now: FIXED_NOW }).run(
      request({
        source_text: JSON.stringify({ status: "done" }),
        target_schema: objectSchema(
          { status: { type: "string", enum: ["complete", "pending"] } },
          ["status"],
        ),
        explicit_rules: ['Normalize "status" value "done" to "complete".'],
      }),
    );

    expect(result.status).toBe("passed_checks");
    if (result.status === "passed_checks") {
      expect(result.candidate).toEqual({ status: "complete" });
    }
  });

  it("preserves meaningful leading zeros in the verified candidate", async () => {
    const result = await createCorePipeline({ now: FIXED_NOW }).run(
      request({
        source_text: JSON.stringify({ invoice_id: 123 }),
        target_schema: objectSchema(
          { invoice_id: { type: "string", pattern: "^[0-9]{6}$" } },
          ["invoice_id"],
        ),
        explicit_rules: [
          "invoice_id is a six-character identifier and meaningful leading zeros must be preserved.",
        ],
      }),
    );

    expect(result.status).toBe("passed_checks");
    if (result.status === "passed_checks") {
      expect(result.candidate).toEqual({ invoice_id: "000123" });
      expect(result.candidate_hash).toBe(computeCanonicalHash(result.candidate));
    }
  });

  it("preserves needs_information for a missing required fact", async () => {
    const result = await createCorePipeline({ now: FIXED_NOW }).run(
      request({
        source_text: JSON.stringify({ currency: "QAR" }),
        target_schema: objectSchema(
          { customer_id: { type: "string" }, currency: { const: "QAR" } },
          ["customer_id", "currency"],
        ),
      }),
    );

    expect(result.status).toBe("needs_information");
    expect(result.unresolved.map((issue) => issue.code)).toContain("missing_fact");
  });

  it("preserves needs_information for an ambiguous date", async () => {
    const result = await createCorePipeline({ now: FIXED_NOW }).run(
      request({
        source_text: JSON.stringify({ delivery_date: "03/04/2026" }),
        target_schema: objectSchema(
          {
            delivery_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
          },
          ["delivery_date"],
        ),
      }),
    );

    expect(result.status).toBe("needs_information");
    expect(result.unresolved.map((issue) => issue.code)).toContain("ambiguous_date");
  });

  it("preserves needs_information for contradictory explicit rules", async () => {
    const result = await createCorePipeline({ now: FIXED_NOW }).run(
      request({
        source_text: JSON.stringify({ currency: "EUR" }),
        target_schema: objectSchema({ currency: { const: "QAR" } }, ["currency"]),
        explicit_rules: ["currency must be QAR.", "currency must be USD."],
      }),
    );

    expect(result.status).toBe("needs_information");
    expect(result.unresolved.map((issue) => issue.code)).toContain(
      "contradictory_requirements",
    );
  });

  it("publishes cannot_repair only for a verified content failure", async () => {
    const result = await createCorePipeline({ now: FIXED_NOW }).run(
      request({ source_text: "{not valid JSON" }),
    );

    expect(result.status).toBe("cannot_repair");
    expect(result.unresolved.map((issue) => issue.code)).toContain(
      "invalid_source_json",
    );
  });

  it("rejects a repair proposal with a forged candidate hash", async () => {
    const realRepair = createRepairAdapter();
    const forgedRepair: RepairAgentPort = {
      async invoke(input, signal) {
        const stage = await realRepair.invoke(input, signal);
        if (stage.status !== "candidate_proposed") {
          throw new Error("Expected a candidate proposal");
        }
        return {
          status: "candidate_proposed",
          proposal: { ...stage.proposal, candidate_hash: ZERO_HASH },
        };
      },
    };
    const pipeline = createCorePipeline({
      now: FIXED_NOW,
      ports: { repair: forgedRepair, verifier: createVerifierAdapter() },
    });

    await expectPipelineError(
      pipeline.run(
        request({
          source_text: JSON.stringify({ value: "valid" }),
          target_schema: objectSchema({ value: { const: "valid" } }, ["value"]),
        }),
      ),
      { code: "verification_rejected", stage: "verifier" },
    );
  });

  it("rejects an undeclared candidate modification even with a matching hash", async () => {
    const realRepair = createRepairAdapter();
    const tamperingRepair: RepairAgentPort = {
      async invoke(input, signal) {
        const stage = await realRepair.invoke(input, signal);
        if (stage.status !== "candidate_proposed") {
          throw new Error("Expected a candidate proposal");
        }
        const candidate = { status: "complete" };
        return {
          status: "candidate_proposed",
          proposal: {
            ...stage.proposal,
            candidate,
            candidate_hash: computeCanonicalHash(candidate),
          },
        };
      },
    };
    const pipeline = createCorePipeline({
      now: FIXED_NOW,
      ports: { repair: tamperingRepair, verifier: createVerifierAdapter() },
    });

    await expectPipelineError(
      pipeline.run(
        request({
          source_text: JSON.stringify({ status: "pending" }),
          target_schema: objectSchema(
            { status: { type: "string", enum: ["pending", "complete"] } },
            ["status"],
          ),
        }),
      ),
      { code: "verification_rejected", stage: "verifier" },
    );
  });

  it("keeps an unavailable verifier separate from cannot_repair", async () => {
    const pipeline = createCorePipeline({
      now: FIXED_NOW,
      ports: { repair: createRepairAdapter() },
    });

    await expectPipelineError(
      pipeline.run(request({ source_text: "{}" })),
      { code: "dependency_unavailable" },
    );
  });

  it("keeps a throwing verifier separate from cannot_repair", async () => {
    const throwingVerifier: VerificationAgentPort = {
      async invoke() {
        throw new Error("synthetic verifier outage");
      },
    };
    const pipeline = createCorePipeline({
      now: FIXED_NOW,
      ports: { repair: createRepairAdapter(), verifier: throwingVerifier },
    });

    await expectPipelineError(
      pipeline.run(
        request({
          source_text: JSON.stringify({ value: "valid" }),
          target_schema: objectSchema({ value: { const: "valid" } }, ["value"]),
        }),
      ),
      { code: "stage_failed", stage: "verifier" },
    );
  });

  it("keeps a verifier timeout separate from cannot_repair", async () => {
    const timingOutVerifier: VerificationAgentPort = {
      async invoke() {
        throw new DOMException("synthetic verifier deadline", "TimeoutError");
      },
    };
    const pipeline = createCorePipeline({
      now: FIXED_NOW,
      ports: { repair: createRepairAdapter(), verifier: timingOutVerifier },
    });

    await expectPipelineError(
      pipeline.run(
        request({
          source_text: JSON.stringify({ value: "valid" }),
          target_schema: objectSchema({ value: { const: "valid" } }, ["value"]),
        }),
      ),
      { code: "stage_timeout", stage: "verifier" },
    );
  });

  it("stops safely when SharedOS denies a stage invocation", async () => {
    const pipeline = createCorePipeline({
      now: FIXED_NOW,
      authorized_stages: ["repair"],
    });

    await expectPipelineError(
      pipeline.run(
        request({
          source_text: JSON.stringify({ value: "valid" }),
          target_schema: objectSchema({ value: { const: "valid" } }, ["value"]),
        }),
      ),
      { code: "stage_denied", stage: "verifier" },
    );
    expect(
      pipeline
        .auditSnapshot()
        .filter((event) => event.type === "authorization.checked"),
    ).toMatchObject([
      {
        outcome: "allowed",
        actor: "agent:repair.delivercheck",
        resource_leaf: "candidate",
      },
      {
        outcome: "denied",
        actor: "agent:verifier.delivercheck",
        resource_leaf: "verdict",
        reason: "no_matching_grant",
      },
    ]);
  });

  it("never modifies the caller's request or target schema", async () => {
    const input = request({
      source_text: JSON.stringify({ name: "Alice" }),
      target_schema: objectSchema({ full_name: { type: "string" } }, ["full_name"]),
      explicit_rules: ['Rename field "name" to "full_name".'],
    });
    const before = structuredClone(input);

    await createCorePipeline({ now: FIXED_NOW }).run(input);

    expect(input).toEqual(before);
    expect(input.target_schema).toEqual(before.target_schema);
  });
});
