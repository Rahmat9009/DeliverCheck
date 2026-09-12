import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/repair/canonical-json.js";

describe("canonicalize", () => {
  it("sorts object keys by UTF-16 code unit order", () => {
    expect(canonicalize({ b: 1, a: 2, ["é"]: 3 })).toBe('{"a":2,"b":1,"é":3}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("serializes nested structures deterministically regardless of input key order", () => {
    const first = canonicalize({ z: { y: 1, x: 2 }, a: [1, 2, 3] });
    const second = canonicalize({ a: [1, 2, 3], z: { x: 2, y: 1 } });
    expect(first).toBe(second);
  });

  it("round-trips primitives", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hi")).toBe('"hi"');
  });

  it("escapes strings the same way JSON.stringify does", () => {
    expect(canonicalize("a\"b\\c\nd")).toBe(JSON.stringify("a\"b\\c\nd"));
  });
});
