import type {
  CannotRepairResult,
  DeliverCheckRequest,
  DeliverCheckResult,
  NeedsInformationResult,
  PassedChecksResult,
  VerificationCheck,
} from "../types.js";
import type { DetailedCheck } from "../verify/verifier.js";

export interface RepairInvocation {
  job_id: string;
  request: DeliverCheckRequest;
  now: () => number;
}

/**
 * A repair stage can propose success or one of the two contract terminal
 * outcomes. None of these outcomes is authoritative until verification.
 */
export type RepairStageResult =
  | {
      status: "candidate_proposed";
      proposal: PassedChecksResult;
    }
  | {
      status: "needs_information";
      proposal: NeedsInformationResult;
    }
  | {
      status: "cannot_repair";
      proposal: CannotRepairResult;
    };

export interface RepairAgentPort {
  invoke(input: RepairInvocation, signal?: AbortSignal): Promise<RepairStageResult>;
}

export interface VerificationInvocation {
  job_id: string;
  request: DeliverCheckRequest;
  proposal: DeliverCheckResult;
}

export type VerificationStageResult =
  | {
      status: "accepted";
      proposal_status: DeliverCheckResult["status"];
      checks: VerificationCheck[];
      detailed_checks: DetailedCheck[];
      verified_hashes: {
        original: string;
        schema: string;
        candidate?: string;
      };
    }
  | {
      status: "rejected";
      reason: string;
      checks: VerificationCheck[];
      detailed_checks: DetailedCheck[];
    };

export interface VerificationAgentPort {
  invoke(input: VerificationInvocation, signal?: AbortSignal): Promise<VerificationStageResult>;
}

export interface CoordinatorPorts {
  repair: RepairAgentPort;
  verifier: VerificationAgentPort;
}

export class CoordinatorNotReadyError extends Error {
  readonly code = "coordinator_not_ready";

  constructor(readonly missing_ports: readonly (keyof CoordinatorPorts)[]) {
    super(`Coordinator is unavailable; missing ports: ${missing_ports.join(", ")}`);
    this.name = "CoordinatorNotReadyError";
  }
}

/** Fails closed until both independently implemented stage adapters exist. */
export function requireCoordinatorPorts(
  ports: Partial<CoordinatorPorts>,
): CoordinatorPorts {
  const missing: (keyof CoordinatorPorts)[] = [];
  if (ports.repair === undefined) {
    missing.push("repair");
  }
  if (ports.verifier === undefined) {
    missing.push("verifier");
  }
  if (missing.length > 0) {
    throw new CoordinatorNotReadyError(missing);
  }
  return ports as CoordinatorPorts;
}
