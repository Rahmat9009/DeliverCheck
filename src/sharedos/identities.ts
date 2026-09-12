import type { Address } from "@aicoo/sharedos";

export const DELIVERCHECK_PURPOSE = "service:delivercheck.transform";

export const DELIVERCHECK_IDENTITIES = {
  intake: { kind: "agent", agentId: "intake.delivercheck" },
  repair: { kind: "agent", agentId: "repair.delivercheck" },
  verifier: { kind: "agent", agentId: "verifier.delivercheck" },
  service: { kind: "service", serviceId: "delivercheck.transform" },
} as const satisfies Record<string, Address>;

export const DELIVERCHECK_IDENTITY_STRINGS = {
  intake: "agent:intake.delivercheck",
  repair: "agent:repair.delivercheck",
  verifier: "agent:verifier.delivercheck",
  service: "service:delivercheck.transform",
} as const;

export function formatSharedOSAddress(address: Address): string {
  switch (address.kind) {
    case "agent":
      return `agent:${address.agentId}`;
    case "group":
      return `group:${address.conversationId}`;
    case "human":
      return `human:${address.userId}`;
    case "service":
      return `service:${address.serviceId}`;
  }
}
