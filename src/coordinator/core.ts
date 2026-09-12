import type {
  DeliverCheckResult,
  JsonValue,
} from "../types.js";
import { validateRequestContract, validateResultContract } from "../verify/validate.js";
import { computeCanonicalHash } from "../verify/canonical.js";
import type { SanitizedAuditOutcome } from "../sharedos/audit.js";
import {
  SharedOSStageError,
  SharedOSWorkflow,
  type SharedOSWorkflowOptions,
  type WorkflowIdFactory,
  type WorkflowStage,
} from "../sharedos/workflow.js";
import { createRepairAdapter, createVerifierAdapter } from "./adapters.js";
import {
  CoordinatorNotReadyError,
  requireCoordinatorPorts,
  type CoordinatorPorts,
  type RepairStageResult,
  type VerificationStageResult,
} from "./ports.js";

export const CORE_IMPLEMENTATION_VERSION = "0.1.0";

export type CorePipelineErrorCode =
  | "invalid_request"
  | "dependency_unavailable"
  | "stage_denied"
  | "stage_failed"
  | "stage_timeout"
  | "invalid_proposal"
  | "verification_rejected"
  | "candidate_binding_failed"
  | "invalid_final_result";

export class CorePipelineError extends Error {
  constructor(
    readonly code: CorePipelineErrorCode,
    message: string,
    readonly stage?: WorkflowStage,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CorePipelineError";
  }
}

const DEFAULT_ID_FACTORY: WorkflowIdFactory = {
  operationId(stage, jobKey) {
    return `operation:${stage}:${jobKey}`;
  },
  traceId(stage, jobKey) {
    return `trace:${stage}:${jobKey}`;
  },
};

export interface CorePipelineOptions {
  /** Supplying a partial object deliberately models an unavailable stage. */
  ports?: Partial<CoordinatorPorts>;
  now?: () => number;
  id_factory?: WorkflowIdFactory;
  authorized_stages?: readonly WorkflowStage[];
}

export type AuditedPipelineExecution =
  | {
      status: "succeeded";
      result: DeliverCheckResult;
      audit: readonly SanitizedAuditOutcome[];
    }
  | {
      status: "failed";
      error: unknown;
      audit: readonly SanitizedAuditOutcome[];
    };

function stageMatchesProposal(stage: RepairStageResult): boolean {
  return (
    (stage.status === "candidate_proposed" && stage.proposal.status === "passed_checks") ||
    (stage.status === "needs_information" && stage.proposal.status === "needs_information") ||
    (stage.status === "cannot_repair" && stage.proposal.status === "cannot_repair")
  );
}

function validateProposal(
  stage: RepairStageResult,
  expectedJobId: string,
): DeliverCheckResult {
  if (!stageMatchesProposal(stage)) {
    throw new CorePipelineError(
      "invalid_proposal",
      "The repair stage label does not match its proposed result status.",
      "repair",
    );
  }

  const validation = validateResultContract(stage.proposal);
  if (!validation.valid) {
    throw new CorePipelineError(
      "invalid_proposal",
      "The repair stage returned a proposal that violates the frozen result contract.",
      "repair",
    );
  }
  if (validation.value.job_id !== expectedJobId) {
    throw new CorePipelineError(
      "invalid_proposal",
      "The repair proposal is bound to a different job.",
      "repair",
    );
  }
  return structuredClone(validation.value);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && error.name === "TimeoutError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "execution_timeout")
  );
}

function mapStageError(error: unknown, stage: WorkflowStage): never {
  if (error instanceof CorePipelineError) {
    throw error;
  }
  if (error instanceof SharedOSStageError) {
    if (isAbortError(error.cause)) {
      throw new CorePipelineError(
        "stage_timeout",
        `The ${error.stage} stage timed out.`,
        error.stage,
        { cause: error },
      );
    }
    throw new CorePipelineError(
      error.outcome === "denied" ? "stage_denied" : "stage_failed",
      error.message,
      error.stage,
      { cause: error },
    );
  }
  if (isAbortError(error)) {
    throw new CorePipelineError(
      "stage_timeout",
      `The ${stage} stage was aborted or timed out.`,
      stage,
      { cause: error },
    );
  }
  throw new CorePipelineError(
    "stage_failed",
    `The ${stage} stage failed operationally.`,
    stage,
    { cause: error },
  );
}

function elapsedSince(start: number, now: () => number): number {
  return Math.max(0, Math.round(now() - start));
}

function assertVerificationAccepted(
  verification: VerificationStageResult,
  proposal: DeliverCheckResult,
): asserts verification is Extract<VerificationStageResult, { status: "accepted" }> {
  if (verification.status === "rejected") {
    throw new CorePipelineError(
      "verification_rejected",
      verification.reason,
      "verifier",
    );
  }
  if (verification.proposal_status !== proposal.status) {
    throw new CorePipelineError(
      "verification_rejected",
      "The verifier accepted a different result status than the repair proposal.",
      "verifier",
    );
  }
  if (
    verification.verified_hashes.original !== proposal.original_hash ||
    verification.verified_hashes.schema !== proposal.schema_hash
  ) {
    throw new CorePipelineError(
      "verification_rejected",
      "The verifier accepted hashes that do not match the repair proposal.",
      "verifier",
    );
  }
}

