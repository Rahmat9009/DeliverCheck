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
      const childPath = `${path}/${k}`;
      if (k === "$ref") {
        refCount++;
        if (refCount > limits.maxSchemaRefs) {
          throw new SecurityViolationError(
            "schema_complexity_exceeded",
            `Schema reference count (${refCount}) exceeds limit of ${limits.maxSchemaRefs}.`,
            childPath,
          );
        }

        if (typeof v === "string") {
          // Check for unsupported remote references
          // Local references start with '#' (e.g. '#/$defs/name' or '#/definitions/name' or '#')
          if (!v.startsWith("#")) {
            throw new SecurityViolationError(
              "unsupported_remote_reference",
              `Remote schema reference '${v}' is unsupported for security and reproducibility.`,
              childPath,
            );
          }
        }
      }

      traverseSchema(v, childPath);
    }
  }

  traverseSchema(schema, "");
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
 * Wraps execution within a time limit.
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
