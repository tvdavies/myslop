// Declarative schema support for app databases.
//
// An app's schema.sql is restricted to CREATE TABLE and CREATE INDEX
// statements so the platform can compute forward diffs safely. Additive
// changes (new tables, new columns with safe definitions, new or changed
// indexes) become generated DDL. Anything destructive is refused with an
// instruction to write a forward migration in migrations/ instead.

interface ColumnDef {
  text: string; // whitespace-collapsed original definition, used for generated DDL
  normalized: string; // lowercased comparison form
}

export interface ParsedTable {
  name: string; // lowercased identifier
  sql: string; // original statement, executed verbatim for new tables
  columns: Map<string, ColumnDef>;
  constraints: string[]; // normalized table constraints and table options, sorted
}

export interface ParsedIndex {
  name: string; // lowercased identifier
  sql: string; // original statement, executed verbatim for new indexes
  normalized: string; // lowercased comparison form without IF NOT EXISTS
}

export interface ParsedSchema {
  tables: Map<string, ParsedTable>;
  indexes: Map<string, ParsedIndex>;
}

export interface SchemaDiff {
  statements: string[]; // DDL to execute, in order
  destructive: string[]; // human descriptions of refused changes
  summary: string[]; // human descriptions of generated changes
}

const IDENT = `"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*`;
const TABLE_RE = new RegExp(`^create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})\\s*\\(`, "i");
const INDEX_RE = new RegExp(`^create\\s+(?:unique\\s+)?index\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})\\s+on\\s+(${IDENT})\\s*\\(`, "i");
const FIRST_TOKEN_RE = new RegExp(`^(${IDENT})`);
const CONSTRAINT_KEYWORDS = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]);

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalize(text: string): string {
  return collapse(text).toLowerCase();
}

function unquote(token: string): string {
  if (token.length >= 2) {
    if (token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1).replace(/""/g, '"');
    if (token.startsWith("`") && token.endsWith("`")) return token.slice(1, -1).replace(/``/g, "`");
    if (token.startsWith("[") && token.endsWith("]")) return token.slice(1, -1);
  }
  return token;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Splits SQL into statements. Comments are stripped; quoted literals and
// identifiers are preserved, including embedded semicolons.
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") index++;
      current += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index++;
      index += 2;
      current += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      let literal = char;
      index++;
      while (index < sql.length) {
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            literal += char + char;
            index += 2;
            continue;
          }
          break;
        }
        literal += sql[index]!;
        index++;
      }
      literal += char;
      index++;
      current += literal;
      continue;
    }
    if (char === "[") {
      const close = sql.indexOf("]", index);
      const end = close === -1 ? sql.length : close + 1;
      current += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      index++;
      continue;
    }
    current += char;
    index++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

// Returns the region between the opening paren at openIndex and its matching
// close paren, respecting quoted regions.
function readBalanced(statement: string, openIndex: number): { body: string; endIndex: number } {
  let depth = 1;
  let index = openIndex + 1;
  while (index < statement.length) {
    const char = statement[index]!;
    if (char === "'" || char === '"' || char === "`") {
      index++;
      while (index < statement.length) {
        if (statement[index] === char) {
          if (statement[index + 1] === char) {
            index += 2;
            continue;
          }
          break;
        }
        index++;
      }
      index++;
      continue;
    }
    if (char === "[") {
      const close = statement.indexOf("]", index);
      index = close === -1 ? statement.length : close + 1;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return { body: statement.slice(openIndex + 1, index), endIndex: index };
    }
    index++;
  }
  throw new Error("unbalanced parentheses");
}

function splitTopLevel(body: string): string[] {
  const entries: string[] = [];
  let current = "";
  let depth = 0;
  let index = 0;
  while (index < body.length) {
    const char = body[index]!;
    if (char === "'" || char === '"' || char === "`") {
      let literal = char;
      index++;
      while (index < body.length) {
        if (body[index] === char) {
          if (body[index + 1] === char) {
            literal += char + char;
            index += 2;
            continue;
          }
          break;
        }
        literal += body[index]!;
        index++;
      }
      literal += char;
      index++;
      current += literal;
      continue;
    }
    if (char === "[") {
      const close = body.indexOf("]", index);
      const end = close === -1 ? body.length : close + 1;
      current += body.slice(index, end);
      index = end;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      entries.push(current);
      current = "";
      index++;
      continue;
    }
    current += char;
    index++;
  }
  if (current.trim()) entries.push(current);
  return entries;
}

function assertUsableName(name: string, kind: string): void {
  if (name.startsWith("_myslop_") || name.startsWith("sqlite_") || name === "d1_migrations") {
    throw new Error(`${kind} name ${name} is reserved`);
  }
}

