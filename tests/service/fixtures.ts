import type { DeliverCheckRequest, JsonObject } from "../../src/types.js";

export function objectSchema(properties: JsonObject, required: string[]): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

export function serviceRequest(
  overrides: Partial<DeliverCheckRequest> = {},
): DeliverCheckRequest {
  return {
    request_id: "req-service",
    input_format: "json",
    source_text: JSON.stringify({ status: "complete" }),
    target_schema: objectSchema(
      { status: { type: "string", enum: ["complete", "pending"] } },
      ["status"],
    ),
    explicit_rules: ["The payload must conform to the supplied target schema."],
    ...overrides,
  };
}

export function repairRequest(): DeliverCheckRequest {
  return serviceRequest({
    request_id: "req-service-repair",
    source_text: JSON.stringify({ name: "Amina", status: "done" }),
    target_schema: objectSchema(
      {
        full_name: { type: "string" },
        status: { type: "string", enum: ["complete", "pending"] },
      },
      ["full_name", "status"],
    ),
    explicit_rules: [
      'Rename field "name" to "full_name".',
      'Normalize "status" value "done" to "complete".',
    ],
  });
}
