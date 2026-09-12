import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { DISCOVERY_PATHS } from "../discovery/documents.js";
import { publicErrorBody, ServiceError, toServiceError } from "./errors.js";
import { createServiceHandlers, type DeliverCheckServiceHandlers } from "./handlers.js";
import { createDeliverCheckMcpHandler } from "./mcp.js";
import { MAX_REQUEST_BODY_BYTES, SERVICE_DEADLINE_MS } from "./types.js";

export interface NodeServiceOptions {
  handlers?: DeliverCheckServiceHandlers;
  host?: string;
  port?: number;
  public_base_url?: string;
  allowed_hostnames?: readonly string[];
}

export interface RunningNodeService {
  server: Server;
  origin: string;
  close(): Promise<void>;
}

const DEFAULT_ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

interface ParsedHost {
  hostname: string;
  host: string;
  port: string;
}

function parsedHost(hostHeader: string | undefined): ParsedHost | undefined {
  if (hostHeader === undefined) return undefined;
  try {
    const url = new URL(`http://${hostHeader}`);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return { hostname: url.hostname, host: url.host, port: url.port };
  } catch {
    return undefined;
  }
}

function validateRequestOrigin(
  request: IncomingMessage,
  allowedHostnames: ReadonlySet<string>,
  serviceOrigin: string | undefined,
): void {
  const host = parsedHost(request.headers.host);
  if (host === undefined || !allowedHostnames.has(host.hostname)) {
    throw new ServiceError(403, "security", "host_rejected", "The request host is not allowed.");
  }
  if (serviceOrigin !== undefined) {
    const configured = new URL(serviceOrigin);
    if (configured.hostname === host.hostname && configured.host !== host.host) {
      throw new ServiceError(403, "security", "host_rejected", "The request host is not allowed.");
    }
  } else if (
    host.port !== "" &&
    host.port !== String(request.socket.localPort ?? "")
  ) {
    throw new ServiceError(403, "security", "host_rejected", "The request host is not allowed.");
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsedOrigin: URL | undefined;
    try {
      const candidate = new URL(origin);
      if (
        candidate.username === "" &&
        candidate.password === "" &&
        candidate.pathname === "/" &&
        candidate.search === "" &&
        candidate.hash === ""
      ) {
        parsedOrigin = candidate;
      }
    } catch {
      parsedOrigin = undefined;
    }
    if (parsedOrigin === undefined || !allowedHostnames.has(parsedOrigin.hostname)) {
      throw new ServiceError(403, "security", "origin_rejected", "The request origin is not allowed.");
    }
    if (
      serviceOrigin !== undefined &&
      new URL(serviceOrigin).hostname === parsedOrigin.hostname &&
      new URL(serviceOrigin).origin !== parsedOrigin.origin
    ) {
      throw new ServiceError(403, "security", "origin_rejected", "The request origin is not allowed.");
    }
  }
}

function requireJsonContentType(request: IncomingMessage): void {
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ServiceError(415, "request", "unsupported_content_type", "Content-Type must be application/json.");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    request.pause();
    throw new ServiceError(413, "security", "request_body_too_large", "The request body exceeds 64 KiB.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      request.pause();
      throw new ServiceError(413, "security", "request_body_too_large", "The request body exceeds 64 KiB.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ServiceError(400, "request", "malformed_json", "The request body is not valid JSON.");
  }
}

function methodNotAllowed(response: ServerResponse, allowed: string): void {
  response.setHeader("allow", allowed);
  sendJson(
    response,
    405,
    publicErrorBody(new ServiceError(405, "routing", "method_not_allowed", "The HTTP method is not supported for this endpoint.")),
  );
}

export function createNodeService(options: NodeServiceOptions = {}): {
  server: Server;
  setOrigin(origin: string): void;
  closeMcp(): Promise<void>;
} {
  const handlers = options.handlers ?? createServiceHandlers();
  const mcpHandler = createDeliverCheckMcpHandler(handlers);
  const nodeMcpHandler = toNodeHandler(mcpHandler, { onerror: () => undefined });
  const allowedHostnames = new Set(options.allowed_hostnames ?? DEFAULT_ALLOWED_HOSTNAMES);
  let serviceOrigin = options.public_base_url;

  const server = createServer(async (request, response) => {
    try {
      validateRequestOrigin(request, allowedHostnames, serviceOrigin);
      const url = new URL(request.url ?? "/", "http://local.invalid");
      if (url.search !== "") {
        throw new ServiceError(400, "security", "query_parameters_rejected", "Query parameters are not accepted.");
      }
      const path = url.pathname;

      if (path === DISCOVERY_PATHS.health) {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        return sendJson(response, 200, handlers.health());
      }
      if (path === DISCOVERY_PATHS.agent_card) {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        return sendJson(response, 200, handlers.agentCard(serviceOrigin ?? "http://127.0.0.1"));
      }
      if (path === DISCOVERY_PATHS.listing) {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        return sendJson(response, 200, handlers.serviceListing());
      }
      if (path === DISCOVERY_PATHS.diagnose || path === DISCOVERY_PATHS.repair) {
        if (request.method !== "POST") return methodNotAllowed(response, "POST");
        requireJsonContentType(request);
        const input = await readJsonBody(request);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("Service deadline exceeded", "TimeoutError")), SERVICE_DEADLINE_MS);
        timer.unref();
        request.once("aborted", () => controller.abort());
        try {
          const result = path === DISCOVERY_PATHS.diagnose
            ? await handlers.diagnose(input, controller.signal)
            : await handlers.repair(input, controller.signal);
          return sendJson(response, 200, result);
        } finally {
          clearTimeout(timer);
        }
      }
      if (path === DISCOVERY_PATHS.mcp) {
        if (request.method !== "POST") return methodNotAllowed(response, "POST");
        requireJsonContentType(request);
        const input = await readJsonBody(request);
        return await nodeMcpHandler(
          request as IncomingMessage & { method: string; url: string },
          response,
          input,
        );
      }

      throw new ServiceError(404, "routing", "not_found", "The requested endpoint does not exist.");
    } catch (error) {
      if (!response.headersSent) {
        const safe = toServiceError(error);
        if (safe.code === "request_body_too_large") {
          response.shouldKeepAlive = false;
          response.setHeader("connection", "close");
        }
        sendJson(response, safe.status, publicErrorBody(safe));
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });
  server.requestTimeout = SERVICE_DEADLINE_MS;
  server.headersTimeout = 30_000;

  return {
    server,
    setOrigin(origin) {
      serviceOrigin = origin;
    },
    closeMcp: () => mcpHandler.close(),
  };
}

export async function startNodeService(
  options: NodeServiceOptions = {},
): Promise<RunningNodeService> {
  const host = options.host ?? "127.0.0.1";
  const service = createNodeService(options);
  service.server.listen(options.port ?? 0, host);
  await once(service.server, "listening");
  const address = service.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The Node service did not expose a TCP address.");
  }
  const origin = options.public_base_url ?? `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  service.setOrigin(origin);
  return {
    server: service.server,
    origin,
    async close() {
      await service.closeMcp();
      if (service.server.listening) {
        service.server.close();
        await once(service.server, "close");
      }
    },
  };
}
