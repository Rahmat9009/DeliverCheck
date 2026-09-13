import type { LiveArenaConfig, SharedNetMessage } from "../../src/arena/types.js";
import type { DeliverCheckRequest } from "../../src/types.js";

export const ARENA_ROOM = "rom_SIMULATE1";
export const SELLER_PRINCIPAL = "p_SELLER0001";
export const SELLER_INSTANCE = "i_SELLER0001";
export const BUYER_PRINCIPAL = "p_BUYER00001";
export const BUYER_INSTANCE = "i_BUYER00001";

export function deliverCheckRequest(): DeliverCheckRequest {
  return {
    request_id: "arena-test-request",
    input_format: "json",
    source_text: '{"status":"done"}',
    target_schema: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["complete"] } } },
    explicit_rules: ['Normalize "status" value "done" to "complete".'],
  };
}

export function requestMessage(overrides: Partial<SharedNetMessage> = {}): SharedNetMessage {
  return {
    id: "msg_REQUEST001",
    room_id: ARENA_ROOM,
    sequence: 1,
    sender_principal_id: BUYER_PRINCIPAL,
    sender_agent_id: null,
    sender_instance_id: BUYER_INSTANCE,
    content: JSON.stringify({ type: "delivercheck.request", version: 1, service: "repair", request: deliverCheckRequest() }),
    created_at: "2026-09-13T09:00:00.000Z",
    ...overrides,
  };
}

export function validLiveConfig(): LiveArenaConfig {
  return {
    mode: "live",
    explicit_live_enablement: true,
    protocol_profile_version: "organizer-profile-v1",
    cli_version: "0.1.8",
    server_protocol_version: "1.0.0",
    arena_room_id: "rom_LIVEROOM01",
    arena_instance_id: "i_LIVEINST01",
    account_principal_id: "p_LIVEPRIN01",
    submission_identity: { kind: "instance", id: "i_LIVEINST01", organizer_confirmed: true },
    seller_payment_recipient: { kind: "instance", id: "i_SELLER0001", organizer_confirmed: true },
    seller_payment_principal_id: "p_LIVEPRIN01",
    self_identities: [
      { kind: "principal", id: "p_LIVEPRIN01", organizer_confirmed: true },
      { kind: "instance", id: "i_LIVEINST01", organizer_confirmed: true },
      { kind: "instance", id: "i_SELLER0001", organizer_confirmed: true },
    ],
    ranking_method: { adapter: "organizer-adapter-v1", organizer_confirmed: true },
    marketplace: { adapter: "marketplace-adapter-v1", protocol_version: "1", organizer_confirmed: true },
    purchase_convention: { adapter: "sharednet-ledger-v1", memo_prefix: "arena:purchase:", canonical_recipient: "principal", exact_price: true, organizer_confirmed: true },
    canonical_identity: { seller_key: "principal", mappings_verified: true, organizer_confirmed: true },
    round_timing: {
      arena_starts_at: "2026-09-14T09:00:00+03:00",
      round_1_ends_at: "2026-09-14T10:00:00+03:00",
      round_2_starts_at: "2026-09-14T10:00:00+03:00",
      round_2_ends_at: "2026-09-14T12:00:00+03:00",
      timezone: "Asia/Qatar",
    },
    delivercheck_origin: "https://delivercheck.vercel.app",
    payment_room_binding: true,
    timeouts: { sharednet_read_ms: 30_000, ledger_ms: 30_000, marketplace_ms: 30_000, product_invocation_ms: 60_000, delivercheck_ms: 240_000 },
  };
}
