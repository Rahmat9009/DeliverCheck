import { CorePipelineError } from "../coordinator/core.js";
import { SecurityViolationError } from "../verify/security.js";
import type { PublicServiceErrorBody } from "./types.js";

export type ServiceErrorKind = PublicServiceErrorBody["error"]["kind"];

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly kind: ServiceErrorKind,
    readonly code: string,
    publicMessage: string,
    options?: ErrorOptions,
  ) {
    super(publicMessage, options);
    this.name = "ServiceError";
  }
}

export function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) {
    return error;
  }
  if (error instanceof SecurityViolationError) {
    return new ServiceError(
      error.code === "payload_size_exceeded" ? 413 : 422,
      "security",
      error.code,
      "The request was rejected by a service security limit.",
      { cause: error },
    );
  }
  if (
    (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && error.name === "TimeoutError")
  ) {
    return new ServiceError(504, "operational", "request_deadline_exceeded", "The service request exceeded its deadline.", { cause: error });
  }
  if (error instanceof CorePipelineError) {
    switch (error.code) {
      case "invalid_request":
        return new ServiceError(400, "request", error.code, "The request does not match the DeliverCheck contract.", { cause: error });
      case "verification_rejected":
      case "candidate_binding_failed":
      case "invalid_proposal":
      case "invalid_final_result":
        return new ServiceError(422, "integrity", error.code, "The repair proposal failed independent integrity checks.", { cause: error });
      case "stage_timeout":
        return new ServiceError(504, "operational", error.code, "A required processing stage exceeded its deadline.", { cause: error });
      case "dependency_unavailable":
        return new ServiceError(503, "operational", error.code, "A required processing dependency is unavailable.", { cause: error });
      case "stage_denied":
        return new ServiceError(503, "operational", error.code, "A required processing stage was denied authorization.", { cause: error });
      case "stage_failed":
        return new ServiceError(503, "operational", error.code, "A required processing stage failed.", { cause: error });
    }
  }
  return new ServiceError(
    500,
    "operational",
    "internal_error",
    "The service could not complete the request.",
    { cause: error },
  );
}

export function publicErrorBody(error: unknown): PublicServiceErrorBody {
  const safe = toServiceError(error);
  return {
    error: {
      kind: safe.kind,
      code: safe.code,
      message: safe.message,
    },
  };
}
