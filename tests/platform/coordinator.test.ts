import { describe, expect, it } from "vitest";

import {
  CoordinatorNotReadyError,
  requireCoordinatorPorts,
} from "../../src/coordinator/ports.js";
import { toFrozenRequest } from "../../src/integrations/public-services.js";
import type { DeliverCheckRequest } from "../../src/types.js";
import validRequest from "../fixtures/request.valid.json" with { type: "json" };

describe("coordinator boundary", () => {
  it("fails closed while repair and verifier implementations are absent", () => {
    expect(() => requireCoordinatorPorts({})).toThrow(CoordinatorNotReadyError);

    try {
      requireCoordinatorPorts({});
    } catch (error: unknown) {
      expect(error).toMatchObject({
        code: "coordinator_not_ready",
        missing_ports: ["repair", "verifier"],
      });
    }
  });

  it("maps a public tool call into the unchanged internal request", () => {
    const mapped = toFrozenRequest({
      service: "bridge",
      request: validRequest as DeliverCheckRequest,
    });

    expect(mapped).toEqual(validRequest);
    expect(mapped).not.toHaveProperty("service");
    expect(mapped).not.toBe(validRequest);
    expect(mapped.target_schema).not.toBe(validRequest.target_schema);
  });
});