function parseCreateTable(statement: string): ParsedTable | null {
  const match = statement.match(TABLE_RE);
  if (!match) return null;
  const name = unquote(match[1]!).toLowerCase();
  assertUsableName(name, "table");
  const openIndex = match[0].length - 1;
  let body: string;
  let endIndex: number;
  try {
    ({ body, endIndex } = readBalanced(statement, openIndex));
  } catch {
    throw new Error(`table ${name}: unbalanced parentheses`);
  }
  const suffix = normalize(statement.slice(endIndex + 1));
  const columns = new Map<string, ColumnDef>();
  const constraints: string[] = [];
  for (const entry of splitTopLevel(body)) {
    const trimmed = collapse(entry);
    if (!trimmed) continue;
    const first = trimmed.match(FIRST_TOKEN_RE);
    if (!first) throw new Error(`table ${name}: cannot parse "${trimmed.slice(0, 60)}"`);
    const rawFirst = first[1]!;
    if (/^[A-Za-z_]/.test(rawFirst) && CONSTRAINT_KEYWORDS.has(rawFirst.toUpperCase())) {
      constraints.push(normalize(trimmed));
      continue;
    }
    const columnName = unquote(rawFirst).toLowerCase();
    if (columns.has(columnName)) throw new Error(`table ${name}: duplicate column ${columnName}`);
    columns.set(columnName, { text: trimmed, normalized: normalize(trimmed) });
  }
  if (suffix) constraints.push(`options: ${suffix}`);
  if (!columns.size) throw new Error(`table ${name} declares no columns`);
  return { name, sql: statement, columns, constraints: constraints.sort() };
}

function parseCreateIndex(statement: string): ParsedIndex | null {
  const match = statement.match(INDEX_RE);
  if (!match) return null;
  const name = unquote(match[1]!).toLowerCase();
  assertUsableName(name, "index");
  return { name, sql: statement, normalized: normalize(statement.replace(/\bif\s+not\s+exists\s+/i, "")) };
}

export function parseSchemaSql(sql: string): ParsedSchema {
  const tables = new Map<string, ParsedTable>();
  const indexes = new Map<string, ParsedIndex>();
  for (const statement of splitSqlStatements(sql)) {
    const table = parseCreateTable(statement);
    if (table) {
      if (tables.has(table.name)) throw new Error(`duplicate table in schema.sql: ${table.name}`);
      tables.set(table.name, table);
      continue;
    }
    const index = parseCreateIndex(statement);
    if (index) {
      if (indexes.has(index.name)) throw new Error(`duplicate index in schema.sql: ${index.name}`);
      indexes.set(index.name, index);
      continue;
    }
    throw new Error(
      `unsupported statement in schema.sql: "${collapse(statement).slice(0, 80)}". ` +
      `Only CREATE TABLE and CREATE INDEX are allowed; put other DDL in migrations/.`,
    );
  }
  return { tables, indexes };
}

function ensureCreateTableIfNotExists(sql: string): string {
  return sql.replace(/^(\s*create\s+table\s+)(?!if\s+not\s+exists)/i, "$1IF NOT EXISTS ");
}

function ensureCreateIndexIfNotExists(sql: string): string {
  return sql.replace(/^(\s*create\s+(?:unique\s+)?index\s+)(?!if\s+not\s+exists)/i, "$1IF NOT EXISTS ");
}

export function diffSchema(current: ParsedSchema, desired: ParsedSchema): SchemaDiff {
  const statements: string[] = [];
  const destructive: string[] = [];
  const summary: string[] = [];
  const addColumns: string[] = [];
  for (const [name, table] of desired.tables) {
    const existing = current.tables.get(name);
    if (!existing) {
      statements.push(ensureCreateTableIfNotExists(table.sql));
      summary.push(`create table ${name}`);
      continue;
    }
    if (existing.constraints.join("\n") !== table.constraints.join("\n")) {
      destructive.push(`table ${name}: constraints or table options changed`);
    }
    for (const [columnName, column] of table.columns) {
      const existingColumn = existing.columns.get(columnName);
      if (!existingColumn) {
        if (/\bprimary\s+key\b/i.test(column.text) || /\bunique\b/i.test(column.text)) {
          destructive.push(`column ${name}.${columnName}: PRIMARY KEY or UNIQUE columns cannot be added to an existing table`);
        } else if (/\bnot\s+null\b/i.test(column.text) && !/\bdefault\b/i.test(column.text)) {
          destructive.push(`column ${name}.${columnName}: adding a NOT NULL column requires a DEFAULT`);
        } else {
          addColumns.push(`ALTER TABLE ${quoteIdentifier(name)} ADD COLUMN ${column.text}`);
          summary.push(`add column ${name}.${columnName}`);
        }
        continue;
      }
      if (existingColumn.normalized !== column.normalized) {
        destructive.push(`column ${name}.${columnName}: definition changed`);
      }
    }
    for (const columnName of existing.columns.keys()) {
      if (!table.columns.has(columnName)) destructive.push(`column ${name}.${columnName}: removed`);
    }
  }
  for (const name of current.tables.keys()) {
    if (!desired.tables.has(name)) destructive.push(`table ${name}: removed`);
  }
  statements.push(...addColumns);
  for (const [name, index] of current.indexes) {
    const desiredIndex = desired.indexes.get(name);
    if (!desiredIndex) {
      statements.push(`DROP INDEX IF EXISTS ${quoteIdentifier(name)}`);
      summary.push(`drop index ${name}`);
    } else if (desiredIndex.normalized !== index.normalized) {
      statements.push(`DROP INDEX IF EXISTS ${quoteIdentifier(name)}`, ensureCreateIndexIfNotExists(desiredIndex.sql));
      summary.push(`recreate index ${name}`);
    }
  }
  for (const [name, index] of desired.indexes) {
    if (!current.indexes.has(name)) {
      statements.push(ensureCreateIndexIfNotExists(index.sql));
      summary.push(`create index ${name}`);
    }
  }
  return { statements, destructive, summary };
}
