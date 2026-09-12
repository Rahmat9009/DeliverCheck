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

export function createServiceListing() {
  return {
    schema_version: "delivercheck.service-listing.v1",
    service_id: DELIVERCHECK_IDENTITY_STRINGS.service,
    name: "DeliverCheck",
    tagline: PRODUCT_TAGLINE,
    scope: PRODUCT_SCOPE,
    implementation_status: "local_service_ready",
    purpose: DELIVERCHECK_PURPOSE,
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
      status: "not_configured_locally",
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
    implementation_status: "local_service_ready",
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
      status: "not_configured_locally",
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
