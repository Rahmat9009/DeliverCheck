import {
  PUBLIC_SERVICES,
  PUBLIC_SERVICE_CURRENCY,
} from "../integrations/public-services.js";
import {
  DELIVERCHECK_IDENTITY_STRINGS,
  DELIVERCHECK_PURPOSE,
} from "../sharedos/identities.js";

export const DISCOVERY_PATHS = {
  agent_card: "/.well-known/agent.json",
  listing: "/api/v1/listing",
  mcp: "/api/mcp",
} as const;

export type DiscoveryPath = (typeof DISCOVERY_PATHS)[keyof typeof DISCOVERY_PATHS];

export const PRODUCT_POSITIONING =
  "DeliverCheck makes one agent’s output usable by the next.";

export function createServiceListing() {
  return {
    schema_version: "delivercheck.service-listing.v1",
    service_id: DELIVERCHECK_IDENTITY_STRINGS.service,
    name: "DeliverCheck",
    positioning: PRODUCT_POSITIONING,
    implementation_status: "platform_boundary_only",
    purpose: DELIVERCHECK_PURPOSE,
    pricing: {
      currency: PUBLIC_SERVICE_CURRENCY,
      settlement_method: "unconfirmed",
    },
    tools: PUBLIC_SERVICES.map((service) => ({ ...service })),
    endpoints: {
      agent_card: { path: DISCOVERY_PATHS.agent_card, status: "document_ready" },
      listing: { path: DISCOVERY_PATHS.listing, status: "document_ready" },
      mcp: { path: DISCOVERY_PATHS.mcp, status: "future" },
    },
  } as const;
}

function normalizedOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("Discovery base URL must not contain credentials, a query, or a fragment");
  }
  if (url.protocol !== "https:") {
    throw new TypeError("Public discovery requires an HTTPS base URL");
  }
  return url.origin;
}

export function createAgentCard(baseUrl: string) {
  const origin = normalizedOrigin(baseUrl);
  return {
    schema_version: "delivercheck.agent-card.v1",
    name: "DeliverCheck",
    identity: DELIVERCHECK_IDENTITY_STRINGS.service,
    positioning: PRODUCT_POSITIONING,
    implementation_status: "platform_boundary_only",
    agents: [
      DELIVERCHECK_IDENTITY_STRINGS.intake,
      DELIVERCHECK_IDENTITY_STRINGS.repair,
      DELIVERCHECK_IDENTITY_STRINGS.verifier,
    ],
    endpoints: {
      listing: new URL(DISCOVERY_PATHS.listing, origin).href,
      mcp: { url: new URL(DISCOVERY_PATHS.mcp, origin).href, status: "future" },
    },
    tools: PUBLIC_SERVICES.map(({ name, description }) => ({ name, description })),
  } as const;
}

export class DiscoveryEndpointUnavailableError extends Error {
  readonly code = "endpoint_not_implemented";

  constructor(readonly path: string) {
    super(`${path} is declared for future implementation`);
    this.name = "DiscoveryEndpointUnavailableError";
  }
}

export function createDiscoveryDocument(path: DiscoveryPath, baseUrl: string): unknown {
  if (path === DISCOVERY_PATHS.agent_card) {
    return createAgentCard(baseUrl);
  }
  if (path === DISCOVERY_PATHS.listing) {
    return createServiceListing();
  }
  throw new DiscoveryEndpointUnavailableError(path);
}
