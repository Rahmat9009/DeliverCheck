import { describe, expect, it } from "vitest";

import {
  DISCOVERY_PATHS,
  createAgentCard,
  createDiscoveryDocument,
  createServiceListing,
} from "../../src/discovery/documents.js";

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
