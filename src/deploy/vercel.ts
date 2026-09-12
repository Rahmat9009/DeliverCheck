import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { createCorePipeline } from "../coordinator/index.js";
import { publicErrorBody, ServiceError, toServiceError } from "../service/errors.js";
import { createServiceHandlers } from "../service/handlers.js";
import { createDeliverCheckMcpServer } from "../service/mcp.js";
import {
  MAX_REQUEST_BODY_BYTES,
  SERVICE_DEADLINE_MS,
} from "../service/types.js";
import {
  createHttpsAuditExporter,
  withOptionalCloudAudit,
  type AuditableCorePipeline,
  type SharedOSCloudAuditExporter,
} from "./cloud-audit.js";

export type VercelRoute =
  | "health"
  | "agent_card"
  | "listing"
  | "diagnose"
  | "repair"
  | "mcp";

export interface VercelDeploymentEnvironment {
  PUBLIC_BASE_URL?: string;
  SHAREDOS_KEY?: string;
  SHAREDOS_AUDIT_URL?: string;
  VERCEL_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
}

export interface VercelDeploymentOptions {
  environment?: VercelDeploymentEnvironment;
  pipeline_factory?: () => AuditableCorePipeline;
  cloud_audit_exporter?: SharedOSCloudAuditExporter;
  fetch_impl?: typeof fetch;
  deadline_ms?: number;
}

export interface VercelDeploymentAdapter {
  handle(route: VercelRoute, request: Request): Promise<Response>;
  close(): Promise<void>;
}

function environmentFromProcess(): VercelDeploymentEnvironment {
  return {
    ...(process.env.PUBLIC_BASE_URL === undefined
      ? {}
      : { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL }),
    ...(process.env.SHAREDOS_KEY === undefined
      ? {}
      : { SHAREDOS_KEY: process.env.SHAREDOS_KEY }),
    ...(process.env.SHAREDOS_AUDIT_URL === undefined
      ? {}
      : { SHAREDOS_AUDIT_URL: process.env.SHAREDOS_AUDIT_URL }),
    ...(process.env.VERCEL_URL === undefined
      ? {}
      : { VERCEL_URL: process.env.VERCEL_URL }),
    ...(process.env.VERCEL_PROJECT_PRODUCTION_URL === undefined
      ? {}
      : { VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL }),
  };
}

function publicBaseUrl(environment: VercelDeploymentEnvironment): string {
  if (environment.PUBLIC_BASE_URL !== undefined) {
    return environment.PUBLIC_BASE_URL;
  }
  const vercelHost = environment.VERCEL_URL ?? environment.VERCEL_PROJECT_PRODUCTION_URL;
  return vercelHost === undefined ? "http://127.0.0.1" : `https://${vercelHost}`;
}

function addTrustedHostname(target: Set<string>, candidate: string | undefined): void {
  if (candidate === undefined || candidate.length === 0) return;
  try {
    const url = candidate.includes("://")
      ? new URL(candidate)
      : new URL(`https://${candidate}`);
    if (
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    ) {
      target.add(url.hostname);
    }
  } catch {
    // Invalid deployment configuration is ignored here and rejected by discovery generation.
  }
}

function trustedHostnames(environment: VercelDeploymentEnvironment): ReadonlySet<string> {
  const hostnames = new Set<string>(["127.0.0.1", "localhost", "[::1]"]);
  addTrustedHostname(hostnames, environment.PUBLIC_BASE_URL);
  addTrustedHostname(hostnames, environment.VERCEL_URL);
  addTrustedHostname(hostnames, environment.VERCEL_PROJECT_PRODUCTION_URL);
  return hostnames;
}

function addTrustedOrigin(target: Set<string>, candidate: string | undefined): void {
  if (candidate === undefined || candidate.length === 0) return;
  try {
    const url = candidate.includes("://")
      ? new URL(candidate)
      : new URL(`https://${candidate}`);
    if (
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    ) {
      target.add(url.origin);
    }
  } catch {
    // Invalid deployment configuration cannot add a trusted origin.
  }
}

function trustedOrigins(environment: VercelDeploymentEnvironment): ReadonlySet<string> {
  const origins = new Set<string>([
    "http://127.0.0.1",
    "http://localhost",
    "http://[::1]",
  ]);
  addTrustedOrigin(origins, environment.PUBLIC_BASE_URL);
  addTrustedOrigin(origins, environment.VERCEL_URL);
  addTrustedOrigin(origins, environment.VERCEL_PROJECT_PRODUCTION_URL);
  return origins;
}

function validateOriginAndUrl(
  request: Request,
  allowedHostnames: ReadonlySet<string>,
  allowedOrigins: ReadonlySet<string>,
): void {
  const requestUrl = new URL(request.url);
  if (!allowedHostnames.has(requestUrl.hostname)) {
    throw new ServiceError(403, "security", "host_rejected", "The request host is not allowed.");
  }
  if (requestUrl.search !== "") {
    throw new ServiceError(400, "security", "query_parameters_rejected", "Query parameters are not accepted.");
  }

  const origin = request.headers.get("origin");
  if (origin !== null) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new ServiceError(403, "security", "origin_rejected", "The request origin is not allowed.");
    }
    if (
      !allowedOrigins.has(originUrl.origin) ||
      originUrl.username !== "" ||
      originUrl.password !== "" ||
      originUrl.pathname !== "/" ||
      originUrl.search !== "" ||
      originUrl.hash !== ""
    ) {
      throw new ServiceError(403, "security", "origin_rejected", "The request origin is not allowed.");
    }
  }
}

