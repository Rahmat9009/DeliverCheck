export type ArenaFailureKind = "transient" | "integrity" | "configuration";

export class ArenaOperationalError extends Error {
  constructor(
    readonly kind: ArenaFailureKind,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArenaOperationalError";
  }
}

export function classifyArenaFailure(error: unknown): ArenaFailureKind {
  if (error instanceof ArenaOperationalError) return error.kind;
  if (error instanceof TypeError && /fetch|network|abort/i.test(error.message)) return "transient";
  return "transient";
}

export async function withTimeout<T>(operation: Promise<T>, milliseconds: number, code: string): Promise<T> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 300_000) {
    throw new ArenaOperationalError("configuration", "invalid_timeout", "An Arena operation timeout is invalid.");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ArenaOperationalError("transient", code, "The Arena operation exceeded its configured deadline.")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function retryTransient<T>(
  operation: (attempt: number) => Promise<T>,
  options: { attempts?: number; backoff_ms?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const backoff = options.backoff_ms ?? 25;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      last = error;
      if (classifyArenaFailure(error) !== "transient" || attempt === attempts) throw error;
      await sleep(backoff * 2 ** (attempt - 1));
    }
  }
  throw last;
}
