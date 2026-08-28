import { describe, expect, test } from "bun:test";
import { diffSchema, parseSchemaSql, splitSqlStatements } from "../src/schema-diff";

function diff(currentSql: string, desiredSql: string) {
  return diffSchema(parseSchemaSql(currentSql), parseSchemaSql(desiredSql));
}

describe("statement splitting", () => {
  test("strips comments and respects quoted semicolons", () => {
    const statements = splitSqlStatements(`
      -- leading comment; with a semicolon
      CREATE TABLE a (id TEXT PRIMARY KEY); /* block; comment */
      CREATE TABLE b (note TEXT DEFAULT 'semi;colon');
    `);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("CREATE TABLE a");
    expect(statements[1]).toContain("'semi;colon'");
    expect(statements[1]).not.toContain("comment");
  });

  test("handles escaped quotes inside literals", () => {
    const statements = splitSqlStatements(`CREATE TABLE a (note TEXT DEFAULT 'it''s; fine')`);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("'it''s; fine'");
  });
});

describe("schema parsing", () => {
  test("parses tables, columns, constraints, and indexes", () => {
    const schema = parseSchemaSql(`
      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        verdict TEXT CHECK (verdict IN ('approved','changes_requested')),
        UNIQUE (id, title)
      );
      CREATE UNIQUE INDEX plans_title ON plans(title) WHERE title IS NOT NULL;
    `);
    const table = schema.tables.get("plans")!;
    expect([...table.columns.keys()]).toEqual(["id", "title", "verdict"]);
    expect(table.constraints).toHaveLength(1);
    expect(schema.indexes.get("plans_title")!.normalized).toContain("where title is not null");
  });

  test("quoted identifiers are normalized", () => {
    const schema = parseSchemaSql(`CREATE TABLE "Weird Name" ("Col One" TEXT)`);
    expect(schema.tables.get("weird name")!.columns.has("col one")).toBe(true);
  });

  test("IF NOT EXISTS in the source is accepted", () => {
    const schema = parseSchemaSql(`CREATE TABLE IF NOT EXISTS a (id TEXT); CREATE INDEX IF NOT EXISTS a_id ON a(id)`);
    expect(schema.tables.has("a")).toBe(true);
    expect(schema.indexes.has("a_id")).toBe(true);
  });

  test("rejects statements other than CREATE TABLE and CREATE INDEX", () => {
    expect(() => parseSchemaSql("DROP TABLE users")).toThrow(/unsupported statement/);
    expect(() => parseSchemaSql("INSERT INTO a VALUES (1)")).toThrow(/unsupported statement/);
    expect(() => parseSchemaSql("CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END")).toThrow(/unsupported statement/);
  });

  test("rejects reserved and duplicate names", () => {
    expect(() => parseSchemaSql("CREATE TABLE _myslop_schema (id TEXT)")).toThrow(/reserved/);
    expect(() => parseSchemaSql("CREATE TABLE sqlite_seq (id TEXT)")).toThrow(/reserved/);
    expect(() => parseSchemaSql("CREATE TABLE a (id TEXT); CREATE TABLE a (id TEXT)")).toThrow(/duplicate table/);
    expect(() => parseSchemaSql("CREATE TABLE a (id TEXT, id TEXT)")).toThrow(/duplicate column/);
  });
});

