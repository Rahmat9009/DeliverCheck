export interface SecurityLimits {
  /** Maximum allowed size in bytes for raw payload text (default: 1MB = 1048576) */
  maxPayloadBytes: number;
  /** Maximum object/array nesting depth (default: 32) */
  maxDepth: number;
  /** Maximum number of AST/node objects allowed in a target schema (default: 256) */
  maxSchemaNodes: number;
  /** Maximum number of references allowed in schema (default: 64) */
  maxSchemaRefs: number;
  /** Maximum execution time in milliseconds for verification (default: 1000ms) */
  maxExecutionMs: number;
}

export const DEFAULT_SECURITY_LIMITS: SecurityLimits = {
  maxPayloadBytes: 1024 * 1024, // 1MB
  maxDepth: 32,
  maxSchemaNodes: 256,
  maxSchemaRefs: 64,
  maxExecutionMs: 1000,
};

export const MAX_SCHEMA_PATTERN_LENGTH = 256;
export const MAX_SCHEMA_PATTERN_QUANTIFIERS = 20;

export class SecurityViolationError extends Error {
  public readonly code: string;
  public readonly path?: string | undefined;

  constructor(code: string, message: string, path?: string | undefined) {
    super(message);
    this.name = "SecurityViolationError";
    this.code = code;
    this.path = path;
  }
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function pointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function schemaViolation(code: string, message: string, path: string): never {
  throw new SecurityViolationError(code, message, path || "/");
}

function assertSafePattern(pattern: string, path: string): void {
  if (pattern.length > MAX_SCHEMA_PATTERN_LENGTH) {
    schemaViolation(
      "unsafe_schema_pattern",
      `Schema pattern exceeds the ${MAX_SCHEMA_PATTERN_LENGTH}-character limit.`,
      path,
    );
  }

  try {
    new RegExp(pattern, "u");
  } catch {
    schemaViolation("invalid_target_schema", "Schema pattern is not a valid regular expression.", path);
  }

  const structural = pattern
    .replace(/\\./g, "")
    .replace(/\[(?:\\.|[^\]])*\]/g, "[]");
  const quantifiers = structural.match(/[+*?]|\{\d+(?:,\d*)?\}/g)?.length ?? 0;
  const nestedQuantifier = /\([^()]*?(?:[+*]|\{\d+(?:,\d*)?\})[^()]*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(structural);
  const quantifiedAlternation = /\([^()]*\|[^()]*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(structural);
  const repeatedWildcard = /\.\*[^|)]{0,16}\.\*/.test(structural);
  const backReference = /\\[1-9]/.test(pattern);
  const lookaround = /\(\?(?:[=!]|<[=!])/.test(pattern);

  if (
    quantifiers > MAX_SCHEMA_PATTERN_QUANTIFIERS ||
    nestedQuantifier ||
    quantifiedAlternation ||
    repeatedWildcard ||
    backReference ||
    lookaround
  ) {
    schemaViolation(
      "unsafe_schema_pattern",
      "Schema pattern uses a regular-expression construct outside the bounded MVP subset.",
      path,
    );
  }
}

function decodeReferenceToken(token: string, path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    schemaViolation("invalid_target_schema", "Local schema reference contains invalid encoding.", path);
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalReference(
  root: Record<string, unknown>,
  reference: string,
  path: string,
): { target: unknown; targetPath: string } {
  if (reference === "#") {
    schemaViolation("invalid_target_schema", "Bare root self-references are unsupported.", path);
  }
  if (!reference.startsWith("#/")) {
    schemaViolation("invalid_target_schema", "Only local JSON Pointer references are supported.", path);
  }

  const tokens = reference
    .slice(2)
    .split("/")
    .map((token) => decodeReferenceToken(token, path));
  let target: unknown = root;
  for (const token of tokens) {
    if (
      target === null ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      !Object.prototype.hasOwnProperty.call(target, token)
    ) {
      schemaViolation("invalid_target_schema", "Local schema reference does not resolve.", path);
    }
    target = (target as Record<string, unknown>)[token];
  }
  return { target, targetPath: `/${tokens.map(pointerToken).join("/")}` };
}

function nestedReferences(value: unknown, path: string): Array<{ reference: string; path: string }> {
  const found: Array<{ reference: string; path: string }> = [];
  function visit(node: unknown, currentPath: string): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${currentPath}/${index}`));
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = `${currentPath}/${pointerToken(key)}`;
      if (key === "$ref" && typeof child === "string") {
        found.push({ reference: child, path: childPath });
      }
      visit(child, childPath);
    }
  }
  visit(value, path);
  return found;
}

function assertAcyclicLocalReferences(
  root: Record<string, unknown>,
  references: readonly { reference: string; path: string }[],
): void {
  function follow(reference: string, refPath: string, stack: readonly string[]): void {
    const resolved = resolveLocalReference(root, reference, refPath);
    if (stack.includes(resolved.targetPath)) {
      schemaViolation("invalid_target_schema", "Cyclic local schema references are unsupported.", refPath);
    }
    const nextStack = [...stack, resolved.targetPath];
    for (const nested of nestedReferences(resolved.target, resolved.targetPath)) {
      follow(nested.reference, nested.path, nextStack);
    }
  }

  for (const reference of references) {
    follow(reference.reference, reference.path, []);
  }
}

/**
 * Recursively scans a value for dangerous prototype keys, prototype manipulation, and excessive nesting depth.
 * Returns normally if safe; throws SecurityViolationError if a violation is detected.
 */
export function assertSafeStructure(
  value: unknown,
  limits: Pick<SecurityLimits, "maxDepth"> = DEFAULT_SECURITY_LIMITS,
  currentDepth: number = 0,
  currentPath: string = "",
): void {
  if (currentDepth > limits.maxDepth) {
    throw new SecurityViolationError(
      "depth_limit_exceeded",
      `Nesting depth of ${currentDepth} exceeds maximum allowed depth of ${limits.maxDepth}.`,
      currentPath || "/",
    );
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertSafeStructure(
        value[i],
        limits,
        currentDepth + 1,
        `${currentPath}/${i}`,
      );
    }
    return;
  }

  const obj = value as Record<string, unknown>;

  // Check prototype manipulation
  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype && proto !== Array.prototype) {
    throw new SecurityViolationError(
      "prototype_pollution_key",
      "Dangerous prototype manipulation detected in object.",
      currentPath || "/",
    );
  }

  const ownKeys = Object.getOwnPropertyNames(obj);
  for (const key of ownKeys) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new SecurityViolationError(
        "prototype_pollution_key",
        `Dangerous property name '${key}' detected in object.`,
        `${currentPath}/${key}`,
      );
    }

    const childPath = `${currentPath}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    assertSafeStructure(obj[key], limits, currentDepth + 1, childPath);
  }
}

/**
 * Checks a schema for dangerous keys, excessive complexity, and unsupported remote references.
 */
export function assertSafeTargetSchema(
  schema: unknown,
  limits: SecurityLimits = DEFAULT_SECURITY_LIMITS,
): void {
  if (typeof schema !== "object" || schema === null) {
    throw new SecurityViolationError(
      "invalid_target_schema",
      "Target schema must be a non-null object.",
    );
  }

  // 1. Prototype keys and depth check
  assertSafeStructure(schema, limits);

  // 2. Count schema nodes, refs, and check for remote $ref
  let nodeCount = 0;
  let refCount = 0;
  const references: Array<{ reference: string; path: string }> = [];

  function traverseSchema(sub: unknown, path: string): void {
    if (sub === null || typeof sub !== "object") {
      return;
    }

    nodeCount++;
    if (nodeCount > limits.maxSchemaNodes) {
      throw new SecurityViolationError(
        "schema_complexity_exceeded",
        `Target schema node count (${nodeCount}) exceeds limit of ${limits.maxSchemaNodes}.`,
        path,
      );
    }

    if (Array.isArray(sub)) {
      for (let i = 0; i < sub.length; i++) {
        traverseSchema(sub[i], `${path}/${i}`);
      }
      return;
    }

    const obj = sub as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      const childPath = `${path}/${pointerToken(k)}`;
      if (k === "$dynamicRef" || k === "$recursiveRef") {
        schemaViolation(
          "invalid_target_schema",
          `${k} is unsupported by the bounded MVP schema subset.`,
          childPath,
        );
      }
      if (k === "$ref") {
        refCount++;
        if (refCount > limits.maxSchemaRefs) {
          throw new SecurityViolationError(
            "schema_complexity_exceeded",
            `Schema reference count (${refCount}) exceeds limit of ${limits.maxSchemaRefs}.`,
            childPath,
          );
        }

        if (typeof v !== "string") {
          schemaViolation("invalid_target_schema", "$ref must be a string.", childPath);
        }
        if (!v.startsWith("#")) {
          throw new SecurityViolationError(
            "unsupported_remote_reference",
            "Remote schema references are unsupported for security and reproducibility.",
            childPath,
          );
        }
        references.push({ reference: v, path: childPath });
      }

      if (k === "pattern") {
        if (typeof v !== "string") {
          schemaViolation("invalid_target_schema", "Schema pattern must be a string.", childPath);
        }
        assertSafePattern(v, childPath);
      }
      if (k === "patternProperties" && v !== null && typeof v === "object" && !Array.isArray(v)) {
        for (const pattern of Object.keys(v)) {
          assertSafePattern(pattern, `${childPath}/${pointerToken(pattern)}`);
        }
      }

      traverseSchema(v, childPath);
    }
  }

  traverseSchema(schema, "");
  assertAcyclicLocalReferences(schema as Record<string, unknown>, references);
}

/**
 * Asserts that payload size is within limits.
 */
export function assertSafePayloadSize(
  text: string,
  limits: Pick<SecurityLimits, "maxPayloadBytes"> = DEFAULT_SECURITY_LIMITS,
): void {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > limits.maxPayloadBytes) {
    throw new SecurityViolationError(
      "payload_size_exceeded",
      `Payload size of ${byteLength} bytes exceeds limit of ${limits.maxPayloadBytes} bytes.`,
    );
  }
}

/**
 * Measures synchronous execution and rejects a result that exceeded the
 * budget after it returns. JavaScript cannot pre-empt blocked synchronous
 * work here, so schema complexity and pattern checks are the primary guard.
 */
export function executeWithinTimeLimit<T>(
  fn: () => T,
  maxExecutionMs: number = DEFAULT_SECURITY_LIMITS.maxExecutionMs,
): { result: T; elapsedMs: number } {
  const start = performance.now();
  const result = fn();
  const elapsedMs = Math.round(performance.now() - start);

  if (elapsedMs > maxExecutionMs) {
    throw new SecurityViolationError(
      "execution_timeout",
      `Execution time of ${elapsedMs}ms exceeded limit of ${maxExecutionMs}ms.`,
    );
  }

  return { result, elapsedMs };
}
