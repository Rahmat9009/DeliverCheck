import { describe, expect, it } from "vitest";

import { hashJsonValue, hashText } from "../../src/repair/hashing.js";

const HASH_RE = /^sha256:[a-f0-9]{64}$/;

describe("hashText", () => {
  it("produces a contract-shaped hash", () => {
    expect(hashText("hello")).toMatch(HASH_RE);
  });

  it("is deterministic", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
  });

  it("differs for different text", () => {
    expect(hashText("hello")).not.toBe(hashText("hello!"));
  });
});

describe("hashJsonValue", () => {
  it("produces a contract-shaped hash", () => {
    expect(hashJsonValue({ a: 1 })).toMatch(HASH_RE);
  });

  it("is insensitive to object key order", () => {
    expect(hashJsonValue({ a: 1, b: 2 })).toBe(hashJsonValue({ b: 2, a: 1 }));
  });

  it("is sensitive to array order", () => {
    expect(hashJsonValue([1, 2])).not.toBe(hashJsonValue([2, 1]));
  });

  it("distinguishes a number from its string representation", () => {
    expect(hashJsonValue(123)).not.toBe(hashJsonValue("123"));
  });
});
