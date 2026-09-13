import type { ArenaConfig, LiveArenaConfig } from "./types.js";

export const DEFAULT_ARENA_TIMEOUTS = {
  sharednet_read_ms: 30_000,
  ledger_ms: 30_000,
  marketplace_ms: 30_000,
  product_invocation_ms: 60_000,
  delivercheck_ms: 240_000,
} as const;

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
  if (candidate.cli_version !== "0.1.8") invalid.push("cli_version=0.1.8");
  if (candidate.server_protocol_version !== "1.0.0") invalid.push("server_protocol_version=1.0.0");
  if (typeof candidate.arena_room_id !== "string" || !ROOM_ID.test(candidate.arena_room_id)) invalid.push("arena_room_id");
  if (typeof candidate.arena_instance_id !== "string" || !INSTANCE_ID.test(candidate.arena_instance_id)) invalid.push("arena_instance_id");
  if (typeof candidate.account_principal_id !== "string" || !PRINCIPAL_ID.test(candidate.account_principal_id)) invalid.push("account_principal_id");
  if (
    candidate.submission_identity?.organizer_confirmed !== true ||
    !validIdentity(candidate.submission_identity?.kind ?? "", candidate.submission_identity?.id ?? "")
  ) {
    invalid.push("organizer_confirmed_submission_identity");
  }
  if (candidate.marketplace?.organizer_confirmed !== true || !candidate.marketplace?.adapter?.trim() || !candidate.marketplace?.protocol_version?.trim()) {
    invalid.push("organizer_confirmed_marketplace");
  }
  if (
    candidate.purchase_convention?.organizer_confirmed !== true ||
    !candidate.purchase_convention?.adapter?.trim() ||
    !candidate.purchase_convention?.memo_prefix?.trim() ||
    candidate.purchase_convention?.canonical_recipient !== "principal" ||
    candidate.purchase_convention?.exact_price !== true
  ) invalid.push("organizer_confirmed_purchase_convention");
  if (
    candidate.canonical_identity?.organizer_confirmed !== true ||
    candidate.canonical_identity?.seller_key !== "principal" ||
    candidate.canonical_identity?.mappings_verified !== true
  ) invalid.push("organizer_confirmed_canonical_identity");
  if (
    candidate.seller_payment_recipient?.organizer_confirmed !== true ||
    !validIdentity(candidate.seller_payment_recipient?.kind ?? "", candidate.seller_payment_recipient?.id ?? "")
  ) {
    invalid.push("organizer_confirmed_seller_payment_recipient");
  }
  if (candidate.seller_payment_principal_id !== candidate.account_principal_id) invalid.push("seller_payment_principal_mapping");
  if (!Array.isArray(candidate.self_identities) || candidate.self_identities.length === 0 || candidate.self_identities.some((identity) => identity.organizer_confirmed !== true || !validIdentity(identity.kind, identity.id))) {
    invalid.push("organizer_confirmed_self_identities");
  } else {
    for (const id of [candidate.account_principal_id, candidate.arena_instance_id, candidate.submission_identity?.id, candidate.seller_payment_recipient?.id]) {
      if (typeof id === "string" && !candidate.self_identities.some((identity) => identity.id === id)) invalid.push("complete_self_identity_set");
    }
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
  const timeouts = candidate.timeouts;
  for (const key of Object.keys(DEFAULT_ARENA_TIMEOUTS) as (keyof typeof DEFAULT_ARENA_TIMEOUTS)[]) {
    const value = timeouts?.[key];
    if (!Number.isSafeInteger(value) || (value ?? 0) < 100 || (value ?? 0) > 240_000) invalid.push(`timeouts.${key}`);
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
