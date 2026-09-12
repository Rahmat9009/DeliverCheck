import type { CorePipelinePort } from "../service/handlers.js";
import { ServiceError } from "../service/errors.js";
import type { SanitizedAuditOutcome } from "../sharedos/audit.js";
import type { AuditedPipelineExecution } from "../coordinator/core.js";
import type { DeliverCheckResult } from "../types.js";

export interface AuditableCorePipeline extends CorePipelinePort {
  runWithAudit(input: unknown, signal?: AbortSignal): Promise<AuditedPipelineExecution>;
}

export interface SharedOSCloudAuditExporter {
  export(
    events: readonly SanitizedAuditOutcome[],
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface CloudAuditPipelineOptions {
  sharedos_key?: string;
  exporter?: SharedOSCloudAuditExporter;
}

function auditExportUnavailable(): ServiceError {
  return new ServiceError(
    503,
    "operational",
    "audit_export_unavailable",
    "SharedOS Cloud audit export is configured but unavailable.",
  );
}

/**
 * Adds fail-closed audit export without altering the pipeline's grants.
 * Export is completely disabled when SHAREDOS_KEY is absent.
 */
export function withOptionalCloudAudit(
  pipeline: AuditableCorePipeline,
  options: CloudAuditPipelineOptions,
): CorePipelinePort {
  if (options.sharedos_key === undefined || options.sharedos_key.length === 0) {
    return pipeline;
  }

  return {
    async run(input: unknown, signal?: AbortSignal): Promise<DeliverCheckResult> {
      const execution = await pipeline.runWithAudit(input, signal);

      try {
        if (options.exporter === undefined) {
          throw auditExportUnavailable();
        }
        await options.exporter.export(execution.audit, signal);
      } catch (exportError) {
        if (execution.status === "succeeded") {
          throw exportError instanceof ServiceError
            ? exportError
            : new ServiceError(
                503,
                "operational",
                "audit_export_failed",
                "SharedOS Cloud audit export failed.",
                { cause: exportError },
              );
        }
      }

      if (execution.status === "failed") {
        throw execution.error;
      }
      return execution.result;
    },
  };
}

export interface HttpsAuditExporterOptions {
  endpoint: string;
  sharedos_key: string;
  fetch_impl?: typeof fetch;
  timeout_ms?: number;
}

/** Creates an HTTPS exporter without logging, returning, or persisting its key. */
export function createHttpsAuditExporter(
  options: HttpsAuditExporterOptions,
): SharedOSCloudAuditExporter {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new TypeError("The SharedOS audit endpoint must be an HTTPS URL without credentials, query, or fragment.");
  }
  const request = options.fetch_impl ?? fetch;
  const timeoutMs = options.timeout_ms ?? 5_000;

  return {
    async export(events, signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const exportSignal = signal === undefined
        ? timeout
        : AbortSignal.any([signal, timeout]);
      const response = await request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.sharedos_key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema_version: "delivercheck.sharedos-audit-export.v1",
          events,
        }),
        signal: exportSignal,
      });
      if (!response.ok) {
        throw new Error("SharedOS Cloud audit endpoint rejected the export.");
      }
    },
  };
}
