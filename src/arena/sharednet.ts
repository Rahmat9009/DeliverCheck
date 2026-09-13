import { spawn } from "node:child_process";

import type {
  ArenaMode,
  CreditBalance,
  CreditTransfer,
  LiveArenaConfig,
  MessagePage,
  SharedNetAdapter,
  SharedNetMessage,
} from "./types.js";
import { identityMatchesKind, validateLiveConfig } from "./config.js";

const CLI_PACKAGE = "sharednet@0.1.8";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 32_768;

export function sharedNetExecutable(platform = process.platform): "npx" | "npx.cmd" {
  return platform === "win32" ? "npx.cmd" : "npx";
}

export interface ArgumentExecutor {
  execute(executable: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export class SharedNetAdapterError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SharedNetAdapterError";
  }
}

export class NodeArgumentExecutor implements ArgumentExecutor {
  execute(executable: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let exceeded = false;
      let timedOut = false;
      let hardKill: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        hardKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      }, timeoutMs);
      const collect = (current: Uint8Array[], currentBytes: number, chunk: Buffer): number => {
        const nextBytes = currentBytes + chunk.byteLength;
        if (nextBytes > MAX_OUTPUT_BYTES) {
          exceeded = true;
          child.kill("SIGTERM");
          return currentBytes;
        }
        current.push(chunk);
        return nextBytes;
      };
      child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = collect(stdout, stdoutBytes, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes = collect(stderr, stderrBytes, chunk); });
      child.once("error", (error) => {
        clearTimeout(timer);
        if (hardKill !== undefined) clearTimeout(hardKill);
        reject(new SharedNetAdapterError("cli_unavailable", "The SharedNet CLI could not be started.", { cause: error }));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (hardKill !== undefined) clearTimeout(hardKill);
        if (timedOut) {
          reject(new SharedNetAdapterError("cli_timeout", "The SharedNet CLI exceeded its deadline."));
          return;
        }
        if (exceeded) {
          reject(new SharedNetAdapterError("cli_output_limit", "The SharedNet CLI exceeded its output limit."));
          return;
        }
        resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? 1 });
      });
    });
  }
}

function parseCliJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new SharedNetAdapterError("invalid_cli_response", "The SharedNet CLI returned invalid JSON.", { cause: error });
  }
}

function assertMessage(content: string): void {
  if (!content.trim() || Buffer.byteLength(content, "utf8") > MAX_MESSAGE_BYTES) {
    throw new SharedNetAdapterError("invalid_message", "The SharedNet message is empty or exceeds 32,768 bytes.");
  }
}

function assertTarget(target: string): void {
  const [prefix] = target.split("_", 1);
  const kind = prefix === "p" ? "principal" : prefix === "a" ? "agent" : prefix === "i" ? "instance" : null;
  if (kind === null || !identityMatchesKind(kind, target)) {
    throw new SharedNetAdapterError("invalid_payment_target", "The payment target is not a valid Principal, Agent, or Instance ID.");
  }
}

export class SharedNetCliAdapter implements SharedNetAdapter {
  readonly mode: ArenaMode = "live";

  constructor(
    config: LiveArenaConfig,
    private readonly executor: ArgumentExecutor = new NodeArgumentExecutor(),
    private readonly timeoutMs = 30_000,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.config = validateLiveConfig(config);
  }

  private readonly config: LiveArenaConfig;

  private async run<T>(args: readonly string[]): Promise<T> {
    const result = await this.executor.execute(sharedNetExecutable(), ["-y", CLI_PACKAGE, ...args, "--json"], this.timeoutMs);
    if (result.exitCode !== 0) {
      throw new SharedNetAdapterError("cli_failed", "The SharedNet CLI operation failed.");
    }
    return parseCliJson<T>(result.stdout);
  }

  async identity(): Promise<{ room_id: string | null; instance_id: string | null; principal_id: string | null }> {
    const response = await this.run<{ account?: { principal_id?: string | null } | null; seat?: { room_id?: string; member_id?: string | null } | null }>(["whoami"]);
    return {
      room_id: response.seat?.room_id ?? null,
      instance_id: response.seat?.member_id ?? null,
      principal_id: response.account?.principal_id ?? null,
    };
  }

