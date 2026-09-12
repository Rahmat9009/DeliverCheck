import {
  CapabilityGrantSchema,
  SharedOSKernel,
  type AccessContext,
  type Address,
  type CapabilityGrant,
  type GrantSource,
  type ResourceOperation,
  type ResourceProvider,
  type ResourceRef,
  type ResourceResult,
} from "@aicoo/sharedos";

import { SanitizedAuditCollector, type SanitizedAuditOutcome } from "./audit.js";
import {
  DELIVERCHECK_IDENTITIES,
  DELIVERCHECK_PURPOSE,
  formatSharedOSAddress,
} from "./identities.js";
import { DELIVERCHECK_RESOURCE_NAMESPACE } from "./resources.js";

export { DELIVERCHECK_RESOURCE_NAMESPACE } from "./resources.js";

const PROOF_NAMESPACE = "delivercheck-proof";
const PROOF_TIME = "2026-09-12T00:00:00.000Z";
const PRIMARY_JOB = "job-alpha";
const OTHER_JOB = "job-beta";

type JobArtifact = "source" | "candidate" | "verdict";

interface ProviderInvocation {
  operation_id: string;
  action: string;
  resource_leaf: string;
}

class ProofResourceProvider implements ResourceProvider {
  readonly namespace = DELIVERCHECK_RESOURCE_NAMESPACE;
  readonly invocations: ProviderInvocation[] = [];

  async invoke(operation: ResourceOperation, signal: AbortSignal): Promise<ResourceResult> {
    signal.throwIfAborted();
    const resourceLeaf = operation.resource.path.at(-1) ?? "";
    this.invocations.push({
      operation_id: operation.operationId,
      action: operation.action,
      resource_leaf: resourceLeaf,
    });

    return {
      operationId: operation.operationId,
      status: "succeeded",
      output: { accepted: true, artifact: resourceLeaf },
      completedAt: operation.context.now,
    };
  }
}

function resourceFor(jobId: string, artifact: JobArtifact): ResourceRef {
  return {
    namespace: DELIVERCHECK_RESOURCE_NAMESPACE,
    path: ["jobs", jobId, artifact],
    owner: DELIVERCHECK_IDENTITIES.service,
  };
}

function exactGrant(
  id: string,
  subject: Address,
  jobId: string,
  artifact: JobArtifact,
): CapabilityGrant {
  return CapabilityGrantSchema.parse({
    id,
    namespaceId: PROOF_NAMESPACE,
    subject,
    issuer: DELIVERCHECK_IDENTITIES.service,
    capabilities: [
      {
        resource: resourceFor(jobId, artifact),
        actions: ["write"],
        scope: "exact",
      },
    ],
    constraints: { purposes: [DELIVERCHECK_PURPOSE] },
    issuedAt: PROOF_TIME,
  });
}

export function createProofGrants(): readonly CapabilityGrant[] {
  return [
    exactGrant("grant:intake:job-alpha:source", DELIVERCHECK_IDENTITIES.intake, PRIMARY_JOB, "source"),
    exactGrant("grant:repair:job-alpha:candidate", DELIVERCHECK_IDENTITIES.repair, PRIMARY_JOB, "candidate"),
    exactGrant("grant:verifier:job-alpha:verdict", DELIVERCHECK_IDENTITIES.verifier, PRIMARY_JOB, "verdict"),
  ];
}

function contextFor(actor: Address, traceId: string): AccessContext {
  return {
    namespaceId: PROOF_NAMESPACE,
    actor,
    authority: DELIVERCHECK_IDENTITIES.service,
    owner: DELIVERCHECK_IDENTITIES.service,
    purpose: DELIVERCHECK_PURPOSE,
    traceId,
    enabledToolNamespaces: [],
    now: PROOF_TIME,
  };
}

function grantSourceFor(grants: readonly CapabilityGrant[]): GrantSource {
  return {
    async load(context, signal) {
      signal.throwIfAborted();
      const actor = formatSharedOSAddress(context.actor);
      return grants.filter((grant) => formatSharedOSAddress(grant.subject) === actor);
    },
  };
}

export type ProofOutcomeStatus = ResourceResult["status"];

export interface ProofOperationOutcome {
  operation: string;
  status: ProofOutcomeStatus;
  reason?: string;
  authority_hash: string;
}

export interface SharedOSProofResult {
  implementation: "@aicoo/sharedos@0.1.0-alpha.4";
  purpose: string;
  identities: readonly string[];
  grants: { count: number; scopes: readonly string[] };
  operations: readonly ProofOperationOutcome[];
  provider_invocations: readonly ProviderInvocation[];
  audit: readonly SanitizedAuditOutcome[];
}

