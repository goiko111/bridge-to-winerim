import type { JsonValue } from "../../contracts";
import type { OutboundExecutionLog } from "./types";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret)/i;
const HEADER_SECRET = /((?:authorization|api[-_ ]?token|api[-_ ]?key|access[-_ ]?token|password|secret)\s*[:=]\s*)([^\s,;]+)/gi;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=:-]+/gi;
const JWT = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const SECRET_QUERY = /([?&](?:token|api[-_]?token|api[-_]?key|access[-_]?token|password|secret)=)[^&#\s]+/gi;

export type OutboundSanitizeOptions = {
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
};

const DEFAULT_SANITIZE_OPTIONS: Required<OutboundSanitizeOptions> = {
  maxDepth: 5,
  maxArrayLength: 20,
  maxObjectKeys: 40,
  maxStringLength: 240,
};

export function sanitizeOutboundText(value: unknown, maxLength = 240): string {
  let text = value instanceof Error ? value.message : String(value ?? "");
  text = text
    .replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(HEADER_SECRET, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(SECRET_QUERY, (_match, prefix: string) => `${prefix}${REDACTED}`);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}${TRUNCATED}`;
}

export function sanitizeOutboundValue(
  value: unknown,
  options: OutboundSanitizeOptions = {},
): JsonValue {
  const resolved = { ...DEFAULT_SANITIZE_OPTIONS, ...options };

  function visit(current: unknown, depth: number): JsonValue {
    if (current === null || current === undefined) return null;
    if (typeof current === "string") return sanitizeOutboundText(current, resolved.maxStringLength);
    if (typeof current === "number") return Number.isFinite(current) ? current : String(current);
    if (typeof current === "boolean") return current;
    if (typeof current === "bigint" || typeof current === "symbol" || typeof current === "function") {
      return sanitizeOutboundText(current, resolved.maxStringLength);
    }
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Error) {
      return { name: current.name, message: sanitizeOutboundText(current.message, resolved.maxStringLength) };
    }
    if (depth >= resolved.maxDepth) return TRUNCATED;
    if (Array.isArray(current)) {
      const values = current.slice(0, resolved.maxArrayLength).map((entry) => visit(entry, depth + 1));
      if (current.length > resolved.maxArrayLength) values.push(TRUNCATED);
      return values;
    }
    if (typeof current === "object") {
      const output: Record<string, JsonValue> = {};
      const entries = Object.entries(current as Record<string, unknown>);
      for (const [key, entry] of entries.slice(0, resolved.maxObjectKeys)) {
        output[key] = SENSITIVE_KEY.test(key) ? REDACTED : visit(entry, depth + 1);
      }
      if (entries.length > resolved.maxObjectKeys) output.__truncated__ = true;
      return output;
    }
    return sanitizeOutboundText(current, resolved.maxStringLength);
  }

  return visit(value, 0);
}

export function sanitizeOutboundLog(record: OutboundExecutionLog): OutboundExecutionLog {
  const sanitized = sanitizeOutboundValue(record) as Record<string, JsonValue>;
  return sanitized as unknown as OutboundExecutionLog;
}