  async read(after: number, limit = 100): Promise<MessagePage> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SharedNetAdapterError("invalid_cursor", "The SharedNet read cursor or limit is invalid.");
    }
    return this.run<MessagePage>(["read", "--after", String(after), "--limit", String(limit), "--order", "asc", "--as", this.config.arena_instance_id]);
  }

  async wait(timeoutSeconds: number, minimum = 1, _after?: number): Promise<MessagePage> {
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 25 || !Number.isSafeInteger(minimum) || minimum < 1 || minimum > 100) {
      throw new SharedNetAdapterError("invalid_wait", "The SharedNet wait bounds are invalid.");
    }
    return this.run<MessagePage>(["wait", "--timeout", String(timeoutSeconds), "--min", String(minimum), "--as", this.config.arena_instance_id]);
  }

  async say(content: string): Promise<{ message_id: string }> {
    assertMessage(content);
    const response = await this.run<{ message?: { id?: string } }>(["say", content, "--as", this.config.arena_instance_id]);
    if (!response.message?.id) throw new SharedNetAdapterError("invalid_cli_response", "SharedNet did not return a message ID.");
    return { message_id: response.message.id };
  }

  async reply(messageId: string, content: string): Promise<{ message_id: string }> {
    if (!/^msg_[0-9A-Za-z]{10}$/.test(messageId)) throw new SharedNetAdapterError("invalid_message_id", "The reply target is invalid.");
    assertMessage(content);
    const response = await this.run<{ message?: { id?: string } }>(["say", content, "--reply-to", messageId, "--as", this.config.arena_instance_id]);
    if (!response.message?.id) throw new SharedNetAdapterError("invalid_cli_response", "SharedNet did not return a message ID.");
    return { message_id: response.message.id };
  }

  async balance(): Promise<CreditBalance> {
    return this.run<CreditBalance>(["balance", "--as", this.config.arena_instance_id]);
  }

  async ledger(limit = 100, before?: string): Promise<CreditTransfer[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SharedNetAdapterError("invalid_limit", "The ledger limit is invalid.");
    if (before !== undefined && !/^txn_[0-9A-Za-z]{10}$/.test(before)) throw new SharedNetAdapterError("invalid_transfer_id", "The ledger cursor is invalid.");
    const response = await this.run<{ items: CreditTransfer[] }>(["ledger", "--last", String(limit), ...(before === undefined ? [] : ["--before", before]), "--as", this.config.arena_instance_id]);
    return response.items;
  }

  async pay(input: { target: string; amount: number; memo: string; bind_to_room: boolean }): Promise<{ transfer: CreditTransfer; receipt_message_id?: string }> {
    assertTarget(input.target);
    if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > 100) throw new SharedNetAdapterError("invalid_amount", "The payment amount is outside the Arena safety bounds.");
    if (!input.memo.trim() || Buffer.byteLength(input.memo, "utf8") > 256) throw new SharedNetAdapterError("invalid_memo", "The payment memo is empty or too large.");
    if (input.bind_to_room !== this.config.payment_room_binding) throw new SharedNetAdapterError("payment_binding_mismatch", "The payment Room binding does not match the organizer-confirmed profile.");
    const response = await this.run<{ transfer: CreditTransfer; receipt?: { message?: { id?: string }; id?: string } }>(["pay", input.target, String(input.amount), "--memo", input.memo, ...(input.bind_to_room ? ["--room"] : []), "--as", this.config.arena_instance_id]);
    const receiptId = response.receipt?.message?.id ?? response.receipt?.id;
    return { transfer: response.transfer, ...(receiptId === undefined ? {} : { receipt_message_id: receiptId }) };
  }

  async protocolStatus(): Promise<{ cli_version: string; server_protocol_version: string }> {
    const status = await this.run<{ instance?: { cli_version?: string }; cli_version?: string }>(["session", "status", "--session", this.config.arena_instance_id]);
    const cliVersion = status.instance?.cli_version ?? status.cli_version;
    const response = await this.fetcher("https://www.sharednet.ai/api/v1", { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new SharedNetAdapterError("protocol_discovery_failed", "SharedNet protocol discovery failed.");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 64 * 1024) throw new SharedNetAdapterError("protocol_discovery_limit", "SharedNet protocol discovery exceeded its size limit.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 64 * 1024) throw new SharedNetAdapterError("protocol_discovery_limit", "SharedNet protocol discovery exceeded its size limit.");
    let discovery: { protocol_version?: string };
    try { discovery = JSON.parse(new TextDecoder().decode(bytes)) as { protocol_version?: string }; }
    catch (error) { throw new SharedNetAdapterError("invalid_protocol_status", "SharedNet protocol discovery returned invalid JSON.", { cause: error }); }
    if (!cliVersion || !discovery.protocol_version) throw new SharedNetAdapterError("invalid_protocol_status", "SharedNet did not report complete protocol versions.");
    return { cli_version: cliVersion, server_protocol_version: discovery.protocol_version };
  }
}

export class SimulatedSharedNetAdapter implements SharedNetAdapter {
  readonly mode = "simulate" as const;
  readonly sent: { kind: "say" | "reply"; reply_to?: string; content: string; message_id: string }[] = [];
  readonly payments: CreditTransfer[] = [];
  readonly calls: string[] = [];
  readonly real_side_effects = 0;
  #messages: SharedNetMessage[];
  #transfers: CreditTransfer[];
  #balance: CreditBalance;
  #nextMessage = 1;
  #nextTransfer = 1;
  #waitCursor = 0;
  readonly #concurrentIncomePerPayment: number;

  constructor(input: { messages?: SharedNetMessage[]; transfers?: CreditTransfer[]; balance?: CreditBalance; concurrent_income_per_payment?: number } = {}) {
    this.#messages = structuredClone(input.messages ?? []);
    this.#transfers = structuredClone(input.transfers ?? []);
    this.#balance = structuredClone(input.balance ?? { principal_id: "p_SIMULATE01", balance: 100, granted: 100, sent: 0, received: 0 });
    this.#concurrentIncomePerPayment = input.concurrent_income_per_payment ?? 0;
  }

  addMessage(message: SharedNetMessage): void { this.#messages.push(structuredClone(message)); }
  addTransfer(transfer: CreditTransfer, affectBalance = false): void {
    this.#transfers.unshift(structuredClone(transfer));
    if (affectBalance && transfer.to_principal_id === this.#balance.principal_id) {
      this.#balance.balance += transfer.amount;
      this.#balance.received += transfer.amount;
    }
  }

  async identity(): Promise<{ room_id: string; instance_id: string; principal_id: string }> {
    this.calls.push("identity");
    return { room_id: "rom_SIMULATE1", instance_id: "i_SIMULATE01", principal_id: this.#balance.principal_id };
  }

  async read(after: number, limit = 100): Promise<MessagePage> {
    this.calls.push("read");
    const all = this.#messages.filter((m) => m.sequence > after).sort((a, b) => a.sequence - b.sequence);
    const items = all.slice(0, limit);
    return { items: structuredClone(items), next_cursor: items.length === 0 ? null : String(items.at(-1)!.sequence), has_more: all.length > items.length };
  }

  async wait(_timeoutSeconds: number, minimum = 1, after?: number): Promise<MessagePage> {
    this.calls.push("wait");
    const cursor = Math.max(this.#waitCursor, after ?? 0);
    const available = this.#messages.filter((message) => message.sequence > cursor).sort((left, right) => left.sequence - right.sequence);
    const items = available.slice(0, Math.max(minimum, 1));
    if (items.length > 0) this.#waitCursor = items.at(-1)!.sequence;
    return { items: structuredClone(items), next_cursor: items.length === 0 ? null : String(this.#waitCursor), has_more: available.length > items.length };
  }

  async say(content: string): Promise<{ message_id: string }> {
    this.calls.push("simulate:say");
    const message_id = `msg_SIM${String(this.#nextMessage++).padStart(7, "0")}`;
    this.sent.push({ kind: "say", content, message_id });
    this.#messages.push({ id: message_id, room_id: "rom_SIMULATE1", sequence: Math.max(0, ...this.#messages.map((item) => item.sequence)) + 1, sender_principal_id: this.#balance.principal_id, sender_agent_id: null, sender_instance_id: "i_SIMULATE01", content, created_at: "2026-09-13T10:00:00.000Z" });
    return { message_id };
  }

  async reply(messageId: string, content: string): Promise<{ message_id: string }> {
    this.calls.push("simulate:reply");
    const message_id = `msg_SIM${String(this.#nextMessage++).padStart(7, "0")}`;
    this.sent.push({ kind: "reply", reply_to: messageId, content, message_id });
    this.#messages.push({ id: message_id, room_id: "rom_SIMULATE1", sequence: Math.max(0, ...this.#messages.map((item) => item.sequence)) + 1, sender_principal_id: this.#balance.principal_id, sender_agent_id: null, sender_instance_id: "i_SIMULATE01", content, created_at: "2026-09-13T10:00:00.000Z" });
    return { message_id };
  }

  async balance(): Promise<CreditBalance> {
    this.calls.push("balance");
    return structuredClone(this.#balance);
  }

  async ledger(limit = 100, before?: string): Promise<CreditTransfer[]> {
    this.calls.push("ledger");
    const start = before === undefined ? 0 : Math.max(0, this.#transfers.findIndex((item) => item.id === before) + 1);
    return structuredClone(this.#transfers.slice(start, start + limit));
  }

  async pay(input: { target: string; amount: number; memo: string; bind_to_room: boolean }): Promise<{ transfer: CreditTransfer }> {
    this.calls.push("simulate:pay");
    if (this.#balance.balance < input.amount) throw new SharedNetAdapterError("insufficient_balance", "The simulated purse has insufficient credits.");
    this.#balance.balance -= input.amount;
    this.#balance.sent += input.amount;
    if (this.#concurrentIncomePerPayment > 0) {
      this.#balance.balance += this.#concurrentIncomePerPayment;
      this.#balance.received += this.#concurrentIncomePerPayment;
    }
    const transfer: CreditTransfer = {
      id: `txn_SIM${String(this.#nextTransfer++).padStart(7, "0")}`,
      from_principal_id: this.#balance.principal_id,
      to_principal_id: input.target.startsWith("p_") ? input.target : "p_TARGET0001",
      amount: input.amount,
      memo: input.memo,
      room_id: input.bind_to_room ? "rom_SIMULATE1" : null,
      by_instance_id: "i_SIMULATE01",
      addressed_to: input.target,
      code: null,
      created_at: "2026-09-13T10:00:00.000Z",
    };
    this.#transfers.unshift(transfer);
    this.payments.push(structuredClone(transfer));
    return { transfer: structuredClone(transfer) };
  }

  async protocolStatus(): Promise<{ cli_version: string; server_protocol_version: string }> {
    this.calls.push("protocolStatus");
    return { cli_version: "0.1.8", server_protocol_version: "1.0.0" };
  }
}
