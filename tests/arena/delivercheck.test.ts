import { describe, expect, it, vi } from "vitest";

import { ProductionDeliverCheckRestClient } from "../../src/arena/delivercheck.js";
import { deliverCheckRequest } from "./fixtures.js";

describe("production DeliverCheck client boundary", () => {
  it("calls the configured production REST operation without credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ service: "diagnose", outcome: "valid" }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new ProductionDeliverCheckRestClient("https://delivercheck.vercel.app", fetcher);
    await client.invoke("diagnose", deliverCheckRequest());
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://delivercheck.vercel.app/api/v1/diagnose");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.stringify(init)).not.toMatch(/authorization|credential|token/i);
  });

  it("rejects origins containing credentials or path components", () => {
    expect(() => new ProductionDeliverCheckRestClient("https://user@example.com")).toThrow(/without credentials/);
    expect(() => new ProductionDeliverCheckRestClient("https://delivercheck.vercel.app/path")).toThrow(/HTTPS origin/);
  });
});
