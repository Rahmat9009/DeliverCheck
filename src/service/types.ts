import type { DeliverCheckResult, ValidationError } from "../types.js";
import type { PublicServiceName } from "../integrations/public-services.js";

export const SERVICE_VERSION = "0.1.0";
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const SERVICE_DEADLINE_MS = 5 * 60 * 1_000;

export interface BillingDeclaration {
  price_credits: 0 | 7;
  currency: "Arena credits";
  enforcement: "external_pending_official_sharednet_confirmation";
  payment_verified: false;
}

export interface DiagnosisProblem extends ValidationError {
  code: string;
}

export interface DiagnosisResult {
  service: "diagnose";
  outcome: "valid" | "incompatible" | "security_rejected";
  problems: DiagnosisProblem[];
  proves_factual_truth: false;
  billing: BillingDeclaration;
}

export interface RepairServiceResult {
  service: "repair";
  result: DeliverCheckResult;
  billing: BillingDeclaration;
}

export interface HealthResult {
  status: "ok";
  service: "DeliverCheck";
  implementation_version: string;
}

export interface PublicServiceErrorBody {
  error: {
    kind: "request" | "security" | "operational" | "integrity" | "routing";
    code: string;
    message: string;
  };
}

export interface McpToolDefinition {
  name: PublicServiceName;
  description: string;
  price_credits: 0 | 7;
  limitations: string;
}
