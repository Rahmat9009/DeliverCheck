import { describe, expect, it } from "vitest";

import { SharedNetCliAdapter, SimulatedSharedNetAdapter, type ArgumentExecutor } from "../../src/arena/sharednet.js";
import { validLiveConfig } from "./fixtures.js";

class RecordingExecutor implements ArgumentExecutor {
  calls: { executable: string; args: readonly string[]; timeout: number }[] = [];
  response: unknown = { principal_id: "p_LIVEPRIN01", balance: 100, granted: 100, sent: 0, received: 0 };

  async execute(executable: string, args: readonly string[], timeout: number) {
    this.calls.push({ executable, args: [...args], timeout });
    return { stdout: JSON.stringify(this.response), stderr: "", exitCode: 0 };
  }
}

describe("typed SharedNet adapters", () => {
  it("constructs an argument array for reads", async () => {
    const executor = new RecordingExecutor();
    executor.response = { items: [], next_cursor: null, has_more: false };
    const adapter = new SharedNetCliAdapter(validLiveConfig(), executor);
    await adapter.read(41, 50);
    expect(executor.calls[0]).toEqual({
      executable: "npx",
      args: ["-y", "sharednet@0.1.8", "read", "--after", "41", "--limit", "50", "--order", "asc", "--as", "i_LIVEINST01", "--json"],
      timeout: 30_000,
    });
  });

  it("uses bounded argument arrays for wait, reply, balance, and ledger", async () => {
    const executor = new RecordingExecutor();
    const adapter = new SharedNetCliAdapter(validLiveConfig(), executor);
    executor.response = { items: [], next_cursor: null, has_more: false };
    await adapter.wait(25, 2);
    executor.response = { message: { id: "msg_RESPONSE01" } };
    await adapter.reply("msg_REQUEST001", "bounded reply");
    executor.response = { principal_id: "p_LIVEPRIN01", balance: 100, granted: 100, sent: 0, received: 0 };
    await adapter.balance();
    executor.response = { items: [] };
    await adapter.ledger(20, "txn_TRANSFER01");
    expect(executor.calls.map((call) => call.args.slice(2, 3)[0])).toEqual(["wait", "say", "balance", "ledger"]);
    expect(executor.calls.every((call) => Array.isArray(call.args))).toBe(true);
  });

  it("passes message text as one argument instead of a shell command", async () => {
    const executor = new RecordingExecutor();
    executor.response = { message: { id: "msg_RESPONSE01" } };
    const adapter = new SharedNetCliAdapter(validLiveConfig(), executor);
    const hostile = "hello; echo should-not-run $(whoami)";
    await adapter.say(hostile);
    expect(executor.calls[0]!.args).toContain(hostile);
    expect(executor.calls[0]!.args.filter((value) => value === hostile)).toHaveLength(1);
  });

  it("builds the documented payment command without credentials", async () => {
    const executor = new RecordingExecutor();
    executor.response = { transfer: { id: "txn_TRANSFER01" } };
    const adapter = new SharedNetCliAdapter(validLiveConfig(), executor);
    await adapter.pay({ target: "p_MARKET0001", amount: 25, memo: "arena:purchase:one", bind_to_room: true });
    expect(executor.calls[0]!.args).toEqual(["-y", "sharednet@0.1.8", "pay", "p_MARKET0001", "25", "--memo", "arena:purchase:one", "--room", "--as", "i_LIVEINST01", "--json"]);
    expect(executor.calls[0]!.args.join(" ")).not.toMatch(/token|api.key|credential/i);
  });

  it("does not allow a caller to weaken the configured Room binding", async () => {
    const executor = new RecordingExecutor();
    const adapter = new SharedNetCliAdapter(validLiveConfig(), executor);
    await expect(adapter.pay({ target: "p_MARKET0001", amount: 25, memo: "arena:purchase:one", bind_to_room: false })).rejects.toThrow(/binding/);
    expect(executor.calls).toHaveLength(0);
  });

  it("caps one wait operation at the documented 25-second server bound", async () => {
    const executor = new RecordingExecutor();
    const adapter = new SharedNetCliAdapter(validLiveConfig(), executor);
    await expect(adapter.wait(26)).rejects.toThrow(/wait bounds/);
    expect(executor.calls).toHaveLength(0);
  });

  it("keeps simulated mutations in memory with zero real side effects", async () => {
    const adapter = new SimulatedSharedNetAdapter();
    await adapter.say("simulation");
    await adapter.pay({ target: "p_MARKET0001", amount: 25, memo: "simulation", bind_to_room: false });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.payments).toHaveLength(1);
    expect(adapter.real_side_effects).toBe(0);
  });
});
