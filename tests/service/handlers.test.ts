import { describe, expect, it, vi } from "vitest";

import { createCorePipeline, createRepairAdapter, createVerifierAdapter } from "../../src/coordinator/index.js";
import type { RepairAgentPort } from "../../src/coordinator/ports.js";
import { createServiceHandlers, ServiceError } from "../../src/service/index.js";
import { computeCanonicalHash } from "../../src/verify/canonical.js";
import { validateRequestContract } from "../../src/verify/validate.js";
import { repairRequest, serviceRequest, objectSchema } from "./fixtures.js";

const FIXED_NOW = () => 1_000;

describe("pure DeliverCheck service handlers", () => {
  it("publishes the MVP discovery documents and exact price declarations", () => {
    const handlers = createServiceHandlers();
    const listing = handlers.serviceListing();
    const card = handlers.agentCard("http://127.0.0.1:3000");

    expect(listing).toMatchObject({
      name: "DeliverCheck",
      tagline: "Make one agent’s output usable by the next.",
      scope: "Bounded top-level JSON-object diagnosis and repair.",
      implementation_status: "live_public_service",
      maximum_response_time_ms: 300_000,
      pricing: {
        billing_enforcement: "external_pending_official_sharednet_confirmation",
        payment_verification: "not_implemented",
      },
    });
    expect(listing.tools.map(({ name, price_credits }) => [name, price_credits])).toEqual([
      ["diagnose", 0],
      ["repair", 7],
    ]);
    expect(JSON.stringify(listing)).not.toContain("bridge");
    expect(card.endpoints.repair).toBe("http://127.0.0.1:3000/api/v1/repair");
    expect(card.implementation_status).toBe("live_public_service");
    expect(card.buyer_guide).toEqual(listing.buyer_guide);
    expect(card.authentication.status).toBe("external_arena_authentication_pending");
    expect(listing.caller_identity.status).toBe("external_arena_authentication_pending");
  });

  it("executes the listed enum example with its declared outcomes", async () => {
    const handlers = createServiceHandlers({ pipeline: createCorePipeline({ now: FIXED_NOW }) });
    const example = handlers.serviceListing().example_request;

    expect(validateRequestContract(example.request).valid).toBe(true);
    const diagnosis = await handlers.diagnose(example.request);
    const repair = await handlers.repair(example.request);
    expect(diagnosis.outcome).toBe(example.expected_outcomes.diagnose);
    expect(repair.result.status).toBe(example.expected_outcomes.repair);
    expect(repair.billing).toMatchObject({ price_credits: 7, payment_verified: false });
  });

  it("diagnoses a valid payload without claiming factual truth", async () => {
    const result = await createServiceHandlers().diagnose(serviceRequest());
    expect(result).toMatchObject({
      service: "diagnose",
      outcome: "valid",
      problems: [],
      proves_factual_truth: false,
      billing: { price_credits: 0, payment_verified: false },
    });
  });

  it("returns exact schema incompatibilities without invoking repair or mutating input", async () => {
    const run = vi.fn();
    const handlers = createServiceHandlers({ pipeline: { run } });
    const input = serviceRequest({ source_text: JSON.stringify({ status: "unknown" }) });
    const before = structuredClone(input);
    const result = await handlers.diagnose(input);

    expect(result.outcome).toBe("incompatible");
    expect(result.problems).toEqual([
      expect.objectContaining({ instance_path: "/status", keyword: "enum", code: "enum" }),
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(input).toEqual(before);
  });

  it("returns a security rejection for a remote schema reference", async () => {
    const result = await createServiceHandlers().diagnose(
      serviceRequest({ target_schema: { $ref: "https://example.invalid/schema.json" } }),
    );
    expect(result).toMatchObject({
      outcome: "security_rejected",
      problems: [{ code: "unsupported_remote_reference" }],
    });
  });

  it("reports malformed source JSON as an incompatibility", async () => {
    const result = await createServiceHandlers().diagnose(
      serviceRequest({ source_text: "{broken" }),
    );
    expect(result).toMatchObject({
      outcome: "incompatible",
      problems: [{ code: "malformed_source_json" }],
      proves_factual_truth: false,
    });
  });

  it("runs the complete authorized pipeline for successful repair", async () => {
    const result = await createServiceHandlers({
      pipeline: createCorePipeline({ now: FIXED_NOW }),
    }).repair(repairRequest());

    expect(result.billing).toMatchObject({ price_credits: 7, payment_verified: false });
    expect(result.result.status).toBe("passed_checks");
    if (result.result.status === "passed_checks") {
      expect(result.result.candidate).toEqual({ full_name: "Amina", status: "complete" });
      expect(result.result.candidate_hash).toBe(computeCanonicalHash(result.result.candidate));
    }
  });

  it("preserves needs_information as a verified result", async () => {
    const result = await createServiceHandlers({
      pipeline: createCorePipeline({ now: FIXED_NOW }),
    }).repair(serviceRequest({
      source_text: JSON.stringify({ currency: "QAR" }),
      target_schema: objectSchema(
        { customer_id: { type: "string" }, currency: { const: "QAR" } },
        ["customer_id", "currency"],
      ),
    }));

    expect(result.result.status).toBe("needs_information");
    expect(result.result.unresolved.map((issue) => issue.code)).toContain("missing_fact");
  });

  it("rejects a tampered repair proposal through independent verification", async () => {
    const realRepair = createRepairAdapter();
    const tamperedRepair: RepairAgentPort = {
      async invoke(input, signal) {
        const stage = await realRepair.invoke(input, signal);
        if (stage.status !== "candidate_proposed") throw new Error("candidate expected");
        return {
          status: "candidate_proposed",
          proposal: {
            ...stage.proposal,
            candidate_hash: `sha256:${"0".repeat(64)}`,
          },
        };
      },
    };
    const handlers = createServiceHandlers({
      pipeline: createCorePipeline({
        now: FIXED_NOW,
        ports: { repair: tamperedRepair, verifier: createVerifierAdapter() },
      }),
    });

    await expect(handlers.repair(repairRequest())).rejects.toMatchObject({
      status: 422,
      kind: "integrity",
      code: "verification_rejected",
    });
  });

  it("never accepts request-body caller identity claims", async () => {
    const claimed = { ...serviceRequest(), caller_identity: "agent:attacker" };
    await expect(createServiceHandlers().diagnose(claimed)).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    });
    expect(createServiceHandlers().serviceListing().caller_identity)
      .toMatchObject({ request_body_claims_accepted: false });
  });

  it("enforces an injected request deadline", async () => {
    const handlers = createServiceHandlers({
      deadline_ms: 2,
      pipeline: {
        run: async (_input, signal) => {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          throw new Error("unreachable");
        },
      },
    });
    await expect(handlers.repair(repairRequest())).rejects.toMatchObject({
      status: 504,
      kind: "operational",
      code: "request_deadline_exceeded",
    });
  });

  it("keeps unexpected failures sanitized", async () => {
    const handlers = createServiceHandlers({
      pipeline: { run: async () => { throw new Error("private implementation detail"); } },
    });
    try {
      await handlers.repair(repairRequest());
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error).toMatchObject({ status: 500, code: "internal_error" });
      expect((error as Error).message).not.toContain("private implementation detail");
    }
  });
});
