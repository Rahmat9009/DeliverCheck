import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { computeCanonicalHash } from "../verify/canonical.js";
import type { ActionLedger, ArenaEvent, ArenaEventInput } from "./types.js";

const GENESIS_HASH = "sha256:" + "0".repeat(64);

export class ArenaLedgerError extends Error {
  constructor(readonly code: "ledger_corrupt" | "ledger_write_failed", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArenaLedgerError";
  }
}

function eventWithoutHash(event: Omit<ArenaEvent, "event_hash">): Omit<ArenaEvent, "event_hash"> {
  return event;
}

function expectedHash(event: Omit<ArenaEvent, "event_hash">): string {
  return computeCanonicalHash(eventWithoutHash(event));
}

export function verifyLedgerEvents(events: readonly ArenaEvent[]): void {
  let previous = GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const expectedSequence = index + 1;
    const { event_hash: actualHash, ...body } = event;
    if (
      event.sequence !== expectedSequence ||
      event.event_id !== `arena-event-${expectedSequence}` ||
      event.previous_hash !== previous ||
      actualHash !== expectedHash(body)
    ) {
      throw new ArenaLedgerError("ledger_corrupt", "The Arena action ledger failed integrity validation.");
    }
    previous = actualHash;
  }
}

abstract class BaseLedger implements ActionLedger {
  protected readonly events: ArenaEvent[];
  readonly #now: () => string;
  #pending: Promise<unknown> = Promise.resolve();

  protected constructor(events: ArenaEvent[], now: () => string) {
    verifyLedgerEvents(events);
    this.events = events;
    this.#now = now;
  }

  async readAll(): Promise<readonly ArenaEvent[]> {
    await this.#pending;
    return structuredClone(this.events);
  }

  append(input: ArenaEventInput): Promise<ArenaEvent> {
    const operation = this.#pending.then(async () => {
      const sequence = this.events.length + 1;
      const previous_hash = this.events.at(-1)?.event_hash ?? GENESIS_HASH;
      const body: Omit<ArenaEvent, "event_hash"> = {
        sequence,
        event_id: `arena-event-${sequence}`,
        recorded_at: this.#now(),
        previous_hash,
        kind: input.kind,
        phase: input.phase,
        ...(input.details === undefined ? {} : { details: structuredClone(input.details) }),
      };
      const event: ArenaEvent = { ...body, event_hash: expectedHash(body) };
      await this.persist(event);
      this.events.push(event);
      return structuredClone(event);
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  protected abstract persist(event: ArenaEvent): Promise<void>;
}

export class MemoryActionLedger extends BaseLedger {
  constructor(events: ArenaEvent[] = [], now: () => string = () => new Date().toISOString()) {
    super(structuredClone(events), now);
  }

  protected async persist(): Promise<void> {}
}

export class FileActionLedger extends BaseLedger {
  private constructor(
    private readonly path: string,
    events: ArenaEvent[],
    now: () => string,
  ) {
    super(events, now);
  }

  static async open(path: string, now: () => string = () => new Date().toISOString()): Promise<FileActionLedger> {
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (text !== "" && !text.endsWith("\n")) {
      throw new ArenaLedgerError("ledger_corrupt", "The Arena action ledger ends with an incomplete record.");
    }
    const events: ArenaEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as ArenaEvent);
      } catch (error) {
        throw new ArenaLedgerError("ledger_corrupt", "The Arena action ledger contains malformed JSON.", { cause: error });
      }
    }
    return new FileActionLedger(path, events, now);
  }

  protected async persist(event: ArenaEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      throw new ArenaLedgerError("ledger_write_failed", "The Arena action ledger could not be persisted.", { cause: error });
    } finally {
      await handle.close();
    }
  }
}
