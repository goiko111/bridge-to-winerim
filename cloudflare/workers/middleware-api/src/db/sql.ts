const SQL_STATEMENT = Symbol("middleware.sql.statement");
const SQL_IDENTIFIER = Symbol("middleware.sql.identifier");

export interface SqlStatement {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly [SQL_STATEMENT]: true;
}

interface SqlIdentifier {
  readonly sql: string;
  readonly [SQL_IDENTIFIER]: true;
}

export type SqlValue = unknown;
export type SqlInterpolation = SqlValue | SqlIdentifier;

export type SqlValidationErrorCode =
  | "DB_SQL_EMPTY"
  | "DB_SQL_INVALID_IDENTIFIER"
  | "DB_SQL_IDENTIFIER_NOT_ALLOWED"
  | "DB_SQL_INVALID_VALUE"
  | "DB_SQL_MANUAL_PLACEHOLDER"
  | "DB_SQL_MULTIPLE_STATEMENTS"
  | "DB_SQL_TRANSACTION_CONTROL";

export class SqlValidationError extends Error {
  readonly code: SqlValidationErrorCode;

  constructor(code: SqlValidationErrorCode) {
    super(code);
    this.name = "SqlValidationError";
    this.code = code;
  }
}

interface SqlScanResult {
  readonly executable: string;
  readonly semicolons: readonly number[];
  readonly hasManualPlaceholder: boolean;
}

function scanSql(text: string): SqlScanResult {
  let executable = "";
  const semicolons: number[] = [];
  let hasManualPlaceholder = false;
  let index = 0;
  let state: "code" | "single" | "double" | "line-comment" | "block-comment" | "dollar" = "code";
  let dollarTag = "";

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1] || "";

    if (state === "single") {
      if (char === "'" && next === "'") {
        index += 2;
        continue;
      }
      if (char === "'") state = "code";
      index += 1;
      continue;
    }

    if (state === "double") {
      if (char === '"' && next === '"') {
        index += 2;
        continue;
      }
      if (char === '"') state = "code";
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      if (char === "\n") {
        state = "code";
        executable += "\n";
      }
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (state === "dollar") {
      if (text.startsWith(dollarTag, index)) {
        state = "code";
        index += dollarTag.length;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === "'") {
      state = "single";
      executable += " ";
      index += 1;
      continue;
    }
    if (char === '"') {
      state = "double";
      executable += " ";
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      state = "line-comment";
      executable += "  ";
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      executable += "  ";
      index += 2;
      continue;
    }
    if (char === "$") {
      const tagMatch = text.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (tagMatch) {
        dollarTag = tagMatch[0];
        state = "dollar";
        executable += " ".repeat(dollarTag.length);
        index += dollarTag.length;
        continue;
      }
      if (/\d/.test(next)) hasManualPlaceholder = true;
    }
    if (char === ";") semicolons.push(executable.length);
    executable += char;
    index += 1;
  }

  return { executable, semicolons, hasManualPlaceholder };
}

function assertStaticSqlSegment(segment: string): void {
  if (scanSql(segment).hasManualPlaceholder) {
    throw new SqlValidationError("DB_SQL_MANUAL_PLACEHOLDER");
  }
}

function isSqlIdentifier(value: unknown): value is SqlIdentifier {
  return typeof value === "object" && value !== null && (value as SqlIdentifier)[SQL_IDENTIFIER] === true;
}

function assertParameterValue(value: unknown): void {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new SqlValidationError("DB_SQL_INVALID_VALUE");
  }
}

function validateCompleteStatement(text: string): void {
  const scan = scanSql(text);
  const executable = scan.executable.trim();
  if (!executable) throw new SqlValidationError("DB_SQL_EMPTY");

  if (scan.semicolons.length > 1) {
    throw new SqlValidationError("DB_SQL_MULTIPLE_STATEMENTS");
  }
  if (scan.semicolons.length === 1 && !executable.endsWith(";")) {
    throw new SqlValidationError("DB_SQL_MULTIPLE_STATEMENTS");
  }

  const firstKeyword = executable.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || "";
  if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "START"].includes(firstKeyword)) {
    throw new SqlValidationError("DB_SQL_TRANSACTION_CONTROL");
  }
}

export function allowlistedIdentifier<const Allowed extends readonly string[]>(
  value: string,
  allowed: Allowed,
): SqlIdentifier {
  if (!allowed.includes(value)) {
    throw new SqlValidationError("DB_SQL_IDENTIFIER_NOT_ALLOWED");
  }

  const parts = value.split(".");
  if (parts.length === 0 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new SqlValidationError("DB_SQL_INVALID_IDENTIFIER");
  }

  return Object.freeze({
    sql: parts.map((part) => `"${part}"`).join("."),
    [SQL_IDENTIFIER]: true as const,
  });
}

export function sql(
  strings: TemplateStringsArray,
  ...interpolations: readonly SqlInterpolation[]
): SqlStatement {
  const values: unknown[] = [];
  let text = "";

  strings.forEach((segment, index) => {
    assertStaticSqlSegment(segment);
    text += segment;

    if (index >= interpolations.length) return;
    const interpolation = interpolations[index];
    if (isSqlIdentifier(interpolation)) {
      text += interpolation.sql;
      return;
    }

    assertParameterValue(interpolation);
    values.push(interpolation);
    text += `$${values.length}`;
  });

  validateCompleteStatement(text);

  return Object.freeze({
    text,
    values: Object.freeze(values),
    [SQL_STATEMENT]: true as const,
  });
}

export function assertSqlStatement(statement: SqlStatement): void {
  if (
    typeof statement !== "object"
    || statement === null
    || statement[SQL_STATEMENT] !== true
    || typeof statement.text !== "string"
    || !Array.isArray(statement.values)
  ) {
    throw new SqlValidationError("DB_SQL_EMPTY");
  }
  validateCompleteStatement(statement.text);
}
