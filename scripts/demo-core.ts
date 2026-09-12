import {
  CorePipelineError,
  createCorePipeline,
  createRepairAdapter,
  createVerifierAdapter,
} from "../src/coordinator/index.js";
import type { RepairAgentPort } from "../src/coordinator/ports.js";
import type { DeliverCheckRequest } from "../src/types.js";

const FIXED_NOW = () => 1_000;
const FORGED_HASH = `sha256:${"0".repeat(64)}`;

const successfulRepair: DeliverCheckRequest = {
  request_id: "demo-success",
  input_format: "json",
  source_text: JSON.stringify({ name: "Amina", status: "done" }),
  target_schema: {
    type: "object",
    additionalProperties: false,
    required: ["full_name", "status"],
    properties: {
      full_name: { type: "string" },
      status: { type: "string", enum: ["complete", "pending"] },
    },
  },
  explicit_rules: [
    'Rename field "name" to "full_name".',
    'Normalize "status" value "done" to "complete".',
  ],
};

const needsInformation: DeliverCheckRequest = {
  request_id: "demo-needs-information",
  input_format: "json",
  source_text: JSON.stringify({ delivery_date: "03/04/2026" }),
  target_schema: {
    type: "object",
    additionalProperties: false,
    required: ["delivery_date"],
    properties: {
      delivery_date: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      },
    },
  },
  explicit_rules: ["The delivery date must be an ISO calendar date."],
};

const realRepair = createRepairAdapter();
const tamperingRepair: RepairAgentPort = {
  async invoke(input, signal) {
    const stage = await realRepair.invoke(input, signal);
    if (stage.status !== "candidate_proposed") {
      return stage;
    }
    return {
      status: "candidate_proposed",
      proposal: { ...stage.proposal, candidate_hash: FORGED_HASH },
    };
  },
};

console.log("DeliverCheck local deterministic core demonstration");
console.log("Synthetic inputs only; this is not a live Arena call or Cloud execution.");

const success = await createCorePipeline({ now: FIXED_NOW }).run(successfulRepair);
console.log(
  JSON.stringify({
    example: "successful_justified_repair",
    status: success.status,
    changes: success.changes.length,
    candidate_hash_verified:
      success.status === "passed_checks" &&
      success.checks.some(
        (check) =>
          check.name === "candidate_hash_verification" && check.status === "passed",
      ),
  }),
);

const incomplete = await createCorePipeline({ now: FIXED_NOW }).run(
  needsInformation,
);
console.log(
  JSON.stringify({
    example: "needs_information",
    status: incomplete.status,
    unresolved_codes: incomplete.unresolved.map((issue) => issue.code),
  }),
);

try {
  await createCorePipeline({
    now: FIXED_NOW,
    ports: { repair: tamperingRepair, verifier: createVerifierAdapter() },
  }).run({
    ...successfulRepair,
    request_id: "demo-tampered",
  });
  throw new Error("Tampered proposal was unexpectedly accepted");
} catch (error) {
  if (!(error instanceof CorePipelineError)) {
    throw error;
  }
  console.log(
    JSON.stringify({
      example: "tampered_repair_proposal",
      outcome: "rejected",
      operational_code: error.code,
      stage: error.stage,
    }),
  );
}