interface ProofAttempt {
  operation: string;
  actor: Address;
  jobId: string;
  artifact: JobArtifact;
}

const ATTEMPTS: readonly ProofAttempt[] = [
  {
    operation: "intake_allowed_source_write",
    actor: DELIVERCHECK_IDENTITIES.intake,
    jobId: PRIMARY_JOB,
    artifact: "source",
  },
  {
    operation: "repairer_denied_verdict_write",
    actor: DELIVERCHECK_IDENTITIES.repair,
    jobId: PRIMARY_JOB,
    artifact: "verdict",
  },
  {
    operation: "verifier_denied_candidate_write",
    actor: DELIVERCHECK_IDENTITIES.verifier,
    jobId: PRIMARY_JOB,
    artifact: "candidate",
  },
  {
    operation: "repairer_denied_cross_job_write",
    actor: DELIVERCHECK_IDENTITIES.repair,
    jobId: OTHER_JOB,
    artifact: "candidate",
  },
];

function resultReason(result: ResourceResult): string | undefined {
  return result.status === "succeeded" ? undefined : result.error.code;
}

export async function runSharedOSProof(): Promise<SharedOSProofResult> {
  const grants = createProofGrants();
  const audit = new SanitizedAuditCollector();
  const provider = new ProofResourceProvider();
  const kernel = new SharedOSKernel({
    grantSource: grantSourceFor(grants),
    audit,
  });
  kernel.registerResourceProvider(provider);

  const operations: ProofOperationOutcome[] = [];
  for (const attempt of ATTEMPTS) {
    const traceId = `trace:${attempt.operation}`;
    const result = await kernel.invokeResource(contextFor(attempt.actor, traceId), {
      operationId: `operation:${attempt.operation}`,
      resource: resourceFor(attempt.jobId, attempt.artifact),
      action: "write",
      input: { proof: true },
    });
    const authorityHash = audit
      .snapshot()
      .find(
        (event) =>
          event.trace_id === traceId &&
          event.type === "authority.resolved" &&
          event.authority_hash !== undefined,
      )?.authority_hash;
    if (authorityHash === undefined) {
      throw new Error(`SharedOS did not audit an authority hash for ${attempt.operation}`);
    }
    const reason = resultReason(result);

    operations.push({
      operation: attempt.operation,
      status: result.status,
      ...(reason === undefined ? {} : { reason }),
      authority_hash: authorityHash,
    });
  }

  const proof: SharedOSProofResult = {
    implementation: "@aicoo/sharedos@0.1.0-alpha.4",
    purpose: DELIVERCHECK_PURPOSE,
    identities: [
      formatSharedOSAddress(DELIVERCHECK_IDENTITIES.intake),
      formatSharedOSAddress(DELIVERCHECK_IDENTITIES.repair),
      formatSharedOSAddress(DELIVERCHECK_IDENTITIES.verifier),
      formatSharedOSAddress(DELIVERCHECK_IDENTITIES.service),
    ],
    grants: {
      count: grants.length,
      scopes: grants.flatMap((grant) => grant.capabilities.map(({ scope }) => scope)),
    },
    operations,
    provider_invocations: structuredClone(provider.invocations),
    audit: audit.snapshot(),
  };
  assertSharedOSProof(proof);
  return proof;
}

export function assertSharedOSProof(proof: SharedOSProofResult): void {
  const expected: Readonly<Record<string, ProofOutcomeStatus>> = {
    intake_allowed_source_write: "succeeded",
    repairer_denied_verdict_write: "denied",
    verifier_denied_candidate_write: "denied",
    repairer_denied_cross_job_write: "denied",
  };

  if (
    proof.operations.length !== Object.keys(expected).length ||
    proof.operations.some(({ operation }) => expected[operation] === undefined)
  ) {
    throw new Error("The proof did not execute the complete operation matrix");
  }

  for (const operation of proof.operations) {
    if (operation.status !== expected[operation.operation]) {
      throw new Error(
        `${operation.operation} was ${operation.status}; expected ${expected[operation.operation] ?? "no operation"}`,
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(operation.authority_hash)) {
      throw new Error(`${operation.operation} has an invalid authority hash`);
    }
    if (operation.status === "denied" && operation.reason !== "no_matching_grant") {
      throw new Error(`${operation.operation} did not fail for no_matching_grant`);
    }
  }

  if (proof.provider_invocations.length !== 1) {
    throw new Error("Denied operations reached the resource provider");
  }
  if (
    proof.provider_invocations[0]?.operation_id !==
    "operation:intake_allowed_source_write"
  ) {
    throw new Error("An operation other than allowed intake reached the provider");
  }
  if (proof.grants.scopes.some((scope) => scope !== "exact")) {
    throw new Error("The proof contains a non-exact capability grant");
  }
}
