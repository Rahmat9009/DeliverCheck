import type { DeliverCheckRequest } from "../types.js";

export const PUBLIC_SERVICE_CURRENCY = "Arena credits";

export const PUBLIC_SERVICES = [
  {
    name: "diagnose",
    price: 0,
    description: "Explain structural blockers without claiming a repair occurred.",
  },
  {
    name: "repair",
    price: 7,
    description: "Request an explicitly justified JSON repair after the repair port is merged.",
  },
  {
    name: "bridge",
    price: 12,
    description: "Request repair plus independent verification after both ports are merged.",
  },
] as const;

export type PublicServiceName = (typeof PUBLIC_SERVICES)[number]["name"];

export interface PublicToolInvocation {
  service: PublicServiceName;
  request: DeliverCheckRequest;
}

/** Maps the public envelope into the frozen request without adding service fields. */
export function toFrozenRequest(invocation: PublicToolInvocation): DeliverCheckRequest {
  const request = invocation.request;
  return {
    request_id: request.request_id,
    input_format: request.input_format,
    source_text: request.source_text,
    target_schema: structuredClone(request.target_schema),
    explicit_rules: [...request.explicit_rules],
    ...(request.downstream_error === undefined
      ? {}
      : { downstream_error: request.downstream_error }),
  };
}
