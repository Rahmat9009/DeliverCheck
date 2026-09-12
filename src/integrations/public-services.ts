import type { DeliverCheckRequest } from "../types.js";

export const PUBLIC_SERVICE_CURRENCY = "Arena credits";
export const BILLING_ENFORCEMENT =
  "external_pending_official_sharednet_confirmation" as const;
export const MAXIMUM_RESPONSE_TIME_MS = 5 * 60 * 1_000;

export const PUBLIC_SERVICES = [
  {
    name: "diagnose",
    price_credits: 0,
    description:
      "Validate one JSON delivery against its target schema and report exact incompatibilities without changing the payload.",
    limitations:
      "Bounded top-level JSON objects only; structural checks do not prove factual truth.",
  },
  {
    name: "repair",
    price_credits: 7,
    description:
      "Run the SharedOS-authorized repair and independent verification pipeline.",
    limitations:
      "Only explicit, deterministic rules can justify changes; ambiguous or missing facts require more information.",
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
