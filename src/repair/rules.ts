import type { UnresolvedIssue } from "../types.js";

/**
 * DeliverCheck's explicit rules are free-text strings (frozen by
 * `contracts/request.schema.json`), so this module recognizes a small,
 * documented set of deterministic phrasings (see `docs/repair-engine.md`).
 * Only text matching one of these patterns becomes an actionable directive;
 * everything else is inert supporting context. This keeps every applied
 * change traceable to an unambiguous, regex-matched instruction rather than
 * a guess about free-form prose.
 */

export interface RenameDirective {
  kind: "rename";
  ruleIndex: number;
  from: string;
  to: string;
}

export interface MoveDirective {
  kind: "move";
  ruleIndex: number;
  from: string;
  to: string;
}

export interface EnumNormalizeDirective {
  kind: "enum_normalize";
  ruleIndex: number;
  field: string;
  fromValue: string;
  toValue: string;
}

export interface TrimWhitespaceDirective {
  kind: "trim_whitespace";
  ruleIndex: number;
  field: string | "*";
}

export interface IdentifierPreserveDirective {
  kind: "identifier_preserve";
  ruleIndex: number;
  field: string;
}

export interface ConstantRequirementDirective {
  kind: "constant_requirement";
  ruleIndex: number;
  field: string;
  value: string;
}

export type DateOrder = "DMY" | "MDY" | "YMD";

export interface DateFormatDirective {
  kind: "date_format";
  ruleIndex: number;
  field: string | "*";
  order: DateOrder;
}

export interface NumberSeparatorDirective {
  kind: "number_separator";
  ruleIndex: number;
  field: string;
  commaMeans: "decimal" | "thousands";
}

export interface CurrencySymbolDirective {
  kind: "currency_symbol";
  ruleIndex: number;
  field: string;
  symbol: string;
  code: string;
}

export type Directive =
  | RenameDirective
  | MoveDirective
  | EnumNormalizeDirective
  | TrimWhitespaceDirective
  | IdentifierPreserveDirective
  | ConstantRequirementDirective
  | DateFormatDirective
  | NumberSeparatorDirective
  | CurrencySymbolDirective;

export interface ParsedRules {
  directives: Directive[];
  contradictions: UnresolvedIssue[];
}

const RENAME_RE = /^rename\s+(?:field\s+)?"([^"]+)"\s+to\s+"([^"]+)"\s*\.?$/i;
const MOVE_RE = /^move\s+"([^"]+)"\s+to\s+"([^"]+)"\s*\.?$/i;
const ENUM_NORMALIZE_RE = /^normalize\s+"([^"]+)"\s+value\s+"([^"]+)"\s+to\s+"([^"]+)"\s*\.?$/i;
const TRIM_RE = /\b(?:trim|remove)\b[\s\S]*?\bwhitespace\b[\s\S]*?\bfrom\b\s+(?:"([^"]+)"|(all fields|any field))/i;
const QUOTED_CONSTANT_RE =
  /^(?:the\s+)?(?:"([^"]+)"|([A-Za-z0-9_]+))\s+(?:field\s+)?must\s+be\s+"([^"]+)"\s*\.?$/i;
const TOKEN_CONSTANT_RE =
  /^(?:the\s+)?(?:"([^"]+)"|([A-Za-z0-9_]+))\s+(?:field\s+)?must\s+be\s+([A-Z][A-Z0-9_-]{1,15})\s*\.?$/;
const DATE_FORMAT_RE =
  /^dates?\s+(?:in\s+"([^"]+)"\s+)?(?:are|use|follow)\s+(?:the\s+)?(?:format\s+)?"?(DD\/MM\/YYYY|MM\/DD\/YYYY|YYYY-MM-DD)"?\s*\.?$/i;
