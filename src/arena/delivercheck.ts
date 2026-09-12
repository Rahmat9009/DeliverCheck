import type { DeliverCheckRequest } from "../types.js";
import type { DeliverCheckClient } from "./types.js";

const MAX_RESPONSE_BYTES = 256 * 1024;

export class DeliverCheckClientError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeliverCheckClientError";
  }
}

export class ProductionDeliverCheckRestClient implements DeliverCheckClient {
  readonly #origin: string;

  constructor(
    origin = "https://delivercheck.vercel.app",
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 245_000,
  ) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new DeliverCheckClientError("invalid_origin", "The DeliverCheck origin must be an HTTPS origin without credentials.");
    }
    this.#origin = origin;
  }

  async invoke(service: "diagnose" | "repair", request: DeliverCheckRequest): Promise<unknown> {
    const response = await this.fetcher(`${this.#origin}/api/v1/${service}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new DeliverCheckClientError("response_too_large", "DeliverCheck returned an oversized response.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new DeliverCheckClientError("response_too_large", "DeliverCheck returned an oversized response.");
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error) {
      throw new DeliverCheckClientError("invalid_response", "DeliverCheck returned invalid JSON.", { cause: error });
    }
    if (!response.ok) throw new DeliverCheckClientError("service_rejected", "DeliverCheck rejected the request.");
    return body;
  }
}

export class SimulatedDeliverCheckClient implements DeliverCheckClient {
  readonly calls: { service: "diagnose" | "repair"; request_id: string }[] = [];

  constructor(private readonly responder: (service: "diagnose" | "repair", request: DeliverCheckRequest) => unknown) {}

  async invoke(service: "diagnose" | "repair", request: DeliverCheckRequest): Promise<unknown> {
    this.calls.push({ service, request_id: request.request_id });
    return structuredClone(this.responder(service, structuredClone(request)));
  }
}