function requireMethod(request: Request, method: "GET" | "POST"): void {
  if (request.method !== method) {
    throw new ServiceError(405, "routing", "method_not_allowed", "The HTTP method is not supported for this endpoint.");
  }
}

function requireJsonContentType(request: Request): void {
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new ServiceError(415, "request", "unsupported_content_type", "Content-Type must be application/json.");
  }
}

async function readBoundedJson(
  request: Request,
): Promise<{ parsed: unknown; text: string }> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    await request.body?.cancel();
    throw new ServiceError(413, "security", "request_body_too_large", "The request body exceeds 64 KiB.");
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw new ServiceError(413, "security", "request_body_too_large", "The request body exceeds 64 KiB.");
      }
      chunks.push(next.value);
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ServiceError(400, "request", "malformed_json", "The request body is not valid UTF-8 JSON.");
  }
  try {
    return { parsed: JSON.parse(text) as unknown, text };
  } catch {
    throw new ServiceError(400, "request", "malformed_json", "The request body is not valid JSON.");
  }
}

function jsonResponse(value: unknown, status = 200, allow?: string): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  if (allow !== undefined) headers.set("allow", allow);
  return new Response(JSON.stringify(value), { status, headers });
}

function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function deadlineSignal(request: Request, timeoutMs: number): AbortSignal {
  return AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
}

function configuredAuditExporter(
  options: VercelDeploymentOptions,
  environment: VercelDeploymentEnvironment,
): SharedOSCloudAuditExporter | undefined {
  if (environment.SHAREDOS_KEY === undefined || environment.SHAREDOS_KEY.length === 0) {
    return undefined;
  }
  if (options.cloud_audit_exporter !== undefined) {
    return options.cloud_audit_exporter;
  }
  if (environment.SHAREDOS_AUDIT_URL === undefined) {
    return undefined;
  }
  try {
    return createHttpsAuditExporter({
      endpoint: environment.SHAREDOS_AUDIT_URL,
      sharedos_key: environment.SHAREDOS_KEY,
      ...(options.fetch_impl === undefined ? {} : { fetch_impl: options.fetch_impl }),
    });
  } catch {
    return undefined;
  }
}

export function createVercelDeploymentAdapter(
  options: VercelDeploymentOptions = {},
): VercelDeploymentAdapter {
  const environment = options.environment ?? environmentFromProcess();
  const baseUrl = publicBaseUrl(environment);
  const allowedHostnames = trustedHostnames(environment);
  const allowedOrigins = trustedOrigins(environment);
  const pipelineFactory = options.pipeline_factory ?? (() => createCorePipeline());
  const exporter = configuredAuditExporter(options, environment);
  const timeoutMs = options.deadline_ms ?? SERVICE_DEADLINE_MS;

  const createInvocationHandlers = () => {
    const pipeline = pipelineFactory();
    return createServiceHandlers({
      pipeline: withOptionalCloudAudit(pipeline, {
        ...(environment.SHAREDOS_KEY === undefined
          ? {}
          : { sharedos_key: environment.SHAREDOS_KEY }),
        ...(exporter === undefined ? {} : { exporter }),
      }),
      deadline_ms: timeoutMs,
    });
  };

  const mcpHandler: McpHttpHandler = createMcpHandler(
    () => createDeliverCheckMcpServer(createInvocationHandlers()),
    {
      legacy: "stateless",
      onerror: () => undefined,
    },
  );

  return {
    async handle(route, request) {
      try {
        validateOriginAndUrl(request, allowedHostnames, allowedOrigins);

        if (route === "health" || route === "agent_card" || route === "listing") {
          requireMethod(request, "GET");
          const handlers = createInvocationHandlers();
          if (route === "health") return jsonResponse(handlers.health());
          if (route === "agent_card") return jsonResponse(handlers.agentCard(baseUrl));
          return jsonResponse(handlers.serviceListing());
        }

        requireMethod(request, "POST");
        requireJsonContentType(request);
        const body = await readBoundedJson(request);
        const signal = deadlineSignal(request, timeoutMs);

        if (route === "mcp") {
          const headers = new Headers(request.headers);
          headers.delete("content-length");
          headers.delete("authorization");
          headers.delete("cookie");
          headers.delete("x-caller-identity");
          headers.delete("x-sharedos-grants");
          const forwarded = new Request(request.url, {
            method: "POST",
            headers,
            body: body.text,
            signal,
          });
          return secureResponse(await mcpHandler.fetch(forwarded));
        }

        const handlers = createInvocationHandlers();
        const result = route === "diagnose"
          ? await handlers.diagnose(body.parsed, signal)
          : await handlers.repair(body.parsed, signal);
        return jsonResponse(result);
      } catch (error) {
        const safe = toServiceError(error);
        return jsonResponse(
          publicErrorBody(safe),
          safe.status,
          safe.status === 405
            ? (route === "health" || route === "agent_card" || route === "listing" ? "GET" : "POST")
            : undefined,
        );
      }
    },
    close: () => mcpHandler.close(),
  };
}

export function createVercelRouteHandler(
  route: VercelRoute,
  options: VercelDeploymentOptions = {},
): (request: Request) => Promise<Response> {
  const adapter = createVercelDeploymentAdapter(options);
  return (request) => adapter.handle(route, request);
}
