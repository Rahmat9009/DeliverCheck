import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

export const SUPPORTED_JSON_SCHEMA_FORMATS = [
  "date",
  "date-time",
  "email",
  "uri",
] as const;

export const strictAjvOptions = {
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateFormats: true,
} as const;

const addFormats = addFormatsModule as unknown as FormatsPlugin;

/** Builds an isolated strict Draft 2020-12 validator with the MVP format set. */
export function createStrictAjv(): Ajv2020 {
  const ajv = new Ajv2020(strictAjvOptions);
  addFormats(ajv, {
    mode: "full",
    formats: [...SUPPORTED_JSON_SCHEMA_FORMATS],
  });
  return ajv;
}
