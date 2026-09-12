import type { ArenaConfig, LiveArenaConfig } from "./types.js";

const ROOM_ID = /^rom_[0-9A-Za-z]{10}$/;
const INSTANCE_ID = /^i_[0-9A-Za-z]{10}$/;
const PRINCIPAL_ID = /^p_[0-9A-Za-z]{10}$/;
const AGENT_ID = /^a_[0-9A-Za-z]{10}$/;

export class ArenaPreflightError extends Error {
  readonly code = "arena_preflight_failed";

  constructor(readonly missing_or_invalid: readonly string[]) {
    super(`Live Arena configuration is incomplete: ${missing_or_invalid.join(", ")}`);
    this.name = "ArenaPreflightError";
  }
}

function validIdentity(kind: string, id: string): boolean {
  switch (kind) {
    case "principal":
      return PRINCIPAL_ID.test(id);
    case "agent":
      return AGENT_ID.test(id);
    case "instance":
      return INSTANCE_ID.test(id);
    case "node":
      return id.trim().length > 0;
    default:
      return false;
  }
}

function validIsoInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

export function defaultArenaConfig(): ArenaConfig {
  return { mode: "simulate" };
}

export function validateLiveConfig(config: ArenaConfig): LiveArenaConfig {
  if (config.mode !== "live") {
    throw new ArenaPreflightError(["mode=live", "explicit_live_enablement"]);
  }

  const candidate = config as Partial<LiveArenaConfig>;
  const invalid: string[] = [];
  if (candidate.explicit_live_enablement !== true) invalid.push("explicit_live_enablement");
  if (typeof candidate.protocol_profile_version !== "string" || !candidate.protocol_profile_version.trim()) invalid.push("protocol_profile_version");
  if (typeof candidate.arena_room_id !== "string" || !ROOM_ID.test(candidate.arena_room_id)) invalid.push("arena_room_id");
  if (typeof candidate.arena_instance_id !== "string" || !INSTANCE_ID.test(candidate.arena_instance_id)) invalid.push("arena_instance_id");
  if (typeof candidate.account_principal_id !== "string" || !PRINCIPAL_ID.test(candidate.account_principal_id)) invalid.push("account_principal_id");
  if (
    candidate.submission_identity?.organizer_confirmed !== true ||
    !validIdentity(candidate.submission_identity?.kind ?? "", candidate.submission_identity?.id ?? "")
  ) {
    invalid.push("organizer_confirmed_submission_identity");
  }
  if (
    candidate.seller_payment_recipient?.organizer_confirmed !== true ||
    !validIdentity(candidate.seller_payment_recipient?.kind ?? "", candidate.seller_payment_recipient?.id ?? "")
  ) {
    invalid.push("organizer_confirmed_seller_payment_recipient");
  }
  if (
    candidate.ranking_method?.organizer_confirmed !== true ||
    !candidate.ranking_method?.adapter?.trim()
  ) {
    invalid.push("organizer_confirmed_ranking_method");
  }
  if (candidate.delivercheck_origin !== "https://delivercheck.vercel.app") {
    invalid.push("delivercheck_origin");
  }

  const timing = candidate.round_timing;
  const values = [
    timing?.arena_starts_at ?? "",
    timing?.round_1_ends_at ?? "",
    timing?.round_2_starts_at ?? "",
    timing?.round_2_ends_at ?? "",
  ];
  if (!values.every(validIsoInstant) || !timing?.timezone?.trim()) {
    invalid.push("organizer_confirmed_round_timing");
  } else {
    const times = values.map((value) => Date.parse(value));
    if (!(times[0]! < times[1]! && times[1]! <= times[2]! && times[2]! < times[3]!)) {
      invalid.push("ordered_round_timing");
    }
  }

  if (invalid.length > 0) throw new ArenaPreflightError(invalid);
  return structuredClone(config);
}

export function identityMatchesKind(kind: "principal" | "agent" | "instance", id: string): boolean {
  return validIdentity(kind, id);
}
