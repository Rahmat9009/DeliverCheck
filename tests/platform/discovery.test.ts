import { describe, expect, it } from "vitest";

import {
  DISCOVERY_PATHS,
  DiscoveryEndpointUnavailableError,
  createAgentCard,
  createDiscoveryDocument,
  createServiceListing,
} from "../../src/discovery/documents.js";

describe("public discovery documents", () => {
  it("publishes the declared service names and prices", () => {
    const listing = createServiceListing();

    expect(listing.tools.map(({ name, price }) => ({ name, price }))).toEqual([
      { name: "diagnose", price: 0 },
      { name: "repair", price: 7 },
      { name: "bridge", price: 12 },
    ]);
    expect(listing.pricing.settlement_method).toBe("unconfirmed");
  });

  it("generates HTTPS discovery URLs without credentials", () => {
    const card = createAgentCard("https://delivercheck.example/some/path");

    expect(card.endpoints.listing).toBe("https://delivercheck.example/api/v1/listing");
    expect(card.endpoints.mcp).toEqual({
      url: "https://delivercheck.example/api/mcp",
      status: "future",
    });
    expect(() => createAgentCard("https://user:secret@delivercheck.example")).toThrow(
      /credentials/u,
    );
  });

  it("does not pretend the future MCP endpoint exists", () => {
    expect(() =>
      createDiscoveryDocument(DISCOVERY_PATHS.mcp, "https://delivercheck.example"),
    ).toThrow(DiscoveryEndpointUnavailableError);
  });
});
