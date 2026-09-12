import {
  PUBLIC_SERVICES,
  PUBLIC_SERVICE_CURRENCY,
  BILLING_ENFORCEMENT,
} from "../integrations/public-services.js";
import type { PublicServiceName } from "../integrations/public-services.js";
import type { DeliverCheckServiceHandlers } from "./handlers.js";
import type { DiagnosisResult, McpToolDefinition, RepairServiceResult } from "./types.js";

export type McpToolResult = DiagnosisResult | RepairServiceResult;

export function createMcpToolDefinitions(): readonly McpToolDefinition[] {
  return PUBLIC_SERVICES.map((service) => ({
    name: service.name,
    description: `${service.description} Price: ${service.price_credits} ${PUBLIC_SERVICE_CURRENCY}. Limitation: ${service.limitations} Billing enforcement is ${BILLING_ENFORCEMENT}. A declared price does not prove payment.`,
    price_credits: service.price_credits,
    limitations: service.limitations,
  }));
}

export async function invokeMcpTool(
  handlers: DeliverCheckServiceHandlers,
  name: PublicServiceName,
  input: unknown,
  signal?: AbortSignal,
): Promise<McpToolResult> {
  switch (name) {
    case "diagnose":
      return handlers.diagnose(input, signal);
    case "repair":
      return handlers.repair(input, signal);
  }
}
