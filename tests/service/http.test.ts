import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCorePipeline } from "../../src/coordinator/index.js";
import { createServiceHandlers, startNodeService, type RunningNodeService } from "../../src/service/index.js";
import { repairRequest, serviceRequest } from "./fixtures.js";

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("Node REST service adapter", () => {
  let running: RunningNodeService;

  beforeAll(async () => {
    running = await startNodeService();
  });

  afterAll(async () => {
    await running.close();
  });

  it("serves health and both discovery documents", async () => {
    const [health, card, listing] = await Promise.all([
      fetch(`${running.origin}/health`),
      fetch(`${running.origin}/.well-known/agent.json`),
      fetch(`${running.origin}/api/v1/listing`),
    ]);
    expect(await responseJson(health)).toMatchObject({ status: "ok", service: "DeliverCheck" });
    expect(await responseJson(card)).toMatchObject({ name: "DeliverCheck" });
    expect(await responseJson(listing)).toMatchObject({
      tools: [{ name: "diagnose", price_credits: 0 }, { name: "repair", price_credits: 7 }],
    });
  });

  it("rejects malformed JSON", async () => {
    const response = await fetch(`${running.origin}/api/v1/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({ error: { code: "malformed_json" } });
  });

  it("rejects a non-JSON content type", async () => {
    const response = await fetch(`${running.origin}/api/v1/diagnose`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(serviceRequest()),
    });
    expect(response.status).toBe(415);
    expect(await responseJson(response)).toMatchObject({ error: { code: "unsupported_content_type" } });
  });

  it("rejects a request body larger than 64 KiB", async () => {
    const response = await fetch(`${running.origin}/api/v1/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(serviceRequest({ source_text: "x".repeat(70_000) })),
    });
    expect(response.status).toBe(413);
    expect(await responseJson(response)).toMatchObject({ error: { code: "request_body_too_large" } });
  });

  it("rejects unsupported methods and query parameters", async () => {
    const methodResponse = await fetch(`${running.origin}/api/v1/repair`, { method: "PUT" });
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("POST");

    const queryResponse = await fetch(`${running.origin}/health?grants=all`);
    expect(queryResponse.status).toBe(400);
    expect(await responseJson(queryResponse)).toMatchObject({ error: { code: "query_parameters_rejected" } });
  });

  it("does not let headers weaken SharedOS authorization", async () => {
    const deniedHandlers = createServiceHandlers({
      pipeline: createCorePipeline({ authorized_stages: ["repair"] }),
    });
    const deniedService = await startNodeService({ handlers: deniedHandlers });
    try {
      const response = await fetch(`${deniedService.origin}/api/v1/repair`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sharedos-grants": "all",
          "x-caller-identity": "agent:verifier.delivercheck",
        },
        body: JSON.stringify(repairRequest()),
      });
      expect(response.status).toBe(503);
      expect(await responseJson(response)).toMatchObject({
        error: { kind: "operational", code: "stage_denied" },
      });
    } finally {
      await deniedService.close();
    }
  });

  it("sanitizes an unexpected internal failure", async () => {
    const secretDetail = "private-stack-and-payload-detail";
    const failingService = await startNodeService({
      handlers: createServiceHandlers({
        pipeline: { run: async () => { throw new Error(secretDetail); } },
      }),
    });
    try {
      const response = await fetch(`${failingService.origin}/api/v1/repair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(repairRequest()),
      });
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(text).not.toContain(secretDetail);
      expect(text).not.toContain("stack");
      expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error" } });
    } finally {
      await failingService.close();
    }
  });
});
