import { access } from "node:fs/promises";
import { spawn } from "node:child_process";

export async function gitMetadataArguments(directory: string): Promise<string[]> {
  try { await access(`${directory}/.git-local`); return ["--git-dir=.git-local", "--work-tree=."]; }
  catch { return []; }
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const metadata = await gitMetadataArguments(directory);
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...metadata, ...args], { cwd: directory, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8").trim()) : reject(new Error("Repository preflight failed.")));
  });
}

export async function assertArenaRepository(directory: string, releaseCommit: string): Promise<void> {
  await git(directory, ["merge-base", "--is-ancestor", releaseCommit, "HEAD"]);
  if (await git(directory, ["status", "--short"])) throw new Error("Live Arena operation requires a clean repository.");
}
