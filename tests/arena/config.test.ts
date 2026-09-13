import { describe, expect, it } from "vitest";

import { ArenaPreflightError, defaultArenaConfig, validateLiveConfig } from "../../src/arena/config.js";
import type { ArenaConfig } from "../../src/arena/types.js";
import { validLiveConfig } from "./fixtures.js";

describe("Arena live preflight", () => {
  it("defaults to simulation", () => {
    expect(defaultArenaConfig()).toEqual({ mode: "simulate" });
  });

  it("refuses attempted live execution without every explicit value", () => {
    expect(() => validateLiveConfig({ mode: "live" } as ArenaConfig)).toThrow(ArenaPreflightError);
  });

  it("does not treat identity kinds as interchangeable", () => {
    const config = validLiveConfig();
    config.submission_identity = { kind: "agent", id: config.account_principal_id, organizer_confirmed: true };
    expect(() => validateLiveConfig(config)).toThrow(/submission_identity/);
  });

  it("requires ordered absolute round timing", () => {
    const config = validLiveConfig();
    config.round_timing.round_2_ends_at = "2026-09-14T09:30:00+03:00";
    expect(() => validateLiveConfig(config)).toThrow(/round_timing/);
  });

  it("accepts a complete explicit organizer-confirmed profile", () => {
    expect(validateLiveConfig(validLiveConfig()).mode).toBe("live");
  });

  it("requires validated protocol, marketplace, purchase, ranking, and canonical identity conventions", () => {
    const config = validLiveConfig();
    config.cli_version = "0.1.7" as "0.1.8";
    config.marketplace.organizer_confirmed = false as true;
    config.purchase_convention.exact_price = false as true;
    config.canonical_identity.mappings_verified = false as true;
    expect(() => validateLiveConfig(config)).toThrow(/cli_version|marketplace|purchase|canonical/);
  });
});
