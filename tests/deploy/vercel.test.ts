import { readFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCorePipeline } from "../../src/coordinator/index.js";
import {
  createHttpsAuditExporter,
  createVercelDeploymentAdapter,
  type AuditableCorePipeline,
  type SharedOSCloudAuditExporter,
  type VercelDeploymentAdapter,
} from "../../src/deploy/index.js";
import { repairRequest, serviceRequest } from "../service/fixtures.js";
import { GET as agentCardRoute } from "../../api/agent-card.js";
import { GET as healthRoute } from "../../api/health.js";
import { POST as mcpRoute } from "../../api/mcp.js";
import { GET as listingRoute } from "../../api/v1/listing.js";
import { POST as diagnoseRoute } from "../../api/v1/diagnose.js";
import { POST as repairRoute } from "../../api/v1/repair.js";

const BASE_URL = "https://delivercheck.test";
const FIXED_ENVIRONMENT = { PUBLIC_BASE_URL: BASE_URL } as const;
const openAdapters: VercelDeploymentAdapter[] = [];

function adapter(
  options: Parameters<typeof createVercelDeploymentAdapter>[0] = {},
): VercelDeploymentAdapter {
  const created = createVercelDeploymentAdapter({
    environment: FIXED_ENVIRONMENT,
    ...options,
  });
  openAdapters.push(created);
  return created;
}

function requestFor(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function loopbackPost(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(openAdapters.splice(0).map((entry) => entry.close()));
});

