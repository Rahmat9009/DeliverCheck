import { createHash } from "node:crypto";

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

import type { DeliverCheckRequest, DeliverCheckResult } from "../types.js";
import type {
  CoordinatorPorts,
  RepairStageResult,
  VerificationStageResult,
} from "../coordinator/ports.js";
import { SanitizedAuditCollector, type SanitizedAuditOutcome } from "./audit.js";
import {
  DELIVERCHECK_IDENTITIES,
  DELIVERCHECK_PURPOSE,
  formatSharedOSAddress,
} from "./identities.js";
import { DELIVERCHECK_RESOURCE_NAMESPACE } from "./resources.js";

const WORKFLOW_NAMESPACE = "delivercheck-core";
const REPAIR_ARTIFACT = "candidate";
const VERIFIER_ARTIFACT = "verdict";

export type WorkflowStage = "repair" | "verifier";

export interface WorkflowIdFactory {
  operationId(stage: WorkflowStage, jobKey: string): string;
  traceId(stage: WorkflowStage, jobKey: string): string;
}

export interface SharedOSWorkflowOptions {
  ports: CoordinatorPorts;
  job_id: string;
  now: () => number;
  id_factory: WorkflowIdFactory;
  authorized_stages?: readonly WorkflowStage[];
}

export class SharedOSStageError extends Error {
  constructor(
    readonly stage: WorkflowStage,
    readonly outcome: "denied" | "failed",
    readonly reason_code: string,
    options?: ErrorOptions,
  ) {
    super(`SharedOS ${outcome} the ${stage} stage: ${reason_code}`, options);
    this.name = "SharedOSStageError";
  }
}

type StoredStageResult = RepairStageResult | VerificationStageResult;

function asSharedOSInput(value: unknown): ResourceOperation["input"] {
  return value as ResourceOperation["input"];
}

function asObject(value: ResourceOperation["input"]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("SharedOS stage input must be an object");
  }
  return value as Record<string, unknown>;
}

class WorkflowResourceProvider implements ResourceProvider {
  readonly namespace = DELIVERCHECK_RESOURCE_NAMESPACE;
  readonly #results = new Map<string, StoredStageResult>();
  readonly #errors = new Map<string, unknown>();

  constructor(
    private readonly ports: CoordinatorPorts,
    private readonly now: () => number,
  ) {}

  async invoke(operation: ResourceOperation, signal: AbortSignal): Promise<ResourceResult> {
    try {
      signal.throwIfAborted();
      const artifact = operation.resource.path.at(-1);
      const input = asObject(operation.input);

      let result: StoredStageResult;
      if (artifact === REPAIR_ARTIFACT && input["stage"] === "repair") {
        result = await this.ports.repair.invoke(
          {
            job_id: String(input["job_id"]),
            request: input["request"] as unknown as DeliverCheckRequest,
            now: this.now,
          },
          signal,
        );
      } else if (artifact === VERIFIER_ARTIFACT && input["stage"] === "verifier") {
        result = await this.ports.verifier.invoke(
          {
            job_id: String(input["job_id"]),
            request: input["request"] as unknown as DeliverCheckRequest,
            proposal: input["proposal"] as unknown as DeliverCheckResult,
          },
          signal,
        );
      } else {
        throw new TypeError("SharedOS stage input does not match its authorized resource");
      }

      signal.throwIfAborted();
      this.#results.set(operation.operationId, structuredClone(result));
      return {
        operationId: operation.operationId,
        status: "succeeded",
        output: { stage_completed: true },
        completedAt: operation.context.now,
      };
    } catch (error) {
      this.#errors.set(operation.operationId, error);
      throw error;
    }
  }

  take(operationId: string): StoredStageResult | undefined {
    const value = this.#results.get(operationId);
    this.#results.delete(operationId);
    return value === undefined ? undefined : structuredClone(value);
  }

  takeError(operationId: string): unknown {
    const error = this.#errors.get(operationId);
    this.#errors.delete(operationId);
    return error;
  }
}

function jobResourceKey(jobId: string): string {
  return createHash("sha256").update(jobId, "utf8").digest("hex");
}

function resourceFor(jobKey: string, artifact: string): ResourceRef {
  return {
    namespace: DELIVERCHECK_RESOURCE_NAMESPACE,
    path: ["jobs", jobKey, artifact],
    owner: DELIVERCHECK_IDENTITIES.service,
  };
}

function exactStageGrant(
  stage: WorkflowStage,
  actor: Address,
  jobKey: string,
  artifact: string,
  issuedAt: string,
): CapabilityGrant {
  return CapabilityGrantSchema.parse({
    id: `grant:${stage}:${jobKey}`,
    namespaceId: WORKFLOW_NAMESPACE,
    subject: actor,
    issuer: DELIVERCHECK_IDENTITIES.service,
    capabilities: [
      {
        resource: resourceFor(jobKey, artifact),
        actions: ["write"],
        scope: "exact",
      },
    ],
    constraints: { purposes: [DELIVERCHECK_PURPOSE] },
    issuedAt,
  });
}

