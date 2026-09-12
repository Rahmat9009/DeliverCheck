import type { AuditEvent, AuditSink } from "@aicoo/sharedos";

import { formatSharedOSAddress } from "./identities.js";

export interface SanitizedAuditOutcome {
  type: AuditEvent["type"];
  outcome: AuditEvent["outcome"];
  actor: string;
  trace_id: string;
  authority_hash?: string;
  operation_id?: string;
  resource_namespace?: string;
  resource_leaf?: string;
  action?: string;
  reason?: string;
}

/**
 * Retains authorization evidence while dropping grant IDs, owners, raw inputs,
 * outputs, and the host-only metadata bag.
 */
export function sanitizeAuditEvent(event: AuditEvent): SanitizedAuditOutcome {
  return {
    type: event.type,
    outcome: event.outcome,
    actor: formatSharedOSAddress(event.actor),
    trace_id: event.traceId,
    ...(event.authorityHash === undefined
      ? {}
      : { authority_hash: event.authorityHash }),
    ...(event.operationId === undefined ? {} : { operation_id: event.operationId }),
    ...(event.resource === undefined
      ? {}
      : {
          resource_namespace: event.resource.namespace,
          resource_leaf: event.resource.path.at(-1) ?? "",
        }),
    ...(event.action === undefined ? {} : { action: event.action }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
  };
}

export class SanitizedAuditCollector implements AuditSink {
  readonly #events: SanitizedAuditOutcome[] = [];

  async record(event: AuditEvent): Promise<void> {
    this.#events.push(sanitizeAuditEvent(event));
  }

  snapshot(): readonly SanitizedAuditOutcome[] {
    return structuredClone(this.#events);
  }
}
