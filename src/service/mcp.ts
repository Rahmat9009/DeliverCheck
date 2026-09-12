import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type JSONObject,
  type JsonSchemaType,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import requestSchema from "../../contracts/request.schema.json" with { type: "json" };
import type { DeliverCheckRequest } from "../types.js";
import { publicErrorBody } from "./errors.js";
import type { DeliverCheckServiceHandlers } from "./handlers.js";
import { createMcpToolDefinitions, invokeMcpTool } from "./mcp-tools.js";
import { SERVICE_VERSION } from "./types.js";

const frozenRequestSchema = fromJsonSchema<DeliverCheckRequest>(
  requestSchema as JsonSchemaType,
);

function jsonObject(value: object): JSONObject {
  return value as JSONObject;
}

function textContent(value: object) {
  return [{ type: "text" as const, text: JSON.stringify(value) }];
}

export function createDeliverCheckMcpServer(
  handlers: DeliverCheckServiceHandlers,
): McpServer {
  const server = new McpServer({ name: "DeliverCheck", version: SERVICE_VERSION });

  for (const tool of createMcpToolDefinitions()) {
    server.registerTool(
      tool.name,
      {
        title: `DeliverCheck ${tool.name}`,
        description: tool.description,
        inputSchema: frozenRequestSchema,
        annotations: {
          readOnlyHint: tool.name === "diagnose",
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: {
          "delivercheck/priceCredits": tool.price_credits,
          "delivercheck/currency": "Arena credits",
          "delivercheck/billingEnforcement":
            "external_pending_official_sharednet_confirmation",
          "delivercheck/paymentVerified": false,
          "delivercheck/limitations": tool.limitations,
        },
      },
      async (input, context) => {
        try {
          const output = await invokeMcpTool(
            handlers,
            tool.name,
            input,
            context.mcpReq.signal,
          );
          return {
            content: textContent(output),
            structuredContent: jsonObject(output),
          };
        } catch (error) {
          const output = publicErrorBody(error);
          return {
            isError: true,
            content: textContent(output),
            structuredContent: jsonObject(output),
          };
        }
      },
    );
  }

  return server;
}

export function createDeliverCheckMcpHandler(
  handlers: DeliverCheckServiceHandlers,
): McpHttpHandler {
  return createMcpHandler(() => createDeliverCheckMcpServer(handlers), {
    legacy: "stateless",
    // Errors are returned through sanitized protocol responses; no payloads are logged.
    onerror: () => undefined,
  });
}