describe("Vercel stateless deployment adapter", () => {
  it("exports callable framework-free Vercel route methods", async () => {
    expect(mcpRoute).toBeTypeOf("function");
    const calls = await Promise.all([
      healthRoute(new Request("http://127.0.0.1/health")),
      agentCardRoute(new Request("http://127.0.0.1/.well-known/agent.json")),
      listingRoute(new Request("http://127.0.0.1/api/v1/listing")),
      diagnoseRoute(loopbackPost("/api/v1/diagnose", serviceRequest())),
      repairRoute(loopbackPost("/api/v1/repair", repairRequest())),
    ]);

    expect(calls.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it("wraps health and both discovery documents", async () => {
    const deployment = adapter();
    const [health, card, listing] = await Promise.all([
      deployment.handle("health", requestFor("/health", "GET")),
      deployment.handle("agent_card", requestFor("/.well-known/agent.json", "GET")),
      deployment.handle("listing", requestFor("/api/v1/listing", "GET")),
    ]);

    expect(await bodyOf(health)).toMatchObject({ status: "ok", service: "DeliverCheck" });
    expect(await bodyOf(card)).toMatchObject({
      name: "DeliverCheck",
      endpoints: { mcp: `${BASE_URL}/api/mcp` },
    });
    expect(await bodyOf(listing)).toMatchObject({
      tools: [{ name: "diagnose", price_credits: 0 }, { name: "repair", price_credits: 7 }],
    });
  });

  it("wraps diagnose and complete verified repair", async () => {
    const deployment = adapter();
    const diagnosis = await deployment.handle(
      "diagnose",
      requestFor("/api/v1/diagnose", "POST", serviceRequest()),
    );
    const repair = await deployment.handle(
      "repair",
      requestFor("/api/v1/repair", "POST", repairRequest()),
    );

    expect(await bodyOf(diagnosis)).toMatchObject({
      service: "diagnose",
      outcome: "valid",
      proves_factual_truth: false,
    });
    expect(await bodyOf(repair)).toMatchObject({
      service: "repair",
      result: { status: "passed_checks" },
      billing: { price_credits: 7, payment_verified: false },
    });
  });

  it("preserves method, media type, query, origin, and 64 KiB limits", async () => {
    const deployment = adapter();
    const wrongMethod = await deployment.handle(
      "health",
      requestFor("/health", "POST", {}),
    );
    const wrongType = await deployment.handle(
      "diagnose",
      requestFor("/api/v1/diagnose", "POST", serviceRequest(), {
        "content-type": "text/plain",
      }),
    );
    const query = await deployment.handle(
      "health",
      requestFor("/health?authority=all", "GET"),
    );
    const foreignOrigin = await deployment.handle(
      "health",
      requestFor("/health", "GET", undefined, {
        origin: "https://attacker.example",
      }),
    );
    const wrongSchemeOrigin = await deployment.handle(
      "health",
      requestFor("/health", "GET", undefined, {
        origin: "http://delivercheck.test",
      }),
    );
    const oversized = await deployment.handle(
      "diagnose",
      requestFor(
        "/api/v1/diagnose",
        "POST",
        serviceRequest({ source_text: "x".repeat(70_000) }),
      ),
    );

    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(wrongType.status).toBe(415);
    expect(query.status).toBe(400);
    expect(foreignOrigin.status).toBe(403);
    expect(wrongSchemeOrigin.status).toBe(403);
    expect(oversized.status).toBe(413);
  });

  it("does not infer caller identity or grants from bodies or headers", async () => {
    const deployment = adapter({
      pipeline_factory: () => createCorePipeline({ authorized_stages: ["repair"] }),
    });
    const bodyClaim = await deployment.handle(
      "repair",
      requestFor("/api/v1/repair", "POST", {
        ...repairRequest(),
        caller_identity: "agent:verifier.delivercheck",
      }),
    );
    const headerClaim = await deployment.handle(
      "repair",
      requestFor("/api/v1/repair", "POST", repairRequest(), {
        authorization: "Bearer untrusted-example",
        "x-caller-identity": "agent:verifier.delivercheck",
        "x-sharedos-grants": "all",
      }),
    );

    expect(await bodyOf(bodyClaim)).toMatchObject({ error: { code: "invalid_request" } });
    expect(await bodyOf(headerClaim)).toMatchObject({
      error: { kind: "operational", code: "stage_denied" },
    });
  });

  it("sanitizes unexpected deployment failures", async () => {
    const privateDetail = "private-deployment-stack-detail";
    const failingPipeline: AuditableCorePipeline = {
      run: async () => { throw new Error(privateDetail); },
      auditSnapshot: () => [],
    };
    const deployment = adapter({ pipeline_factory: () => failingPipeline });
    const response = await deployment.handle(
      "repair",
      requestFor("/api/v1/repair", "POST", repairRequest()),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain(privateDetail);
    expect(text).not.toContain("stack");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error" } });
  });

  it("preserves the five-minute application and Vercel limits", async () => {
    const configuration = JSON.parse(
      await readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
    ) as { fluid: boolean; functions: Record<string, { maxDuration: number; supportsCancellation: boolean }> };
    expect(configuration.fluid).toBe(true);
    expect(configuration.functions["api/**/*.ts"]).toEqual({
      maxDuration: 300,
      supportsCancellation: true,
    });

    const waitingPipeline: AuditableCorePipeline = {
      async run(_input, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
      auditSnapshot: () => [],
    };
    const deployment = adapter({
      deadline_ms: 2,
      pipeline_factory: () => waitingPipeline,
    });
    const response = await deployment.handle(
      "repair",
      requestFor("/api/v1/repair", "POST", repairRequest()),
    );
    expect(response.status).toBe(504);
    expect(await bodyOf(response)).toMatchObject({
      error: { kind: "operational", code: "request_deadline_exceeded" },
    });
  });

  it("runs MCP discovery and tools through independent stateless requests", async () => {
    let pipelineCount = 0;
    const deployment = adapter({
      pipeline_factory: () => {
        pipelineCount += 1;
        return createCorePipeline({ now: () => 1_000 });
      },
    });
    const fetchThroughAdapter: typeof fetch = async (input, init) => {
      const incoming = new Request(input, init);
      return deployment.handle("mcp", incoming);
    };
    const client = new Client({ name: "vercel-adapter-test", version: "0.1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(
        new URL("/api/mcp", BASE_URL),
        { fetch: fetchThroughAdapter },
      ));
      const tools = await client.listTools();
      const result = await client.callTool({
        name: "repair",
        arguments: { ...repairRequest(), request_id: "vercel-mcp-repair" },
      });

      expect(tools.tools.map((tool) => tool.name)).toEqual(["diagnose", "repair"]);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        service: "repair",
        result: { status: "passed_checks" },
      });
      expect(pipelineCount).toBeGreaterThanOrEqual(3);
    } finally {
      await client.close();
    }
  });
});

describe("optional SharedOS Cloud audit export", () => {
  it("does not export when SHAREDOS_KEY is absent", async () => {
    const exportCall = vi.fn<SharedOSCloudAuditExporter["export"]>();
    const deployment = adapter({
      cloud_audit_exporter: { export: exportCall },
    });
    const response = await deployment.handle(
      "repair",
      requestFor("/api/v1/repair", "POST", repairRequest()),
    );
    expect(response.status).toBe(200);
    expect(exportCall).not.toHaveBeenCalled();
  });

  it("exports only sanitized audit outcomes when explicitly configured", async () => {
    const exportCall = vi.fn<SharedOSCloudAuditExporter["export"]>().mockResolvedValue();
    const deployment = adapter({
      environment: {
        PUBLIC_BASE_URL: BASE_URL,
        SHAREDOS_KEY: "synthetic-test-key",
      },
      cloud_audit_exporter: { export: exportCall },
    });
    const response = await deployment.handle(
      "repair",
      requestFor("/api/v1/repair", "POST", repairRequest()),
    );
    expect(response.status).toBe(200);
    expect(exportCall).toHaveBeenCalledOnce();
    const events = exportCall.mock.calls[0]?.[0];
    expect(events?.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("source_text");
    expect(JSON.stringify(events)).not.toContain("target_schema");
    expect(JSON.stringify(events)).not.toContain("synthetic-test-key");
  });

  it("turns a Cloud export failure after successful verification into an operational error", async () => {
    const exporter: SharedOSCloudAuditExporter = {
      export: async () => { throw new Error("synthetic cloud outage"); },
    };
    const deployment = adapter({
      environment: { PUBLIC_BASE_URL: BASE_URL, SHAREDOS_KEY: "synthetic-test-key" },
      cloud_audit_exporter: exporter,
    });
    const response = await deployment.handle(
      "repair",
      requestFor("/api/v1/repair", "POST", repairRequest()),
    );
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({
      error: { kind: "operational", code: "audit_export_failed" },
    });
  });

  it("does not replace an authorization denial when Cloud export also fails", async () => {
    const deployment = adapter({
      environment: { PUBLIC_BASE_URL: BASE_URL, SHAREDOS_KEY: "synthetic-test-key" },
      pipeline_factory: () => createCorePipeline({ authorized_stages: ["repair"] }),
      cloud_audit_exporter: {
        export: async () => { throw new Error("synthetic cloud outage"); },
      },
    });
    const response = await deployment.handle(
      "repair",
      requestFor("/api/v1/repair", "POST", repairRequest()),
    );
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({ error: { code: "stage_denied" } });
  });

  it("fails closed when a key is configured without an audit endpoint or exporter", async () => {
    const deployment = adapter({
      environment: { PUBLIC_BASE_URL: BASE_URL, SHAREDOS_KEY: "synthetic-test-key" },
    });
    const response = await deployment.handle(
      "repair",
      requestFor("/api/v1/repair", "POST", repairRequest()),
    );
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({
      error: { code: "audit_export_unavailable" },
    });
  });

  it("keeps the configured key out of HTTPS audit payloads and errors", async () => {
    const syntheticKey = "synthetic-test-key";
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const exporter = createHttpsAuditExporter({
      endpoint: "https://audit.sharedos.test/events",
      sharedos_key: syntheticKey,
      fetch_impl: request,
    });
    await exporter.export([
      {
        type: "authorization.checked",
        outcome: "allowed",
        actor: "agent:repair.delivercheck",
        trace_id: "trace:test",
      },
    ]);

    const init = request.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${syntheticKey}`);
    expect(String(init?.body)).not.toContain(syntheticKey);
  });
});