function grantsFor(
  jobKey: string,
  issuedAt: string,
  authorizedStages: readonly WorkflowStage[],
): readonly CapabilityGrant[] {
  const grants: CapabilityGrant[] = [];
  if (authorizedStages.includes("repair")) {
    grants.push(
      exactStageGrant(
        "repair",
        DELIVERCHECK_IDENTITIES.repair,
        jobKey,
        REPAIR_ARTIFACT,
        issuedAt,
      ),
    );
  }
  if (authorizedStages.includes("verifier")) {
    grants.push(
      exactStageGrant(
        "verifier",
        DELIVERCHECK_IDENTITIES.verifier,
        jobKey,
        VERIFIER_ARTIFACT,
        issuedAt,
      ),
    );
  }
  return grants;
}

function grantSourceFor(grants: readonly CapabilityGrant[]): GrantSource {
  return {
    async load(context, signal) {
      signal.throwIfAborted();
      const actor = formatSharedOSAddress(context.actor);
      return grants.filter(
        (grant) => formatSharedOSAddress(grant.subject) === actor,
      );
    },
  };
}

function contextFor(
  actor: Address,
  traceId: string,
  now: string,
): AccessContext {
  return {
    namespaceId: WORKFLOW_NAMESPACE,
    actor,
    authority: DELIVERCHECK_IDENTITIES.service,
    owner: DELIVERCHECK_IDENTITIES.service,
    purpose: DELIVERCHECK_PURPOSE,
    traceId,
    enabledToolNamespaces: [],
    now,
  };
}

export class SharedOSWorkflow {
  readonly #jobKey: string;
  readonly #kernel: SharedOSKernel;
  readonly #provider: WorkflowResourceProvider;
  readonly #audit: SanitizedAuditCollector;
  readonly #nowIso: string;

  constructor(private readonly options: SharedOSWorkflowOptions) {
    this.#jobKey = jobResourceKey(options.job_id);
    this.#nowIso = new Date(options.now()).toISOString();
    const grants = grantsFor(
      this.#jobKey,
      this.#nowIso,
      options.authorized_stages ?? ["repair", "verifier"],
    );
    this.#audit = new SanitizedAuditCollector();
    this.#provider = new WorkflowResourceProvider(options.ports, options.now);
    this.#kernel = new SharedOSKernel({
      grantSource: grantSourceFor(grants),
      audit: this.#audit,
    });
    this.#kernel.registerResourceProvider(this.#provider);
  }

  async invokeRepair(
    request: DeliverCheckRequest,
    signal?: AbortSignal,
  ): Promise<RepairStageResult> {
    const result = await this.#invoke(
      "repair",
      DELIVERCHECK_IDENTITIES.repair,
      REPAIR_ARTIFACT,
      { stage: "repair", job_id: this.options.job_id, request },
      signal,
    );
    return result as RepairStageResult;
  }

  async invokeVerifier(
    request: DeliverCheckRequest,
    proposal: DeliverCheckResult,
    signal?: AbortSignal,
  ): Promise<VerificationStageResult> {
    const result = await this.#invoke(
      "verifier",
      DELIVERCHECK_IDENTITIES.verifier,
      VERIFIER_ARTIFACT,
      { stage: "verifier", job_id: this.options.job_id, request, proposal },
      signal,
    );
    return result as VerificationStageResult;
  }

  auditSnapshot(): readonly SanitizedAuditOutcome[] {
    return this.#audit.snapshot();
  }

  async #invoke(
    stage: WorkflowStage,
    actor: Address,
    artifact: string,
    input: unknown,
    signal: AbortSignal | undefined,
  ): Promise<StoredStageResult> {
    const operationId = this.options.id_factory.operationId(stage, this.#jobKey);
    const result = await this.#kernel.invokeResource(
      contextFor(
        actor,
        this.options.id_factory.traceId(stage, this.#jobKey),
        this.#nowIso,
      ),
      {
        operationId,
        resource: resourceFor(this.#jobKey, artifact),
        action: "write",
        input: asSharedOSInput(input),
      },
      { ...(signal === undefined ? {} : { signal }) },
    );

    if (result.status !== "succeeded") {
      const providerError = this.#provider.takeError(operationId);
      throw new SharedOSStageError(stage, result.status, result.error.code, {
        ...(providerError === undefined ? {} : { cause: providerError }),
      });
    }
    const stageResult = this.#provider.take(operationId);
    if (stageResult === undefined) {
      throw new SharedOSStageError(stage, "failed", "missing_stage_result");
    }
    return stageResult;
  }
}