function bindCandidate(
  candidate: JsonValue,
  verifiedHash: string | undefined,
): { candidate: JsonValue; candidate_hash: string } {
  const deliveredCandidate = structuredClone(candidate);
  const deliveredHash = computeCanonicalHash(deliveredCandidate);
  if (verifiedHash === undefined || deliveredHash !== verifiedHash) {
    throw new CorePipelineError(
      "candidate_binding_failed",
      "The candidate selected for delivery does not match the verifier's hash.",
      "verifier",
    );
  }
  return { candidate: deliveredCandidate, candidate_hash: deliveredHash };
}

function buildFinalResult(
  proposal: DeliverCheckResult,
  verification: Extract<VerificationStageResult, { status: "accepted" }>,
  elapsedMs: number,
): DeliverCheckResult {
  const common = {
    job_id: proposal.job_id,
    changes: structuredClone(proposal.changes),
    checks: structuredClone(verification.checks),
    original_hash: verification.verified_hashes.original,
    schema_hash: verification.verified_hashes.schema,
    elapsed_ms: elapsedMs,
    implementation_version: CORE_IMPLEMENTATION_VERSION,
  };

  let result: DeliverCheckResult;
  switch (proposal.status) {
    case "passed_checks": {
      const bound = bindCandidate(
        proposal.candidate,
        verification.verified_hashes.candidate,
      );
      result = {
        ...common,
        status: "passed_checks",
        ...bound,
        unresolved: [],
      };
      break;
    }
    case "needs_information": {
      const optionalCandidate =
        proposal.candidate === undefined
          ? {}
          : bindCandidate(
              proposal.candidate,
              verification.verified_hashes.candidate,
            );
      result = {
        ...common,
        status: "needs_information",
        ...optionalCandidate,
        unresolved: structuredClone(proposal.unresolved),
      };
      break;
    }
    case "cannot_repair":
      result = {
        ...common,
        status: "cannot_repair",
        unresolved: structuredClone(proposal.unresolved),
      };
      break;
  }

  const validation = validateResultContract(result);
  if (!validation.valid) {
    throw new CorePipelineError(
      "invalid_final_result",
      "The coordinated result violates the frozen result contract.",
    );
  }
  return structuredClone(validation.value);
}

export class DeliverCheckCorePipeline {
  readonly #ports: Partial<CoordinatorPorts>;
  readonly #now: () => number;
  readonly #idFactory: WorkflowIdFactory;
  readonly #authorizedStages: readonly WorkflowStage[] | undefined;

  constructor(options: CorePipelineOptions = {}) {
    this.#ports =
      options.ports ?? {
        repair: createRepairAdapter(),
        verifier: createVerifierAdapter(),
      };
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.id_factory ?? DEFAULT_ID_FACTORY;
    this.#authorizedStages = options.authorized_stages;
  }

  async run(input: unknown, signal?: AbortSignal): Promise<DeliverCheckResult> {
    const execution = await this.runWithAudit(input, signal);
    if (execution.status === "failed") {
      throw execution.error;
    }
    return execution.result;
  }

  async runWithAudit(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AuditedPipelineExecution> {
    let workflow: SharedOSWorkflow | undefined;
    try {
      const validation = validateRequestContract(input);
      if (!validation.valid) {
        throw new CorePipelineError(
          "invalid_request",
          "The input violates the frozen DeliverCheck request contract.",
        );
      }

      let ports: CoordinatorPorts;
      try {
        ports = requireCoordinatorPorts(this.#ports);
      } catch (error) {
        if (error instanceof CoordinatorNotReadyError) {
          throw new CorePipelineError(
            "dependency_unavailable",
            error.message,
            undefined,
            { cause: error },
          );
        }
        throw error;
      }

      const request = structuredClone(validation.value);
      const start = this.#now();
      const workflowOptions: SharedOSWorkflowOptions = {
        ports,
        job_id: request.request_id,
        now: this.#now,
        id_factory: this.#idFactory,
        ...(this.#authorizedStages === undefined
          ? {}
          : { authorized_stages: this.#authorizedStages }),
      };
      workflow = new SharedOSWorkflow(workflowOptions);

      let repairStage: RepairStageResult;
      try {
        repairStage = await workflow.invokeRepair(request, signal);
      } catch (error) {
        mapStageError(error, "repair");
      }

      const proposal = validateProposal(repairStage, request.request_id);

      let verification: VerificationStageResult;
      try {
        verification = await workflow.invokeVerifier(request, proposal, signal);
      } catch (error) {
        mapStageError(error, "verifier");
      }

      assertVerificationAccepted(verification, proposal);
      const result = buildFinalResult(
        proposal,
        verification,
        elapsedSince(start, this.#now),
      );
      return {
        status: "succeeded",
        result,
        audit: workflow.auditSnapshot(),
      };
    } catch (error) {
      return {
        status: "failed",
        error,
        audit: workflow?.auditSnapshot() ?? [],
      };
    }
  }
}

export function createCorePipeline(
  options: CorePipelineOptions = {},
): DeliverCheckCorePipeline {
  return new DeliverCheckCorePipeline(options);
}
