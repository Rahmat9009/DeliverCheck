import { repairJson } from "../repair/engine.js";
import type { DeliverCheckResult } from "../types.js";
import {
  canonicalJsonStringify,
  verifyDeliverCheckResult,
  type VerificationReport,
} from "../verify/index.js";
import type {
  RepairAgentPort,
  RepairStageResult,
  VerificationAgentPort,
  VerificationStageResult,
} from "./ports.js";

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function toRepairStageResult(proposal: DeliverCheckResult): RepairStageResult {
  switch (proposal.status) {
    case "passed_checks":
      return { status: "candidate_proposed", proposal };
    case "needs_information":
      return { status: "needs_information", proposal };
    case "cannot_repair":
      return { status: "cannot_repair", proposal };
  }
}

/** Runs the deterministic repair engine and labels its output as a proposal. */
export function createRepairAdapter(): RepairAgentPort {
  return {
    async invoke(input, signal) {
      throwIfAborted(signal);
      const proposal = repairJson(structuredClone(input.request), { now: input.now });
      throwIfAborted(signal);
      return toRepairStageResult(proposal);
    },
  };
}

function reportPreservesUnresolved(
  proposal: DeliverCheckResult,
  report: VerificationReport,
): boolean {
  const preservesProposed = proposal.unresolved.every((issue) => {
    const expected = canonicalJsonStringify(issue);
    return report.unresolved.some(
      (reported) => canonicalJsonStringify(reported) === expected,
    );
  });
  const proposalCodes = new Set(proposal.unresolved.map((issue) => issue.code));
  const addsNoUnexpectedCode = report.unresolved.every((issue) =>
    proposalCodes.has(issue.code),
  );
  return preservesProposed && addsNoUnexpectedCode;
}

function rejectionReason(
  proposal: DeliverCheckResult,
  report: VerificationReport,
): string | undefined {
  if (!report.hashMatches.original || !report.hashMatches.schema) {
    return "The proposal's original or schema hash did not match independent computation.";
  }

  if (proposal.status === "passed_checks") {
    if (
      !report.valid ||
      report.status !== "passed_checks" ||
      report.hashMatches.candidate !== true ||
      report.hashes.candidate !== proposal.candidate_hash
    ) {
      return "The proposed candidate, changes, or candidate hash failed independent verification.";
    }
  } else if (report.status !== proposal.status) {
    return `The verifier classified the proposal as ${report.status}, not ${proposal.status}.`;
  }

  if (
    proposal.status === "needs_information" &&
    proposal.candidate !== undefined &&
    proposal.candidate_hash !== undefined &&
    report.hashMatches.candidate !== true
  ) {
    return "The optional candidate hash failed independent verification.";
  }

  if (!reportPreservesUnresolved(proposal, report)) {
    return "The verifier could not account for every proposed unresolved issue.";
  }

  return undefined;
}

/** Verifies the complete proposal and retains detailed diagnostics internally. */
export function createVerifierAdapter(): VerificationAgentPort {
  return {
    async invoke(input, signal): Promise<VerificationStageResult> {
      throwIfAborted(signal);
      const report = verifyDeliverCheckResult(
        structuredClone(input.request),
        structuredClone(input.proposal),
      );
      throwIfAborted(signal);

      const reason = rejectionReason(input.proposal, report);
      if (reason !== undefined) {
        return {
          status: "rejected",
          reason,
          checks: structuredClone(report.checks),
          detailed_checks: structuredClone(report.detailedChecks),
        };
      }

      return {
        status: "accepted",
        proposal_status: input.proposal.status,
        checks: structuredClone(report.checks),
        detailed_checks: structuredClone(report.detailedChecks),
        verified_hashes: {
          original: report.hashes.original,
          schema: report.hashes.schema,
          ...(report.hashes.candidate === undefined
            ? {}
            : { candidate: report.hashes.candidate }),
        },
      };
    },
  };
}
