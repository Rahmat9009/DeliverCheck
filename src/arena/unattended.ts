import { ArenaOperationalError, classifyArenaFailure, retryTransient } from "./resilience.js";
import type { ArenaOperator } from "./operator.js";
import type { ArenaTiming } from "./types.js";

export interface ArenaClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export const systemArenaClock: ArenaClock = {
  now: Date.now,
  sleep(milliseconds, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      const abort = () => { clearTimeout(timer); finish(); };
      signal.addEventListener("abort", abort, { once: true });
    });
  },
};

export interface UnattendedArenaOptions {
  operator: ArenaOperator;
  timing: ArenaTiming;
  signal: AbortSignal;
  clock?: ArenaClock;
  poll_interval_ms?: number;
  monitoring_timeout_seconds?: number;
  retry_attempts?: number;
}

export async function runUnattendedArena(options: UnattendedArenaOptions): Promise<"completed" | "shutdown"> {
  const clock = options.clock ?? systemArenaClock;
  const poll = options.poll_interval_ms ?? 5_000;
  const retryAttempts = options.retry_attempts ?? 3;
  const times = {
    start: Date.parse(options.timing.arena_starts_at),
    round1End: Date.parse(options.timing.round_1_ends_at),
    round2Start: Date.parse(options.timing.round_2_starts_at),
    round2End: Date.parse(options.timing.round_2_ends_at),
  };
  const retry = <T>(operation: () => Promise<T>) => retryTransient(() => operation(), { attempts: retryAttempts, sleep: (ms) => clock.sleep(ms, options.signal) });
  await retry(() => options.operator.preflight());

  const monitor = async () => retry(() => options.operator.monitorOnce(options.monitoring_timeout_seconds ?? 0));
  while (!options.signal.aborted) {
    const now = clock.now();
    try {
      if (options.operator.phase === "waiting" && now < times.start) {
        await clock.sleep(Math.max(1, Math.min(poll, times.start - now)), options.signal);
        continue;
      }
      if (options.operator.phase === "waiting" && !options.operator.state.presentationPublished) await retry(() => options.operator.publishPresentation());
      if (["waiting", "critique", "market"].includes(options.operator.phase)) await monitor();
      if (options.operator.phase === "waiting" && now >= times.start) await retry(() => options.operator.runRoundOne());
      else if (options.operator.phase === "critique") {
        if (now >= times.round1End) throw new ArenaOperationalError("integrity", "round1_deadline_missed", "Round 1 could not complete before its deadline.");
        await retry(() => options.operator.runRoundOne());
      }
      if (options.operator.phase === "market" && now >= times.round2Start) {
        if (now >= times.round2End) throw new ArenaOperationalError("integrity", "round2_deadline_missed", "Round 2 could not complete before its deadline.");
        await retry(() => options.operator.runRoundTwo());
      }
      if (options.operator.phase === "completed") return "completed";
    } catch (error) {
      const kind = classifyArenaFailure(error);
      await options.operator.recordOperationalFailure(kind, error instanceof ArenaOperationalError ? error.code : "unclassified_failure");
      if (kind !== "transient") { await options.operator.halt(`unattended_${kind}_failure`); throw error; }
    }
    const nextBoundary = options.operator.phase === "waiting" ? times.start : options.operator.phase === "market" ? times.round2Start : now + poll;
    await clock.sleep(Math.max(1, Math.min(poll, nextBoundary - now)), options.signal);
  }
  await options.operator.recordOperationalFailure("transient", "clean_shutdown");
  return "shutdown";
}
