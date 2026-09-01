import { describe, expect, it } from "vitest";
import {
  allowlistedIdentifier,
  sql,
  SqlValidationError,
} from "../../cloudflare/workers/middleware-api/src/db";

describe("Cloudflare Postgres SQL builder", () => {
  it("parameterizes every dynamic value without embedding it in SQL", () => {
    const connectionId = "e5b988f1-8471-4336-a1f7-a5c1626deab1";
    const statement = sql`
      SELECT id, name
      FROM pos_connections
      WHERE id = ${connectionId} AND enabled = ${true}
    `;

    expect(statement.text).toContain("id = $1 AND enabled = $2");
    expect(statement.text).not.toContain(connectionId);
    expect(statement.values).toEqual([connectionId, true]);
  });

  it("keeps repeated or array values as parameters", () => {
    const ids = ["one", "two"];
    const statement = sql`SELECT id FROM pos_connections WHERE id = ANY(${ids}) OR owner_id = ${"one"}`;

    expect(statement.text).toBe("SELECT id FROM pos_connections WHERE id = ANY($1) OR owner_id = $2");
    expect(statement.values).toEqual([ids, "one"]);
  });

  it("quotes only identifiers present in the explicit allowlist", () => {
    const table = allowlistedIdentifier("public.pos_connections", [
      "public.pos_connections",
      "public.sales_events",
    ] as const);
    const statement = sql`SELECT id FROM ${table} WHERE id = ${"abc"}`;

    expect(statement.text).toBe('SELECT id FROM "public"."pos_connections" WHERE id = $1');
    expect(statement.values).toEqual(["abc"]);
  });

  it("rejects identifiers outside the allowlist", () => {
    expect(() => allowlistedIdentifier("public.secrets", ["public.pos_connections"] as const))
      .toThrowError(expect.objectContaining({ code: "DB_SQL_IDENTIFIER_NOT_ALLOWED" }));
  });

  it("rejects malformed identifiers even when accidentally allowlisted", () => {
    expect(() => allowlistedIdentifier('public.pos_connections"; DROP TABLE users; --', [
      'public.pos_connections"; DROP TABLE users; --',
    ] as const)).toThrowError(expect.objectContaining({ code: "DB_SQL_INVALID_IDENTIFIER" }));
  });

  it("rejects manual placeholders so values cannot bypass the tag", () => {
    expect(() => sql`SELECT id FROM pos_connections WHERE id = $1`)
      .toThrowError(expect.objectContaining({ code: "DB_SQL_MANUAL_PLACEHOLDER" }));
  });

  it("rejects multiple statements and explicit transaction control", () => {
    expect(() => sql`SELECT 1; DELETE FROM pos_connections`)
      .toThrowError(expect.objectContaining({ code: "DB_SQL_MULTIPLE_STATEMENTS" }));
    expect(() => sql`BEGIN`)
      .toThrowError(expect.objectContaining({ code: "DB_SQL_TRANSACTION_CONTROL" }));
  });

  it("ignores placeholder-looking text and semicolons inside literals and comments", () => {
    const statement = sql`SELECT '$1; not executable' AS sample /* ; $2 */ WHERE id = ${7};`;

    expect(statement.values).toEqual([7]);
    expect(statement.text).toContain("WHERE id = $1;");
  });

  it("rejects values that node-postgres cannot safely serialize", () => {
    const build = () => sql`SELECT ${undefined}`;
    expect(build).toThrowError(SqlValidationError);
    expect(build).toThrowError(expect.objectContaining({ code: "DB_SQL_INVALID_VALUE" }));
  });
});
