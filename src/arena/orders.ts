import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { computeCanonicalHash } from "../verify/canonical.js";
import type { PendingOrderStore, StoredSellerOrder } from "./types.js";

function clone(value: StoredSellerOrder): StoredSellerOrder {
  return structuredClone(value);
}

function safeName(orderId: string): string {
  return `${computeCanonicalHash(orderId).replace("sha256:", "")}.json`;
}

export class MemoryPendingOrderStore implements PendingOrderStore {
  readonly #orders = new Map<string, StoredSellerOrder>();
  async put(value: StoredSellerOrder): Promise<void> { this.#orders.set(value.order.order_id, clone(value)); }
  async get(orderId: string): Promise<StoredSellerOrder | null> {
    const value = this.#orders.get(orderId);
    return value === undefined ? null : clone(value);
  }
  async list(): Promise<StoredSellerOrder[]> { return [...this.#orders.values()].map(clone); }
  async delete(orderId: string): Promise<void> { this.#orders.delete(orderId); }
}

export class FilePendingOrderStore implements PendingOrderStore {
  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<FilePendingOrderStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new FilePendingOrderStore(directory);
  }

  private path(orderId: string): string { return join(this.directory, safeName(orderId)); }

  async put(value: StoredSellerOrder): Promise<void> {
    const path = this.path(value.order.order_id);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }

  async get(orderId: string): Promise<StoredSellerOrder | null> {
    try {
      const value = JSON.parse(await readFile(this.path(orderId), "utf8")) as StoredSellerOrder;
      return value.order?.order_id === orderId ? clone(value) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(): Promise<StoredSellerOrder[]> {
    const entries = await readdir(this.directory);
    const values: StoredSellerOrder[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      const parsed = JSON.parse(await readFile(join(this.directory, entry), "utf8")) as StoredSellerOrder;
      if (parsed.order?.order_id) values.push(clone(parsed));
    }
    return values;
  }

  async delete(orderId: string): Promise<void> {
    await unlink(this.path(orderId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
