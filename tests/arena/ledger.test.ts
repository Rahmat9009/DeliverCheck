import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ArenaLedgerError, FileActionLedger, MemoryActionLedger, verifyLedgerEvents } from "../../src/arena/ledger.js";
import { ArenaStateController } from "../../src/arena/state.js";

describe("append-only Arena ledger", () => {
  it("persists cursor and duplicate-message state across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arena-ledger-"));
    const path = join(dir, "activity.jsonl");
    const first = await FileActionLedger.open(path, () => "2026-09-13T09:00:00.000Z");
    const state = await ArenaStateController.open(first);
    await state.ignoreMessage("msg_DUPLICATE1", 9, "fixture");

    const reopened = await ArenaStateController.open(await FileActionLedger.open(path));
    expect(reopened.state.cursor).toBe(9);
    expect(reopened.assertNewMessage("msg_DUPLICATE1", 9)).toBe(false);
    expect(() => reopened.assertNewMessage("msg_DIFFERENT1", 9)).toThrow(/different message ID/);
  });

  it("detects tampering in the hash chain", async () => {
    const ledger = new MemoryActionLedger([], () => "2026-09-13T09:00:00.000Z");
    await ledger.append({ kind: "preflight_passed", phase: "preflight" });
    const events = structuredClone(await ledger.readAll());
    events[0]!.kind = "tampered";
    expect(() => verifyLedgerEvents(events)).toThrow(ArenaLedgerError);
  });

  it("rejects an incomplete crash-tail record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arena-ledger-tail-"));
    const path = join(dir, "activity.jsonl");
    await writeFile(path, '{"partial":true}', "utf8");
    await expect(FileActionLedger.open(path)).rejects.toThrow(/incomplete record/);
    expect(await readFile(path, "utf8")).toBe('{"partial":true}');
  });
});
