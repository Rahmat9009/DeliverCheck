import { describe, expect, it } from "vitest";

import {
  analyzeSlashDate,
  isAmbiguousCommaNumber,
  looksLikeCurrencySymbol,
  resolveCommaNumber,
  resolveSlashDateToIso,
} from "../../src/repair/ambiguity.js";

describe("analyzeSlashDate", () => {
  it("flags a date as ambiguous when both components could be a month", () => {
    const result = analyzeSlashDate("03/04/2026");
    expect(result).toMatchObject({ matches: true, ambiguous: true });
  });

  it("does not flag a date as ambiguous when one component cannot be a month", () => {
    const result = analyzeSlashDate("25/04/2026");
    expect(result).toMatchObject({ matches: true, ambiguous: false });
  });

  it("does not flag same-value components as ambiguous", () => {
    const result = analyzeSlashDate("05/05/2026");
    expect(result).toMatchObject({ matches: true, ambiguous: false });
  });

  it("reports no match for non-date strings", () => {
    expect(analyzeSlashDate("hello")).toEqual({ matches: false });
  });
});

describe("resolveSlashDateToIso", () => {
  it("resolves day-month-year order", () => {
    expect(resolveSlashDateToIso("03/04/2026", "DMY")).toBe("2026-04-03");
  });

  it("resolves month-day-year order", () => {
    expect(resolveSlashDateToIso("03/04/2026", "MDY")).toBe("2026-03-04");
  });
});

describe("comma numbers", () => {
  it("flags a bare comma-grouped number as ambiguous", () => {
    expect(isAmbiguousCommaNumber("1,234")).toBe(true);
  });

  it("resolves the comma as a thousands separator", () => {
    expect(resolveCommaNumber("1,234", "thousands")).toBe("1234");
  });

  it("resolves the comma as a decimal separator", () => {
    expect(resolveCommaNumber("1,234", "decimal")).toBe("1.234");
  });
});

describe("looksLikeCurrencySymbol", () => {
  it("recognizes common ambiguous symbols", () => {
    expect(looksLikeCurrencySymbol("$")).toBe(true);
    expect(looksLikeCurrencySymbol("kr")).toBe(true);
  });

  it("does not flag an ISO currency code", () => {
    expect(looksLikeCurrencySymbol("USD")).toBe(false);
  });
});
