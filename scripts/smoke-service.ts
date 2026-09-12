import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { DeliverCheckRequest } from "../src/types.js";
import { startNodeService } from "../src/service/node-server.js";

const request: DeliverCheckRequest = {
  request_id: "smoke-repair",
  input_format: "json",
  source_text: JSON.stringify({ name: "Amina", status: "done" }),
  target_schema: {
    type: "object",
    additionalProperties: false,
    required: ["full_name", "status"],
    properties: {
      full_name: { type: "string" },
      status: { type: "string", enum: ["complete", "pending"] },
    },
  },
  explicit_rules: [
    'Rename field "name" to "full_name".',
    'Normalize "status" value "done" to "complete".',
  ],
};

const timings: { operation: string; elapsed_ms: number }[] = [];

async function timed<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await fn();
  timings.push({ operation, elapsed_ms: performance.now() - started });
  return result;
}

async function jsonFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${service.origin}${path}`, init);
  if (!response.ok) {
    throw new Error(`Smoke request to ${path} failed with ${response.status}`);
  }
  return await response.json() as Record<string, unknown>;
}

const service = await startNodeService();
let client: Client | undefined;
try {
  const health = await timed("health", () => jsonFetch("/health"));
  const card = await timed("agent_card", () => jsonFetch("/.well-known/agent.json"));
  const listing = await timed("listing", () => jsonFetch("/api/v1/listing"));
  const diagnose = await timed("diagnose_rest", () => jsonFetch("/api/v1/diagnose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, request_id: "smoke-diagnose" }),
  }));
  const repair = await timed("repair_rest", () => jsonFetch("/api/v1/repair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  }));

  client = new Client({ name: "delivercheck-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/api/mcp", service.origin));
  await timed("mcp_connect", () => client!.connect(transport));
  const tools = await timed("mcp_list_tools", () => client!.listTools());
  const mcpDiagnosis = await timed("mcp_diagnose", () => client!.callTool({
    name: "diagnose",
    arguments: { ...request, request_id: "smoke-mcp" },
  }));

  if (
    health["status"] !== "ok" ||
    card["name"] !== "DeliverCheck" ||
    !Array.isArray(listing["tools"]) ||
    diagnose["service"] !== "diagnose" ||
    repair["service"] !== "repair" ||
    tools.tools.map((tool) => tool.name).join(",") !== "diagnose,repair" ||
    mcpDiagnosis.isError === true ||
    mcpDiagnosis.structuredContent === undefined
  ) {
    throw new Error("A smoke assertion failed");
  }

  const measured = timings.map(({ elapsed_ms }) => elapsed_ms);
  const average = measured.reduce((sum, value) => sum + value, 0) / measured.length;
  const maximum = Math.max(...measured);
  process.stdout.write(`${JSON.stringify({
    label: "local_deterministic_smoke_test",
    live_arena_call: false,
    cloud_execution: false,
    endpoints: ["health", "agent_card", "listing", "diagnose", "repair", "mcp"],
    mcp_tools: tools.tools.map((tool) => tool.name),
    repair_status: (repair["result"] as Record<string, unknown>)["status"],
    latency_sample_count: timings.length,
    average_observed_local_latency_ms: Number(average.toFixed(3)),
    maximum_observed_local_latency_ms: Number(maximum.toFixed(3)),
    timings: timings.map((item) => ({
      operation: item.operation,
      elapsed_ms: Number(item.elapsed_ms.toFixed(3)),
    })),
  })}\n`);
} finally {
  await client?.close();
  await service.close();
}
