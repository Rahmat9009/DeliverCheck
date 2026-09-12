import type { ChangeEvidence, ChangeOperation } from "../types.js";

/**
 * Escapes a token for RFC 6901 JSON pointer.
 */
export function escapePointerToken(token: string | number): string {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Unescapes a token from RFC 6901 JSON pointer.
 */
export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Builds an RFC 6901 JSON pointer from tokens.
 */
export function buildPointer(tokens: (string | number)[]): string {
  if (tokens.length === 0) {
    return "";
  }
  return "/" + tokens.map(escapePointerToken).join("/");
}

/**
 * Parses an RFC 6901 JSON pointer into tokens.
 */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON pointer (must start with '/'): '${pointer}'`);
  }
  return pointer.slice(1).split("/").map(unescapePointerToken);
}

/**
 * Retrieves a value from an object/array at the specified RFC 6901 JSON pointer.
 */
export function getValueAtPointer(
  root: unknown,
  pointer: string,
): { found: boolean; value?: unknown } {
  if (pointer === "") {
    return { found: true, value: root };
  }

  const tokens = parsePointer(pointer);
  let current: any = root;

  for (const token of tokens) {
    if (current === null || typeof current !== "object") {
      return { found: false };
    }

    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        return { found: false };
      }
      current = current[token];
    }
  }

  return { found: true, value: current };
}

/**
 * Deep equality check for JSON-compatible values.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) {
      return false;
    }
    if (!deepEqual(objA[key], objB[key])) {
      return false;
    }
  }

  return true;
}

export interface ActualDiff {
  path: string;
  operation: ChangeOperation;
  before?: unknown | undefined;
  after?: unknown | undefined;
}

/**
 * Computes all structural differences between original and candidate.
 */
export function computeActualDiffs(
  original: unknown,
  candidate: unknown,
  currentTokens: (string | number)[] = [],
): ActualDiff[] {
  if (deepEqual(original, candidate)) {
    return [];
  }

  const path = buildPointer(currentTokens);

  if (
    original === null ||
    candidate === null ||
    typeof original !== "object" ||
    typeof candidate !== "object" ||
    Array.isArray(original) !== Array.isArray(candidate)
  ) {
    return [
      {
        path,
        operation: "replace",
        before: original,
        after: candidate,
      },
    ];
  }

  if (Array.isArray(original) && Array.isArray(candidate)) {
    // If array items changed or lengths differ, compare element by element
    const diffs: ActualDiff[] = [];
    const maxLen = Math.max(original.length, candidate.length);

    for (let i = 0; i < maxLen; i++) {
      if (i >= original.length) {
        diffs.push({
          path: buildPointer([...currentTokens, i]),
          operation: "add",
          after: candidate[i],
        });
      } else if (i >= candidate.length) {
        diffs.push({
          path: buildPointer([...currentTokens, i]),
          operation: "remove",
          before: original[i],
        });
      } else if (!deepEqual(original[i], candidate[i])) {
        diffs.push(...computeActualDiffs(original[i], candidate[i], [...currentTokens, i]));
      }
    }

    return diffs;
  }

  // Both are objects
  const objOrig = original as Record<string, unknown>;
  const objCand = candidate as Record<string, unknown>;
  const keysOrig = new Set(Object.keys(objOrig));
  const keysCand = new Set(Object.keys(objCand));
  const diffs: ActualDiff[] = [];

  for (const key of keysOrig) {
    if (!keysCand.has(key)) {
      diffs.push({
        path: buildPointer([...currentTokens, key]),
        operation: "remove",
        before: objOrig[key],
      });
    }
  }

  for (const key of keysCand) {
    if (!keysOrig.has(key)) {
      diffs.push({
        path: buildPointer([...currentTokens, key]),
        operation: "add",
        after: objCand[key],
      });
    } else if (!deepEqual(objOrig[key], objCand[key])) {
      diffs.push(...computeActualDiffs(objOrig[key], objCand[key], [...currentTokens, key]));
    }
  }

  return diffs;
}

export interface ChangeAuditResult {
  valid: boolean;
  mismatchedChanges: Array<{
    change: ChangeEvidence;
    reason: string;
  }>;
  undeclaredChanges: ActualDiff[];
  spuriousChanges: ChangeEvidence[];
}

/**
 * Confirms every declared repair change matches the actual original-to-candidate difference
 * and detects undeclared changes.
 */
export function auditChanges(
  original: unknown,
  candidate: unknown,
  declaredChanges: ChangeEvidence[],
  explicitRulesCount?: number,
): ChangeAuditResult {
  const mismatchedChanges: Array<{ change: ChangeEvidence; reason: string }> = [];
  const actualDiffs = computeActualDiffs(original, candidate);

  // 1. Verify each declared change
  for (const change of declaredChanges) {
    // Validate rule indexes
    if (!Array.isArray(change.rule_indexes) || change.rule_indexes.length === 0) {
      mismatchedChanges.push({
        change,
        reason: "Declared change must reference at least one rule_index.",
      });
      continue;
    }

    if (explicitRulesCount !== undefined) {
      const invalidIdx = change.rule_indexes.find(
        (idx) => !Number.isInteger(idx) || idx < 0 || idx >= explicitRulesCount,
      );
      if (invalidIdx !== undefined) {
        mismatchedChanges.push({
          change,
          reason: `Declared rule_index ${invalidIdx} is out of bounds (rules count: ${explicitRulesCount}).`,
        });
        continue;
      }
    }

    // Validate path existence and before/after values
    const origLoc = getValueAtPointer(original, change.path);
    const candLoc = getValueAtPointer(candidate, change.path);

    switch (change.operation) {
      case "add": {
        if (origLoc.found) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'add' at '${change.path}' invalid: property already exists in original.`,
          });
        } else if (!candLoc.found) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'add' at '${change.path}' invalid: property missing in candidate.`,
          });
        } else if (!deepEqual(candLoc.value, change.after)) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'add' at '${change.path}' invalid: declared 'after' does not match candidate value.`,
          });
        }
        break;
      }
      case "replace": {
        if (!origLoc.found) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'replace' at '${change.path}' invalid: path not found in original.`,
          });
        } else if (!candLoc.found) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'replace' at '${change.path}' invalid: path not found in candidate.`,
          });
        } else if (!deepEqual(origLoc.value, change.before)) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'replace' at '${change.path}' invalid: declared 'before' does not match original value.`,
          });
        } else if (!deepEqual(candLoc.value, change.after)) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'replace' at '${change.path}' invalid: declared 'after' does not match candidate value.`,
          });
        } else if (deepEqual(origLoc.value, candLoc.value)) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'replace' at '${change.path}' invalid: no actual change occurred (before equals after).`,
          });
        }
        break;
      }
      case "remove": {
        if (!origLoc.found) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'remove' at '${change.path}' invalid: path not found in original.`,
          });
        } else if (candLoc.found) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'remove' at '${change.path}' invalid: property still exists in candidate.`,
          });
        } else if (!deepEqual(origLoc.value, change.before)) {
          mismatchedChanges.push({
            change,
            reason: `Operation 'remove' at '${change.path}' invalid: declared 'before' does not match original value.`,
          });
        }
        break;
      }
      default: {
        mismatchedChanges.push({
          change,
          reason: `Unknown operation '${change.operation}'.`,
        });
      }
    }
  }

  // 2. Check for undeclared changes
  // An actual difference is covered by a declared change if the change path equals or is a parent of the diff path
  const undeclaredChanges = actualDiffs.filter((diff) => {
    return !declaredChanges.some((declared) => {
      if (declared.path === diff.path) {
        return true;
      }
      // If declared path is a parent of diff path (e.g. declared is "" or "/address" and diff is "/address/street")
      if (declared.path === "") {
        return true;
      }
      return diff.path.startsWith(declared.path + "/");
    });
  });

  // 3. Check for spurious changes (declared changes that did not alter the document)
  const spuriousChanges = declaredChanges.filter((declared) => {
    return !actualDiffs.some((diff) => {
      if (diff.path === declared.path) {
        return true;
      }
      if (declared.path === "") {
        return true;
      }
      return diff.path.startsWith(declared.path + "/");
    });
  });

  const valid =
    mismatchedChanges.length === 0 &&
    undeclaredChanges.length === 0 &&
    spuriousChanges.length === 0;

  return {
    valid,
    mismatchedChanges,
    undeclaredChanges,
    spuriousChanges,
  };
}
