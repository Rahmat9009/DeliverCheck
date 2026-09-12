import { describe, expect, it } from "vitest";
import {
  canonicalJsonStringify,
  computeCanonicalHash,
  computeOriginalHash,
  isValidHashFormat,
} from "../../src/verify/canonical.js";

describe("RFC 8785 Canonical JSON Serialization", () => {
  it("serializes primitives deterministically", () => {
    expect(canonicalJsonStringify(null)).toBe("null");
    expect(canonicalJsonStringify(true)).toBe("true");
    expect(canonicalJsonStringify(false)).toBe("false");
    expect(canonicalJsonStringify(123)).toBe("123");
    expect(canonicalJsonStringify("hello")).toBe('"hello"');
  });

  it("normalizes negative zero to 0 per RFC 8785", () => {
    expect(canonicalJsonStringify(-0)).toBe("0");
    expect(canonicalJsonStringify(0)).toBe("0");
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJsonStringify(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
  });

  it("sorts object keys by UTF-16 code units", () => {
    const unordered = {
      z: 1,
      a: 2,
      B: 3,
      "1": 4,
      m: {
        y: 10,
        x: 20,
      },
    };
    const expected = '{"1":4,"B":3,"a":2,"m":{"x":20,"y":10},"z":1}';
    expect(canonicalJsonStringify(unordered)).toBe(expected);
  });

  it("produces identical canonical strings for different key insertion orders", () => {
    const objA = { alpha: 1, beta: 2, gamma: 3 };
    const objB = { gamma: 3, alpha: 1, beta: 2 };
    expect(canonicalJsonStringify(objA)).toBe(canonicalJsonStringify(objB));
  });

  it("handles arrays with elements without extra whitespace", () => {
    expect(canonicalJsonStringify([1, "two", false, null])).toBe('[1,"two",false,null]');
  });
});

describe("SHA-256 Hashing", () => {
  it("computes original UTF-8 hash matching sha256:<64 hex>", () => {
    const raw = '{"a": 1,   "b":2}';
    const hash = computeOriginalHash(raw);
    expect(isValidHashFormat(hash)).toBe(true);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("computes canonical hash that is invariant to object key ordering", () => {
    const obj1 = { id: "100", name: "test", amount: "5.00" };
    const obj2 = { amount: "5.00", id: "100", name: "test" };

    const hash1 = computeCanonicalHash(obj1);
    const hash2 = computeCanonicalHash(obj2);

    expect(isValidHashFormat(hash1)).toBe(true);
    expect(hash1).toBe(hash2);
  });

  it("changes hash when data actually changes", () => {
    const hashA = computeCanonicalHash({ id: "100" });
    const hashB = computeCanonicalHash({ id: "101" });
    expect(hashA).not.toBe(hashB);
  });
});
