import type {
  ChangeEvidence,
  DeliverCheckRequest,
  JsonValue,
  UnresolvedIssue,
  VerificationCheck,
} from "../types.js";

export interface RepairInvocation {
  job_id: string;
  request: DeliverCheckRequest;
}

export type RepairStageResult =
  | {
      status: "candidate_ready";
      candidate: JsonValue;
      changes: ChangeEvidence[];
      unresolved: [];
    }
  | {
      status: "needs_information" | "cannot_repair";
      changes: ChangeEvidence[];
      unresolved: [UnresolvedIssue, ...UnresolvedIssue[]];
    };

export interface RepairAgentPort {
  invoke(input: RepairInvocation, signal?: AbortSignal): Promise<RepairStageResult>;
}

export interface VerificationInvocation {
  job_id: string;
  request: DeliverCheckRequest;
  candidate: JsonValue;
  changes: ChangeEvidence[];
}

export type VerificationStageResult =
  | {
      status: "passed_checks";
      checks: VerificationCheck[];
      unresolved: [];
    }
  | {
      status: "needs_information" | "cannot_repair";
      checks: VerificationCheck[];
      unresolved: [UnresolvedIssue, ...UnresolvedIssue[]];
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

/** Fails closed until separately implemented repair and verifier adapters exist. */
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
