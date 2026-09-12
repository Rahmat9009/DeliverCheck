import type { DeliverCheckCorePipeline } from "../coordinator/core.js";
import { createCorePipeline } from "../coordinator/index.js";
import { createAgentCard, createServiceListing } from "../discovery/documents.js";
import {
  BILLING_ENFORCEMENT,
  PUBLIC_SERVICE_CURRENCY,
} from "../integrations/public-services.js";
import type { DeliverCheckRequest, JsonObject } from "../types.js";
import {
  assertSafePayloadSize,
  assertSafeStructure,
  assertSafeTargetSchema,
  SecurityViolationError,
} from "../verify/security.js";
import { validateCandidate, validateRequestContract } from "../verify/validate.js";
import { ServiceError, toServiceError } from "./errors.js";
import {
  MAX_REQUEST_BODY_BYTES,
  SERVICE_DEADLINE_MS,
  SERVICE_VERSION,
  type BillingDeclaration,
  type DiagnosisProblem,
  type DiagnosisResult,
  type HealthResult,
  type RepairServiceResult,
} from "./types.js";

export interface CorePipelinePort {
  run(input: unknown, signal?: AbortSignal): Promise<Awaited<ReturnType<DeliverCheckCorePipeline["run"]>>>;
}

export interface ServiceHandlerOptions {
  pipeline?: CorePipelinePort;
  deadline_ms?: number;
}

const BILLING = {
  diagnose: {
    price_credits: 0,
    currency: PUBLIC_SERVICE_CURRENCY,
    enforcement: BILLING_ENFORCEMENT,
    payment_verified: false,
  },
  repair: {
    price_credits: 7,
    currency: PUBLIC_SERVICE_CURRENCY,
    enforcement: BILLING_ENFORCEMENT,
    payment_verified: false,
  },
} as const satisfies Record<"diagnose" | "repair", BillingDeclaration>;

function validatedRequest(input: unknown): DeliverCheckRequest {
  assertSafeStructure(input);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new ServiceError(
      400,
      "request",
      "invalid_request",
      "The request does not match the DeliverCheck contract.",
    );
  }
  if (serialized === undefined) {
    throw new ServiceError(
      400,
      "request",
      "invalid_request",
      "The request does not match the DeliverCheck contract.",
    );
  }
  assertSafePayloadSize(serialized, { maxPayloadBytes: MAX_REQUEST_BODY_BYTES });
  const validation = validateRequestContract(input);
  if (!validation.valid) {
    throw new ServiceError(
      400,
      "request",
      "invalid_request",
      "The request does not match the DeliverCheck contract.",
    );
  }
  assertSafePayloadSize(validation.value.source_text, {
    maxPayloadBytes: MAX_REQUEST_BODY_BYTES,
  });
  assertSafeTargetSchema(validation.value.target_schema);
  return structuredClone(validation.value);
}

function diagnosisProblem(
  code: string,
  message: string,
  path = "",
): DiagnosisProblem {
  return {
    code,
    instance_path: path,
    schema_path: "",
    keyword: code,
    message,
  };
}

function parseTopLevelObject(sourceText: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(sourceText) as unknown;
  } catch {
    throw new ServiceError(
      400,
      "request",
      "malformed_source_json",
      "source_text is not valid JSON.",
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(
      422,
      "request",
      "unsupported_top_level_value",
      "DeliverCheck accepts a top-level JSON object.",
    );
  }
  assertSafeStructure(value);
  return value as JsonObject;
}

function deadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

export class DeliverCheckServiceHandlers {
  readonly #pipeline: CorePipelinePort;
  readonly #deadlineMs: number;

  constructor(options: ServiceHandlerOptions = {}) {
    this.#pipeline = options.pipeline ?? createCorePipeline();
    this.#deadlineMs = options.deadline_ms ?? SERVICE_DEADLINE_MS;
  }

  health(): HealthResult {
    return {
      status: "ok",
      service: "DeliverCheck",
      implementation_version: SERVICE_VERSION,
    };
  }

  agentCard(baseUrl: string): ReturnType<typeof createAgentCard> {
    return createAgentCard(baseUrl);
  }

  serviceListing(): ReturnType<typeof createServiceListing> {
    return createServiceListing();
  }

  async diagnose(input: unknown, signal?: AbortSignal): Promise<DiagnosisResult> {
    try {
      signal?.throwIfAborted();
      const request = validatedRequest(input);
      const candidate = parseTopLevelObject(request.source_text);
      const validation = validateCandidate(candidate, request.target_schema);
      signal?.throwIfAborted();
      return {
        service: "diagnose",
        outcome: validation.valid ? "valid" : "incompatible",
        problems: validation.errors.map((problem) => ({
          ...problem,
          code: problem.keyword,
        })),
        proves_factual_truth: false,
        billing: { ...BILLING.diagnose },
      };
    } catch (error) {
      if (error instanceof SecurityViolationError) {
        return {
          service: "diagnose",
          outcome: "security_rejected",
          problems: [diagnosisProblem(error.code, "The input was rejected by a service security limit.", error.path)],
          proves_factual_truth: false,
          billing: { ...BILLING.diagnose },
        };
      }
      if (
        error instanceof ServiceError &&
        (error.code === "malformed_source_json" ||
          error.code === "unsupported_top_level_value")
      ) {
        return {
          service: "diagnose",
          outcome: "incompatible",
          problems: [diagnosisProblem(error.code, error.message)],
          proves_factual_truth: false,
          billing: { ...BILLING.diagnose },
        };
      }
      throw toServiceError(error);
    }
  }

  async repair(input: unknown, signal?: AbortSignal): Promise<RepairServiceResult> {
    try {
      const request = validatedRequest(input);
      const result = await this.#pipeline.run(
        request,
        deadlineSignal(signal, this.#deadlineMs),
      );
      return {
        service: "repair",
        result: structuredClone(result),
        billing: { ...BILLING.repair },
      };
    } catch (error) {
      throw toServiceError(error);
    }
  }
}

export function createServiceHandlers(
  options: ServiceHandlerOptions = {},
): DeliverCheckServiceHandlers {
  return new DeliverCheckServiceHandlers(options);
}