const NUMBER_DECIMAL_RE = /^"?,"?\s+is\s+the\s+decimal\s+separator\s+for\s+"([^"]+)"\s*\.?$/i;
const NUMBER_THOUSANDS_RE = /^"?,"?\s+is\s+the\s+thousands?\s+separator\s+for\s+"([^"]+)"\s*\.?$/i;
const CURRENCY_SYMBOL_RE = /^"([^"]+)"\s+means\s+"([A-Za-z0-9]+)"\s+for\s+"([^"]+)"\s*\.?$/i;
const LEADING_ZERO_RE = /\bleading zeros?\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsField(ruleText: string, fieldName: string): boolean {
  return new RegExp(`\\b${escapeRegExp(fieldName)}\\b`).test(ruleText);
}

function dateOrderFromToken(token: string): DateOrder {
  switch (token.toUpperCase()) {
    case "DD/MM/YYYY":
      return "DMY";
    case "MM/DD/YYYY":
      return "MDY";
    default:
      return "YMD";
  }
}

/**
 * Parses `explicitRules` into deterministic directives plus any detected
 * contradictions (two rules asserting different required constants for the
 * same field). `fieldNames` should list the target schema's known field
 * names so identifier/leading-zero rules can be tied to the field they
 * describe.
 */
export function parseExplicitRules(explicitRules: readonly string[], fieldNames: readonly string[]): ParsedRules {
  const directives: Directive[] = [];
  const constantsByField = new Map<string, { value: string; ruleIndex: number }[]>();

  explicitRules.forEach((rawRule, ruleIndex) => {
    const rule = rawRule.trim();

    const rename = RENAME_RE.exec(rule);
    if (rename) {
      directives.push({ kind: "rename", ruleIndex, from: rename[1] as string, to: rename[2] as string });
    }

    const move = MOVE_RE.exec(rule);
    if (move) {
      directives.push({ kind: "move", ruleIndex, from: move[1] as string, to: move[2] as string });
    }

    const enumNormalize = ENUM_NORMALIZE_RE.exec(rule);
    if (enumNormalize) {
      directives.push({
        kind: "enum_normalize",
        ruleIndex,
        field: enumNormalize[1] as string,
        fromValue: enumNormalize[2] as string,
        toValue: enumNormalize[3] as string,
      });
    }

    const trim = TRIM_RE.exec(rule);
    if (trim) {
      directives.push({ kind: "trim_whitespace", ruleIndex, field: (trim[1] as string | undefined) ?? "*" });
    }

    const dateFormat = DATE_FORMAT_RE.exec(rule);
    if (dateFormat) {
      directives.push({
        kind: "date_format",
        ruleIndex,
        field: (dateFormat[1] as string | undefined) ?? "*",
        order: dateOrderFromToken(dateFormat[2] as string),
      });
    }

    const numberDecimal = NUMBER_DECIMAL_RE.exec(rule);
    if (numberDecimal) {
      directives.push({
        kind: "number_separator",
        ruleIndex,
        field: numberDecimal[1] as string,
        commaMeans: "decimal",
      });
    }

    const numberThousands = NUMBER_THOUSANDS_RE.exec(rule);
    if (numberThousands) {
      directives.push({
        kind: "number_separator",
        ruleIndex,
        field: numberThousands[1] as string,
        commaMeans: "thousands",
      });
    }

    const currencySymbol = CURRENCY_SYMBOL_RE.exec(rule);
    if (currencySymbol) {
      directives.push({
        kind: "currency_symbol",
        ruleIndex,
        symbol: currencySymbol[1] as string,
        code: currencySymbol[2] as string,
        field: currencySymbol[3] as string,
      });
    }

    const constant = QUOTED_CONSTANT_RE.exec(rule) ?? TOKEN_CONSTANT_RE.exec(rule);
    if (constant) {
      const field = (constant[1] ?? constant[2]) as string;
      const value = constant[3] as string;
      directives.push({ kind: "constant_requirement", ruleIndex, field, value });
      const existing = constantsByField.get(field) ?? [];
      existing.push({ value, ruleIndex });
      constantsByField.set(field, existing);
    }

    if (LEADING_ZERO_RE.test(rule)) {
      for (const fieldName of fieldNames) {
        if (mentionsField(rule, fieldName)) {
          directives.push({ kind: "identifier_preserve", ruleIndex, field: fieldName });
        }
      }
    }
  });

  const contradictions: UnresolvedIssue[] = [];
  for (const [field, entries] of constantsByField) {
    const distinctValues = new Set(entries.map((entry) => entry.value));
    if (distinctValues.size > 1) {
      contradictions.push({
        code: "contradictory_requirements",
        message: `Explicit rules disagree about the required value of "${field}": ${[...distinctValues]
          .map((value) => `"${value}"`)
          .join(" vs. ")}.`,
        path: `/${field}`,
        rule_indexes: entries.map((entry) => entry.ruleIndex),
      });
    }
  }

  return { directives, contradictions };
}