describe("schema diffing", () => {
  test("empty baseline creates everything with IF NOT EXISTS", () => {
    const result = diff("", `
      CREATE TABLE todos (id TEXT PRIMARY KEY, text TEXT NOT NULL);
      CREATE INDEX todos_text ON todos(text);
    `);
    expect(result.destructive).toEqual([]);
    expect(result.statements).toHaveLength(2);
    expect(result.statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS todos/i);
    expect(result.statements[1]).toMatch(/^CREATE INDEX IF NOT EXISTS todos_text/i);
  });

  test("identical schemas produce no work", () => {
    const sql = "CREATE TABLE a (id TEXT PRIMARY KEY, name TEXT)";
    const result = diff(sql, sql);
    expect(result.statements).toEqual([]);
    expect(result.destructive).toEqual([]);
  });

  test("formatting and case differences are not changes", () => {
    const result = diff(
      "CREATE TABLE a (id TEXT PRIMARY KEY, name text not null default 'x')",
      "create table a (\n  id TEXT primary key,\n  name TEXT NOT NULL DEFAULT 'x'\n)",
    );
    expect(result.statements).toEqual([]);
    expect(result.destructive).toEqual([]);
  });

  test("new nullable columns become ALTER TABLE ADD COLUMN", () => {
    const result = diff(
      "CREATE TABLE a (id TEXT PRIMARY KEY)",
      "CREATE TABLE a (id TEXT PRIMARY KEY, note TEXT, count INTEGER NOT NULL DEFAULT 0)",
    );
    expect(result.destructive).toEqual([]);
    expect(result.statements).toEqual([
      `ALTER TABLE "a" ADD COLUMN note TEXT`,
      `ALTER TABLE "a" ADD COLUMN count INTEGER NOT NULL DEFAULT 0`,
    ]);
  });

  test("unsafe column additions are destructive", () => {
    const unique = diff("CREATE TABLE a (id TEXT)", "CREATE TABLE a (id TEXT, email TEXT UNIQUE)");
    expect(unique.destructive.join()).toContain("a.email");
    const notNull = diff("CREATE TABLE a (id TEXT)", "CREATE TABLE a (id TEXT, kind TEXT NOT NULL)");
    expect(notNull.destructive.join()).toContain("requires a DEFAULT");
  });

  test("removed or changed columns and tables are destructive", () => {
    expect(diff("CREATE TABLE a (id TEXT, note TEXT)", "CREATE TABLE a (id TEXT)").destructive)
      .toEqual(["column a.note: removed"]);
    expect(diff("CREATE TABLE a (id TEXT)", "CREATE TABLE a (id INTEGER)").destructive)
      .toEqual(["column a.id: definition changed"]);
    expect(diff("CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT)", "CREATE TABLE a (id TEXT)").destructive)
      .toEqual(["table b: removed"]);
  });

  test("constraint changes are destructive", () => {
    const result = diff(
      "CREATE TABLE a (x TEXT, y TEXT, UNIQUE (x, y))",
      "CREATE TABLE a (x TEXT, y TEXT)",
    );
    expect(result.destructive).toEqual(["table a: constraints or table options changed"]);
  });

  test("index changes are safe: dropped, added, and recreated", () => {
    const result = diff(
      "CREATE TABLE a (x TEXT, y TEXT); CREATE INDEX by_x ON a(x); CREATE INDEX old ON a(y)",
      "CREATE TABLE a (x TEXT, y TEXT); CREATE INDEX by_x ON a(x, y); CREATE INDEX fresh ON a(y)",
    );
    expect(result.destructive).toEqual([]);
    expect(result.statements).toEqual([
      `DROP INDEX IF EXISTS "by_x"`,
      "CREATE INDEX IF NOT EXISTS by_x ON a(x, y)",
      `DROP INDEX IF EXISTS "old"`,
      "CREATE INDEX IF NOT EXISTS fresh ON a(y)",
    ]);
  });

  test("new table plus new index orders table creation first", () => {
    const result = diff("CREATE TABLE a (id TEXT)", `
      CREATE TABLE a (id TEXT);
      CREATE TABLE b (id TEXT, a_id TEXT REFERENCES a(id));
      CREATE INDEX b_a ON b(a_id);
    `);
    expect(result.destructive).toEqual([]);
    expect(result.statements[0]).toMatch(/CREATE TABLE IF NOT EXISTS b/i);
    expect(result.statements[1]).toMatch(/CREATE INDEX IF NOT EXISTS b_a/i);
  });
});
