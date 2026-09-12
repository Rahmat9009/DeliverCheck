import { createHash } from "node:crypto";

import { canonicalize } from "./canonical-json.js";
import type { JsonValue } from "../types.js";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Hashes the exact UTF-8 bytes of `text`, per the `original_hash` contract. */
export function hashText(text: string): string {
  return `sha256:${sha256Hex(Buffer.from(text, "utf8"))}`;
}

/** Hashes the RFC 8785 canonical JSON bytes of `value`, per the `schema_hash`/`candidate_hash` contract. */
export function hashJsonValue(value: JsonValue): string {
  return hashText(canonicalize(value));
}
