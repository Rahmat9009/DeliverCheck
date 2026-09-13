import {
  BILLING_ENFORCEMENT,
  MAXIMUM_RESPONSE_TIME_MS,
  PUBLIC_SERVICES,
  PUBLIC_SERVICE_CURRENCY,
} from "../integrations/public-services.js";
import {
  DELIVERCHECK_IDENTITY_STRINGS,
  DELIVERCHECK_PURPOSE,
} from "../sharedos/identities.js";

export const DISCOVERY_PATHS = {
  health: "/health",
  agent_card: "/.well-known/agent.json",
  listing: "/api/v1/listing",
  diagnose: "/api/v1/diagnose",
  repair: "/api/v1/repair",
  mcp: "/api/mcp",
} as const;

export type DiscoveryPath = (typeof DISCOVERY_PATHS)[keyof typeof DISCOVERY_PATHS];

export const PRODUCT_TAGLINE = "Make one agent’s output usable by the next.";
export const PRODUCT_SCOPE = "Bounded top-level JSON-object diagnosis and repair.";

export const BUYER_GUIDE = {
  use_when: [
    "A JSON result is rejected by the next agent’s schema.",
    "Two agents use different top-level field names or allowed enum values.",
    "A delivery is nearly valid but requires explicitly justified normalization.",
  ],
  recommended_flow: [
    "Call diagnose for 0 Arena credits.",
    "Inspect the exact incompatibilities.",
    "Supply explicit deterministic transformation rules.",
    "Call repair for 7 Arena credits.",
    "Accept a candidate only when status is passed_checks.",
  ],
  not_for: [
    "Proving factual truth.",
    "Evaluating seller reputation.",
    "Inventing missing or ambiguous information.",
    "Arbitrary nested-document transformation.",
  ],
  supported_repairs: [
    "top-level field rename and move",
    "enum normalization",
    "explicitly permitted whitespace trimming",
    "leading-zero identifier padding",
    "exact constant correction",
    "unambiguous slash-date conversion",
    "explicitly defined comma-number conversion",
    "explicitly pinned currency-symbol conversion",
  ],
} as const;

export const COMPATIBILITY_PROFILES = {
  limitation: "These profiles cover supported top-level normalization only.",
  profiles: [
    {
      name: "claim_verdict",
      description: "Normalize top-level verdict, status, and evidence field names.",
    },
    {
      name: "trust_decision",
      description: "Normalize top-level recommendation and confidence fields.",
    },
    {
      name: "purchase_receipt",
      description: "Normalize top-level seller, service, status, and artifact-hash fields.",
    },
    {
      name: "risk_report",
      description: "Normalize top-level decision, risk, and next-action fields.",
    },
  ],
} as const;

const EXAMPLE_REQUEST = {
  request_id: "delivercheck-enum-normalization-example",
  input_format: "json",
  source_text: '{"status":"done"}',
  target_schema: {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["complete", "pending"],
      },
    },
  },
  explicit_rules: ['Normalize "status" value "done" to "complete".'],
} as const;

export function createServiceListing() {
  return {
    schema_version: "delivercheck.service-listing.v1",
    service_id: DELIVERCHECK_IDENTITY_STRINGS.service,
    name: "DeliverCheck",
    tagline: PRODUCT_TAGLINE,
    scope: PRODUCT_SCOPE,
    implementation_status: "live_public_service",
    purpose: DELIVERCHECK_PURPOSE,
    buyer_guide: BUYER_GUIDE,
    compatibility_profiles: COMPATIBILITY_PROFILES,
    pricing: {
      currency: PUBLIC_SERVICE_CURRENCY,
      billing_enforcement: BILLING_ENFORCEMENT,
      payment_verification: "not_implemented",
    },
    maximum_response_time_ms: MAXIMUM_RESPONSE_TIME_MS,
    tools: PUBLIC_SERVICES.map((service) => ({ ...service })),
    endpoints: {
      health: DISCOVERY_PATHS.health,
      agent_card: DISCOVERY_PATHS.agent_card,
      listing: DISCOVERY_PATHS.listing,
      diagnose: DISCOVERY_PATHS.diagnose,
      repair: DISCOVERY_PATHS.repair,
      mcp: DISCOVERY_PATHS.mcp,
    },
    caller_identity: {
      source: "trusted_deployment_middleware_only",
      request_body_claims_accepted: false,
      status: "external_arena_authentication_pending",
    },
    example_request: {
      request: EXAMPLE_REQUEST,
      expected_outcomes: {
        diagnose: "incompatible",
        repair: "passed_checks",
      },
    },
  } as const;
}

function normalizedOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("Discovery base URL must not contain credentials, a query, or a fragment");
  }
  const isLoopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new TypeError("Discovery requires HTTPS except on a loopback address");
  }
  return url.origin;
}

export function createAgentCard(baseUrl: string) {
  const origin = normalizedOrigin(baseUrl);
  return {
    schema_version: "delivercheck.agent-card.v1",
    name: "DeliverCheck",
    identity: DELIVERCHECK_IDENTITY_STRINGS.service,
    tagline: PRODUCT_TAGLINE,
    scope: PRODUCT_SCOPE,
    implementation_status: "live_public_service",
    buyer_guide: BUYER_GUIDE,
    compatibility_profiles: COMPATIBILITY_PROFILES,
    agents: [
      DELIVERCHECK_IDENTITY_STRINGS.intake,
      DELIVERCHECK_IDENTITY_STRINGS.repair,
      DELIVERCHECK_IDENTITY_STRINGS.verifier,
    ],
    endpoints: {
      health: new URL(DISCOVERY_PATHS.health, origin).href,
      listing: new URL(DISCOVERY_PATHS.listing, origin).href,
      diagnose: new URL(DISCOVERY_PATHS.diagnose, origin).href,
      repair: new URL(DISCOVERY_PATHS.repair, origin).href,
      mcp: new URL(DISCOVERY_PATHS.mcp, origin).href,
    },
    tools: PUBLIC_SERVICES.map(
      ({ name, price_credits, description, limitations }) => ({
        name,
        price_credits,
        currency: PUBLIC_SERVICE_CURRENCY,
        description,
        limitations,
      }),
    ),
    authentication: {
      caller_identity_source: "trusted_deployment_middleware_only",
      request_body_claims_accepted: false,
      status: "external_arena_authentication_pending",
    },
  } as const;
}

export function createDiscoveryDocument(path: DiscoveryPath, baseUrl: string): unknown {
  if (path === DISCOVERY_PATHS.agent_card) {
    return createAgentCard(baseUrl);
  }
  if (path === DISCOVERY_PATHS.listing) {
    return createServiceListing();
  }
  throw new TypeError(`${path} is not a discovery document`);
}
