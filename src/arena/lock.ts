import { open, readFile, unlink } from "node:fs/promises";

export class ArenaLockError extends Error {
  constructor(message: string) { super(message); this.name = "ArenaLockError"; }
}

async function processExists(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export class ArenaProcessLock {
  private constructor(readonly path: string) {}

  static async acquire(path: string): Promise<ArenaProcessLock> {
    try {
      const existing = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
      if (Number.isSafeInteger(existing.pid) && existing.pid! > 0 && await processExists(existing.pid!)) throw new ArenaLockError("Another Arena operator process owns this state file.");
      await unlink(path);
    } catch (error) {
      if (error instanceof ArenaLockError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      if (error instanceof SyntaxError) throw new ArenaLockError("The Arena operator lock file is malformed; manual inspection is required.");
    }
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
      await handle.close();
      return new ArenaProcessLock(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ArenaLockError("Another Arena operator process owns this state file.");
      throw error;
    }
  }

  async release(): Promise<void> { await unlink(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}
