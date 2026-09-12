import type { DateOrder } from "./rules.js";

const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

export interface SlashDateAnalysis {
  matches: true;
  ambiguous: boolean;
  first: number;
  second: number;
  year: string;
}

/**
 * Inspects a `D/M/YYYY`-shaped string. It is ambiguous exactly when both the
 * first and second components could independently be a month (1-12) and
 * they differ, so day/month order genuinely cannot be inferred from the
 * value alone.
 */
export function analyzeSlashDate(value: string): SlashDateAnalysis | { matches: false } {
  const match = SLASH_DATE_RE.exec(value);
  if (!match) {
    return { matches: false };
  }
  const first = Number(match[1]);
  const second = Number(match[2]);
  const bothCouldBeMonth = first >= 1 && first <= 12 && second >= 1 && second <= 12;
  return {
    matches: true,
    ambiguous: bothCouldBeMonth && first !== second,
    first,
    second,
    year: match[3] as string,
  };
}

/**
 * Converts a `D/M/YYYY` value to ISO `YYYY-MM-DD` given an explicit
 * day/month/year order. Returns `null` if the resulting date is not valid
 * (e.g. a declared day/month order puts an out-of-range value in the day or
 * month slot).
 */
export function resolveSlashDateToIso(value: string, order: DateOrder): string | null {
  const analysis = analyzeSlashDate(value);
  if (!analysis.matches) {
    return null;
  }
  const { first, second, year } = analysis;
  let day: number;
  let month: number;
  if (order === "DMY") {
    day = first;
    month = second;
  } else if (order === "MDY") {
    month = first;
    day = second;
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const numericYear = Number(year);
  const leapYear = numericYear % 4 === 0 &&
    (numericYear % 100 !== 0 || numericYear % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day > (daysInMonth[month - 1] as number)) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A bare thousands-or-decimal comma group, e.g. "1,234" or "12,5". */
const COMMA_NUMBER_RE = /^\d{1,3}(,\d{2,3})+$/;

/** True when a comma-bearing numeric string could plausibly mean either a decimal or a thousands separator. */
export function isAmbiguousCommaNumber(value: string): boolean {
  return COMMA_NUMBER_RE.test(value);
}

/** Rewrites a comma-bearing numeric string once the caller has said what the comma means. */
export function resolveCommaNumber(value: string, commaMeans: "decimal" | "thousands"): string | null {
  if (!isAmbiguousCommaNumber(value)) {
    return null;
  }
  if (commaMeans === "thousands") {
    return value.replace(/,/g, "");
  }
  const lastComma = value.lastIndexOf(",");
  const wholePart = value.slice(0, lastComma).replace(/,/g, "");
  const fractionPart = value.slice(lastComma + 1);
  return `${wholePart}.${fractionPart}`;
}

const CURRENCY_SYMBOL_RE = /^[^A-Za-z0-9\s]{1,3}$/;
const CURRENCY_WORD_SYMBOLS = new Set(["kr", "fr", "r$", "rs", "rp"]);

/** True for short, non-alphanumeric (or known ambiguous-word) tokens that denote a currency without pinning an ISO code. */
export function looksLikeCurrencySymbol(value: string): boolean {
  return CURRENCY_SYMBOL_RE.test(value) || CURRENCY_WORD_SYMBOLS.has(value.toLowerCase());
}
