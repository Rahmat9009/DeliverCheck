import { describe, expect, it } from "vitest";

import { findUnsafeKeys, getAt, hasAt, removeAt, setAt, toPointer } from "../../src/repair/json-pointer.js";

describe("getAt / hasAt", () => {
  it("reads nested values", () => {
    const doc = { a: { b: { c: 42 } } };
    expect(getAt(doc, "/a/b/c")).toBe(42);
    expect(hasAt(doc, "/a/b/c")).toBe(true);
  });

  it("returns undefined/false for missing paths without throwing", () => {
    const doc = { a: 1 };
    expect(getAt(doc, "/a/b")).toBeUndefined();
    expect(hasAt(doc, "/a/b")).toBe(false);
  });

  it("decodes ~0 and ~1 escapes", () => {
    const doc = { "a/b": { "c~d": 1 } };
    expect(getAt(doc, "/a~1b/c~0d")).toBe(1);
  });
});

describe("setAt / removeAt", () => {
  it("mutates in place at an existing parent", () => {
    const doc: { a: { b: number } } = { a: { b: 1 } };
    setAt(doc, "/a/b", 2);
    expect(doc.a.b).toBe(2);
  });

  it("removes a leaf without touching siblings", () => {
    const doc: { a: number; b: number } = { a: 1, b: 2 };
    removeAt(doc, "/a");
    expect(doc).toEqual({ b: 2 });
  });
});

describe("toPointer", () => {
  it("escapes segments", () => {
    expect(toPointer(["a/b", "c~d"])).toBe("/a~1b/c~0d");
  });

  it("returns the empty string for zero segments", () => {
    expect(toPointer([])).toBe("");
  });
});

describe("findUnsafeKeys", () => {
  it("returns an empty array for safe documents", () => {
    expect(findUnsafeKeys({ a: { b: [1, 2, { c: 3 }] } })).toEqual([]);
  });

  it("finds a reserved key at the top level", () => {
    const doc = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    expect(findUnsafeKeys(doc as never)).toEqual(["/__proto__"]);
  });

  it("finds reserved keys nested inside arrays", () => {
    const doc = JSON.parse('{"items": [1, {"constructor": "x"}]}') as unknown;
    expect(findUnsafeKeys(doc as never)).toEqual(["/items/1/constructor"]);
  });
});
