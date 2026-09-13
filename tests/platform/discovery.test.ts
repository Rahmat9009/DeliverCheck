import { describe, expect, it } from "vitest";

import {
  BUYER_GUIDE,
  COMPATIBILITY_PROFILES,
  DISCOVERY_PATHS,
  createAgentCard,
  createDiscoveryDocument,
  createServiceListing,
} from "../../src/discovery/documents.js";
import { validateRequestContract } from "../../src/verify/validate.js";

const PRODUCTION_ORIGIN = "https://delivercheck.vercel.app";

describe("public discovery documents", () => {
  it("publishes the declared service names and prices", () => {
    const listing = createServiceListing();

    expect(listing.tools.map(({ name, price_credits }) => ({ name, price_credits }))).toEqual([
      { name: "diagnose", price_credits: 0 },
      { name: "repair", price_credits: 7 },
    ]);
    expect(listing.pricing.billing_enforcement).toBe(
      "external_pending_official_sharednet_confirmation",
    );
    expect(listing.pricing.payment_verification).toBe("not_implemented");
  });

  it("publishes identical live buyer guidance without changing schema versions", () => {
    const listing = createServiceListing();
    const card = createAgentCard(PRODUCTION_ORIGIN);

    expect(listing.schema_version).toBe("delivercheck.service-listing.v1");
    expect(card.schema_version).toBe("delivercheck.agent-card.v1");
    expect(listing.implementation_status).toBe("live_public_service");
    expect(card.implementation_status).toBe("live_public_service");
    expect(listing.buyer_guide).toBe(BUYER_GUIDE);
    expect(card.buyer_guide).toBe(BUYER_GUIDE);
    expect(card.buyer_guide).toEqual(listing.buyer_guide);
    expect(listing.compatibility_profiles).toBe(COMPATIBILITY_PROFILES);
    expect(card.compatibility_profiles).toEqual(listing.compatibility_profiles);
    expect(COMPATIBILITY_PROFILES.profiles.map(({ name }) => name)).toEqual([
      "claim_verdict",
      "trust_decision",
      "purchase_receipt",
      "risk_report",
    ]);
  });

  it("keeps listing paths relative and production agent-card URLs absolute", () => {
    const listing = createServiceListing();
    const card = createAgentCard(PRODUCTION_ORIGIN);

    expect(Object.values(listing.endpoints).every((path) => path.startsWith("/"))).toBe(true);
    expect(Object.values(card.endpoints).every((url) => url.startsWith(`${PRODUCTION_ORIGIN}/`)))
      .toBe(true);
    expect(JSON.stringify({ listing, card })).not.toMatch(
      /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/iu,
    );
  });

  it("publishes a frozen-contract-valid enum normalization example on the listing only", () => {
    const listing = createServiceListing();
    const card = createAgentCard(PRODUCTION_ORIGIN);

    expect(validateRequestContract(listing.example_request.request).valid).toBe(true);
    expect(listing.example_request.request.source_text).toBe('{"status":"done"}');
    expect(listing.example_request.expected_outcomes).toEqual({
      diagnose: "incompatible",
      repair: "passed_checks",
    });
    expect(card).not.toHaveProperty("example_request");
  });

  it("generates HTTPS discovery URLs without credentials", () => {
    const card = createAgentCard("https://delivercheck.example/some/path");

    expect(card.endpoints.listing).toBe("https://delivercheck.example/api/v1/listing");
    expect(card.endpoints.mcp).toBe("https://delivercheck.example/api/mcp");
    expect(() => createAgentCard("https://user:secret@delivercheck.example")).toThrow(
      /credentials/u,
    );
  });

  it("only treats the agent card and listing as discovery documents", () => {
    expect(createDiscoveryDocument(DISCOVERY_PATHS.listing, "https://delivercheck.example"))
      .toEqual(createServiceListing());
    expect(() => createDiscoveryDocument(DISCOVERY_PATHS.mcp, "https://delivercheck.example"))
      .toThrow(/not a discovery document/u);
  });
});
