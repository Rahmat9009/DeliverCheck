import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCorePipeline } from "../../src/coordinator/index.js";
import { createDeliverCheckMcpServer, createServiceHandlers } from "../../src/service/index.js";
import { repairRequest, serviceRequest } from "./fixtures.js";
import { MAX_EXPLICIT_RULES } from "../../src/repair/constants.js";

describe("official MCP service adapter", () => {
  let client: Client;
  let server: ReturnType<typeof createDeliverCheckMcpServer>;

  beforeEach(async () => {
    const handlers = createServiceHandlers({ pipeline: createCorePipeline({ now: () => 1_000 }) });
    server = createDeliverCheckMcpServer(handlers);
    client = new Client({ name: "delivercheck-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("lists only diagnose and repair with exact price metadata and limitations", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(["diagnose", "repair"]);
    expect(result.tools[0]).toMatchObject({
      _meta: {
        "delivercheck/priceCredits": 0,
        "delivercheck/paymentVerified": false,
      },
    });
    expect(result.tools[1]).toMatchObject({
      _meta: {
        "delivercheck/priceCredits": 7,
        "delivercheck/paymentVerified": false,
      },
    });
    expect(result.tools[0]?.description).toContain("Price: 0 Arena credits");
    expect(result.tools[1]?.description).toContain("Price: 7 Arena credits");
    expect(result.tools.every((tool) => tool.description?.includes("Limitation:"))).toBe(true);
  });

  it("invokes diagnose with machine-readable structured content", async () => {
    const result = await client.callTool({ name: "diagnose", arguments: { ...serviceRequest() } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      service: "diagnose",
      outcome: "valid",
      proves_factual_truth: false,
      billing: { price_credits: 0, payment_verified: false },
    });
  });

  it("invokes the verified repair pipeline with structured content", async () => {
    const result = await client.callTool({ name: "repair", arguments: { ...repairRequest() } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      service: "repair",
      result: { status: "passed_checks", candidate: { full_name: "Amina", status: "complete" } },
      billing: { price_credits: 7, payment_verified: false },
    });
  });

  it("returns the same explicit-rule limit through MCP", async () => {
    const result = await client.callTool({
      name: "diagnose",
      arguments: {
        ...serviceRequest(),
        explicit_rules: Array.from(
          { length: MAX_EXPLICIT_RULES + 1 },
          (_, index) => `Context note ${index}.`,
        ),
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "explicit_rule_limit_exceeded",
        message: expect.stringContaining(String(MAX_EXPLICIT_RULES)),
      },
    });
  });
});
