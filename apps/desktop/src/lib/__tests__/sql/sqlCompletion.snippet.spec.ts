import { describe, it, expect } from "vitest";
import { buildSnippetItemsForTest, buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";
import { DEFAULT_SQL_SNIPPETS, MANTICORESEARCH_SQL_SNIPPETS } from "@/lib/sql/sqlSnippetTemplates";
import type { SqlSnippet } from "@/types/database";

const TEST_SNIPPETS: SqlSnippet[] = [
  { id: "1", label: "select all", prefix: "sel", body: "SELECT *\nFROM my_table;" },
  { id: "2", label: "insert row", prefix: "ins", body: "INSERT INTO my_table VALUES (1);" },
];

const BUILTIN_SELECT: SqlSnippet = { id: "builtin-sel", label: "select *", prefix: "sel", body: "SELECT *\nFROM table\nLIMIT 100;" };
const BUILTIN_CREATE_TABLE: SqlSnippet = { id: "builtin-ct", label: "create table", prefix: "ct", body: "CREATE TABLE table (\n  column type\n);" };
const BUILTIN_UPDATE: SqlSnippet = { id: "builtin-upd", label: "update set", prefix: "upd", body: "UPDATE table\nSET column = value\nWHERE condition;" };
const BUILTIN_CTE: SqlSnippet = { id: "builtin-cte", label: "common table expression", prefix: "cte", body: "WITH name AS (\n  SELECT columns\n  FROM table\n)\nSELECT *\nFROM name;" };
const BUILTIN_INSERT: SqlSnippet = { id: "builtin-ins", label: "insert into", prefix: "ins", body: "INSERT INTO table (columns)\nVALUES (values);" };
const BUILTIN_JOIN: SqlSnippet = { id: "builtin-join", label: "join", prefix: "join", body: "JOIN table ON left_column = right_column" };
const BUILTIN_CASE: SqlSnippet = { id: "builtin-case", label: "case when", prefix: "case", body: "CASE\n  WHEN condition THEN value\n  ELSE default\nEND" };
const BUILTIN_ALTER_TABLE: SqlSnippet = { id: "builtin-at", label: "alter table add column", prefix: "at", body: "ALTER TABLE table\nADD COLUMN column type;" };
const BUILTIN_CREATE_INDEX: SqlSnippet = { id: "builtin-ci", label: "create index", prefix: "ci", body: "CREATE INDEX idx_name\nON table (column);" };

describe("buildSnippetItems", () => {
  it("keeps the global and Manticore-only built-in snippet inventories explicit", () => {
    expect(DEFAULT_SQL_SNIPPETS.map(({ id, prefix }) => [id, prefix])).toEqual([
      ["builtin-sel", "sel"],
      ["builtin-ins", "ins"],
      ["builtin-upd", "upd"],
      ["builtin-cte", "cte"],
      ["builtin-join", "join"],
      ["builtin-case", "case"],
      ["builtin-ct", "ct"],
      ["builtin-ex", "ex"],
      ["builtin-nex", "nex"],
      ["builtin-at", "at"],
      ["builtin-ci", "ci"],
    ]);
    expect(MANTICORESEARCH_SQL_SNIPPETS.map(({ id, prefix }) => [id, prefix])).toEqual([
      ["builtin-manticore-match", "match"],
      ["builtin-manticore-facet", "facet"],
      ["builtin-manticore-show-meta", "m"],
      ["builtin-manticore-show-tables", "tab"],
      ["builtin-manticore-call-pq", "p"],
    ]);
  });

  it("returns matching snippet by prefix", () => {
    const items = buildSnippetItemsForTest("sel", TEST_SNIPPETS);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("select all");
    expect(items[0].detail).toBe("SELECT *\nFROM my_table;");
    expect(items[0].apply).toBe("SELECT *\nFROM my_table;");
  });

  it("keeps a distinct trigger available to CodeMirror filtering", () => {
    const items = buildSnippetItemsForTest("ssf", [{ id: "custom", label: "SELECT *", prefix: "ssf", body: "SELECT * FROM" }]);

    expect(items).toEqual([
      expect.objectContaining({
        label: "SELECT *",
        filterText: "ssf",
        type: "snippet",
      }),
    ]);
  });

  it("uses CodeMirror placeholders for the built-in select snippet", () => {
    const items = buildSnippetItemsForTest("sel", [BUILTIN_SELECT]);

    expect(items[0].detail).toBe("SELECT *\nFROM table\nLIMIT 100;");
    expect(items[0].apply).toBe("SELECT *\nFROM ${table}\nLIMIT 100;");
  });

  it.each([
    ["mysql", "SELECT *\nFROM table\nLIMIT 100;", "SELECT *\nFROM ${table}\nLIMIT 100;"],
    ["oracle", "SELECT *\nFROM table\nWHERE ROWNUM <= 100;", "SELECT *\nFROM ${table}\nWHERE ROWNUM <= 100;"],
    ["oceanbase-oracle", "SELECT *\nFROM table\nWHERE ROWNUM <= 100;", "SELECT *\nFROM ${table}\nWHERE ROWNUM <= 100;"],
    ["oscar", "SELECT *\nFROM table\nWHERE ROWNUM <= 100;", "SELECT *\nFROM ${table}\nWHERE ROWNUM <= 100;"],
    ["xugu", "SELECT *\nFROM table\nLIMIT 100;", "SELECT *\nFROM ${table}\nLIMIT 100;"],
    ["yashandb", "SELECT *\nFROM table\nLIMIT 100;", "SELECT *\nFROM ${table}\nLIMIT 100;"],
    ["dameng", "SELECT *\nFROM table\nWHERE ROWNUM <= 100;", "SELECT *\nFROM ${table}\nWHERE ROWNUM <= 100;"],
    ["db2", "SELECT *\nFROM table\nFETCH FIRST 100 ROWS ONLY;", "SELECT *\nFROM ${table}\nFETCH FIRST 100 ROWS ONLY;"],
    ["sqlserver", "SELECT TOP 100 *\nFROM table;", "SELECT TOP 100 *\nFROM ${table};"],
    ["access", "SELECT TOP 100 *\nFROM table;", "SELECT TOP 100 *\nFROM ${table};"],
    ["iris", "SELECT TOP 100 *\nFROM table;", "SELECT TOP 100 *\nFROM ${table};"],
    ["teradata", "SELECT TOP 100 *\nFROM table;", "SELECT TOP 100 *\nFROM ${table};"],
    ["informix", "SELECT FIRST 100 *\nFROM table;", "SELECT FIRST 100 *\nFROM ${table};"],
    ["firebird", "SELECT *\nFROM table\nROWS 100;", "SELECT *\nFROM ${table}\nROWS 100;"],
    ["jdbc", "SELECT *\nFROM table;", "SELECT *\nFROM ${table};"],
  ] as const)("uses the %s row limit syntax in the built-in select snippet", (databaseType, detail, apply) => {
    const items = buildSnippetItemsForTest("sel", [BUILTIN_SELECT], undefined, databaseType);

    expect(items[0].detail).toBe(detail);
    expect(items[0].apply).toBe(apply);
  });

  it("passes the active database type through the SQL completion provider", () => {
    const items = buildSqlCompletionItems("sel", 3, {
      tables: [],
      columnsByTable: new Map(),
      databaseType: "oracle",
    });

    const snippet = items.find((item) => item.type === "snippet" && item.label === "select *");
    expect(snippet?.detail).toBe("SELECT *\nFROM table\nWHERE ROWNUM <= 100;");
    expect(snippet?.apply).toBe("SELECT *\nFROM ${table}\nWHERE ROWNUM <= 100;");
  });

  it("ranks an exact snippet prefix ahead of an exact function name", () => {
    const items = buildSqlCompletionItems("sf", 2, {
      databaseType: "oracle",
      snippets: [{ id: "custom-sf", label: "select * from table", prefix: "sf", body: "SELECT *\nFROM table;" }],
      objects: [{ name: "SF", type: "function" }],
      tables: [],
      columnsByTable: new Map(),
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "select * from table", type: "snippet", exactMatch: true }));
    expect(items.findIndex((item) => item.label === "SF" && item.type === "function")).toBeGreaterThan(0);
  });

  it("ranks an exact snippet prefix ahead of an exact keyword", () => {
    const items = buildSqlCompletionItems("select", 6, {
      snippets: [{ id: "custom-select", label: "select all rows", prefix: "select", body: "SELECT *\nFROM table;" }],
      tables: [],
      columnsByTable: new Map(),
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "select all rows", type: "snippet", exactMatch: true }));
    expect(items.findIndex((item) => item.label === "SELECT" && item.type === "keyword")).toBeGreaterThan(0);
  });

  it("ranks an exactly typed table name ahead of a snippet with the same trigger", () => {
    const sql = "SELECT * FROM orders";
    const items = buildSqlCompletionItems(sql, sql.length, {
      snippets: [{ id: "custom-orders", label: "orders template", prefix: "orders", body: "SELECT *\nFROM orders;" }],
      tables: [{ name: "orders", type: "table" }],
      columnsByTable: new Map(),
      databaseType: "mysql",
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "orders", type: "table", exactMatch: true }));
    const snippet = items.find((item) => item.type === "snippet" && item.label === "orders template");
    expect(snippet).toBeDefined();
    expect(snippet?.exactMatch).toBeFalsy();
    expect(items.indexOf(snippet!)).toBeGreaterThan(0);
  });

  it("ranks a prefix-matching table ahead of a partially typed snippet prefix", () => {
    // Typing "us" toward the users table must not land on a snippet whose
    // trigger merely starts with the same letters (accidental snippet inserts).
    const sql = "SELECT * FROM us";
    const items = buildSqlCompletionItems(sql, sql.length, {
      snippets: [{ id: "custom-usr", label: "users export", prefix: "usr", body: "SELECT *\nFROM users;" }],
      tables: [{ name: "users", type: "table" }],
      columnsByTable: new Map(),
      databaseType: "mysql",
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "users", type: "table" }));
    const snippet = items.find((item) => item.type === "snippet" && item.label === "users export");
    expect(snippet).toBeDefined();
    expect(items.indexOf(snippet!)).toBeGreaterThan(0);
  });

  it("ranks a matching column ahead of a partially typed snippet prefix", () => {
    const sql = "SELECT * FROM users WHERE cust";
    const items = buildSqlCompletionItems(sql, sql.length, {
      snippets: [{ id: "custom-cust", label: "customer lookup", prefix: "cu", body: "customer_id = 1" }],
      tables: [{ name: "users", type: "table" }],
      columnsByTable: new Map([["users", [{ name: "customer_id", table: "users" }]]]),
      databaseType: "mysql",
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "customer_id", type: "column" }));
    const snippet = items.find((item) => item.type === "snippet" && item.label === "customer lookup");
    expect(snippet).toBeDefined();
    expect(items.indexOf(snippet!)).toBeGreaterThan(0);
  });

  it("ranks an exactly typed column name ahead of a snippet with the same trigger", () => {
    const sql = "SELECT * FROM users WHERE uid";
    const items = buildSqlCompletionItems(sql, sql.length, {
      snippets: [{ id: "custom-uid", label: "uid lookup", prefix: "uid", body: "uid = 1" }],
      tables: [{ name: "users", type: "table" }],
      columnsByTable: new Map([["users", [{ name: "uid", table: "users" }]]]),
      databaseType: "mysql",
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "uid", type: "column", exactMatch: true }));
    const snippet = items.find((item) => item.type === "snippet" && item.label === "uid lookup");
    expect(snippet).toBeDefined();
    expect(snippet?.exactMatch).toBeFalsy();
    expect(items.indexOf(snippet!)).toBeGreaterThan(0);
  });

  it("still ranks an exact snippet trigger first when no identifier collides with it", () => {
    const sql = "SELECT * FROM ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      snippets: [{ id: "custom-ord", label: "orders export", prefix: "ord", body: "SELECT *\nFROM orders;" }],
      tables: [{ name: "orders", type: "table" }],
      columnsByTable: new Map(),
      databaseType: "mysql",
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "orders export", type: "snippet", exactMatch: true }));
    expect(items.findIndex((item) => item.label === "orders" && item.type === "table")).toBeGreaterThan(0);
  });

  it("keeps an exact custom snippet first when matching columns are preferred", () => {
    const sql = "SELECT * FROM users WHERE cc";
    const items = buildSqlCompletionItems(sql, sql.length, {
      snippets: [{ id: "custom-count", label: "count zero", prefix: "cc", body: "count(0)" }],
      tables: [{ name: "users", type: "table" }],
      columnsByTable: new Map([["users", [{ name: "country_code", table: "users" }]]]),
      databaseType: "mysql",
    });

    expect(items[0]).toEqual(
      expect.objectContaining({
        label: "count zero",
        filterText: "cc",
        type: "snippet",
        apply: "count(0)",
        exactMatch: true,
      }),
    );
  });

  it("keeps an exact custom snippet ahead of an exact table alias", () => {
    const sql = "SELECT * FROM country_codes cc WHERE cc";
    const items = buildSqlCompletionItems(sql, sql.length, {
      snippets: [{ id: "custom-count", label: "count zero", prefix: "cc", body: "count(0)" }],
      tables: [{ name: "country_codes", type: "table" }],
      columnsByTable: new Map(),
      databaseType: "mysql",
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "count zero", type: "snippet", exactMatch: true }));
  });

  it("offers custom snippets in preferred SQL value contexts", () => {
    const sql = "SELECT DATEADD(cc";
    const items = buildSqlCompletionItems(sql, sql.length, {
      snippets: [{ id: "custom-count", label: "count zero", prefix: "cc", body: "count(0)" }],
      tables: [],
      columnsByTable: new Map(),
      databaseType: "sqlserver",
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "count zero", type: "snippet", apply: "count(0)", exactMatch: true }));
  });

  it("keeps an exact database routine ahead of its generic function", () => {
    const sql = "SELECT COUNT";
    const items = buildSqlCompletionItems(sql, sql.length, {
      objects: [{ name: "COUNT", type: "function", signature: "value" }],
      tables: [],
      columnsByTable: new Map(),
      databaseType: "mysql",
    });

    expect(items.find((item) => item.label === "COUNT")?.apply).toBe("`COUNT`(${1:value})");
  });

  it("keeps the real keyword first after typing past a snippet prefix", () => {
    const items = buildSqlCompletionItems("sele", 4, {
      snippets: [{ id: "custom-sel", label: "select all rows", prefix: "sel", body: "SELECT *\nFROM table;" }],
      tables: [],
      columnsByTable: new Map(),
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "SELECT", type: "keyword" }));
    expect(items.find((item) => item.label === "select all rows" && item.type === "snippet")?.exactMatch).not.toBe(true);
  });

  it("preserves a customized built-in select body instead of replacing it with a dialect default", () => {
    const customized = { ...BUILTIN_SELECT, body: "SELECT *\nFROM table\nLIMIT 7;" };
    const items = buildSnippetItemsForTest("sel", [customized], undefined, "oracle");

    expect(items[0].detail).toBe("SELECT *\nFROM table\nLIMIT 7;");
    expect(items[0].apply).toBe("SELECT *\nFROM ${table}\nLIMIT 7;");
  });

  it("replaces placeholder words but preserves uppercase SQL keywords", () => {
    const items = buildSnippetItemsForTest("ct", [BUILTIN_CREATE_TABLE]);

    expect(items[0].apply).toBe("CREATE TABLE ${table} (\n  ${column} ${type}\n);");
  });

  it("adds placeholders across built-in update snippets", () => {
    const items = buildSnippetItemsForTest("upd", [BUILTIN_UPDATE]);

    expect(items[0].apply).toBe("UPDATE ${table}\nSET ${column} = ${value}\nWHERE ${condition};");
  });

  it("uses ALTER TABLE UPDATE for ClickHouse", () => {
    const items = buildSnippetItemsForTest("upd", [BUILTIN_UPDATE], undefined, "clickhouse");

    expect(items[0].detail).toBe("ALTER TABLE table\nUPDATE column = value\nWHERE condition;");
    expect(items[0].apply).toBe("ALTER TABLE ${table}\nUPDATE ${column} = ${value}\nWHERE ${condition};");
  });

  it.each([
    ["mysql", "ALTER TABLE table\nADD COLUMN column type;", "ALTER TABLE ${table}\nADD COLUMN ${column} ${type};"],
    ["oracle", "ALTER TABLE table\nADD (column type);", "ALTER TABLE ${table}\nADD (${column} ${type});"],
    ["oceanbase-oracle", "ALTER TABLE table\nADD (column type);", "ALTER TABLE ${table}\nADD (${column} ${type});"],
    ["oscar", "ALTER TABLE table\nADD COLUMN column type;", "ALTER TABLE ${table}\nADD COLUMN ${column} ${type};"],
    ["yashandb", "ALTER TABLE table\nADD (column type);", "ALTER TABLE ${table}\nADD (${column} ${type});"],
    ["xugu", "ALTER TABLE table\nADD (column type);", "ALTER TABLE ${table}\nADD (${column} ${type});"],
    ["dameng", "ALTER TABLE table\nADD (column type);", "ALTER TABLE ${table}\nADD (${column} ${type});"],
    ["iris", "ALTER TABLE table\nADD (column type);", "ALTER TABLE ${table}\nADD (${column} ${type});"],
    ["informix", "ALTER TABLE table\nADD (column type);", "ALTER TABLE ${table}\nADD (${column} ${type});"],
    ["sqlserver", "ALTER TABLE table\nADD column type;", "ALTER TABLE ${table}\nADD ${column} ${type};"],
    ["kingbase", "ALTER TABLE table\nADD column type;", "ALTER TABLE ${table}\nADD ${column} ${type};"],
    ["cassandra", "ALTER TABLE table\nADD column type;", "ALTER TABLE ${table}\nADD ${column} ${type};"],
    ["teradata", "ALTER TABLE table\nADD column type;", "ALTER TABLE ${table}\nADD ${column} ${type};"],
  ] as const)("uses the %s ADD COLUMN syntax in the built-in alter-table snippet", (databaseType, detail, apply) => {
    const items = buildSnippetItemsForTest("at", [BUILTIN_ALTER_TABLE], undefined, databaseType);

    expect(items[0].detail).toBe(detail);
    expect(items[0].apply).toBe(apply);
  });

  it("keeps keyword casing separate from editable placeholders", () => {
    const items = buildSnippetItemsForTest("sel", [BUILTIN_SELECT], "lower");

    expect(items[0].detail).toBe("select *\nfrom table\nlimit 100;");
    expect(items[0].apply).toBe("select *\nfrom ${table}\nlimit 100;");
  });

  it("determines placeholders from original casing even when keywords are lowercased", () => {
    const items = buildSnippetItemsForTest("ct", [BUILTIN_CREATE_TABLE], "lower");

    expect(items[0].detail).toBe("create table table (\n  column type\n);");
    expect(items[0].apply).toBe("create table ${table} (\n  ${column} ${type}\n);");
  });

  it("wraps repeated placeholder words in CTE snippets", () => {
    const items = buildSnippetItemsForTest("cte", [BUILTIN_CTE]);

    expect(items[0].apply).toBe("WITH ${name} AS (\n  SELECT ${columns}\n  FROM ${table}\n)\nSELECT *\nFROM ${name};");
  });

  it.each([
    [BUILTIN_INSERT, "INSERT INTO ${table} (${columns})\nVALUES (${values});"],
    [BUILTIN_JOIN, "JOIN ${table} ON ${left_column} = ${right_column}"],
    [BUILTIN_CASE, "CASE\n  WHEN ${condition} THEN ${value}\n  ELSE ${default}\nEND"],
    [BUILTIN_CREATE_INDEX, "CREATE INDEX ${idx_name}\nON ${table} (${column});"],
  ])("adds placeholders for built-in %s snippet", (snippet, expectedApply) => {
    const items = buildSnippetItemsForTest(snippet.prefix, [snippet]);

    expect(items[0].apply).toBe(expectedApply);
  });

  it("returns matching snippet by label substring", () => {
    const items = buildSnippetItemsForTest("select", TEST_SNIPPETS);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("select all");
  });

  it("does not return disabled snippets", () => {
    const items = buildSnippetItemsForTest("sel", [{ ...TEST_SNIPPETS[0], enabled: false }, TEST_SNIPPETS[1]]);
    expect(items).toEqual([]);
  });

  it("does not keep matching a renamed snippet by its old short label prefix", () => {
    const items = buildSnippetItemsForTest("sel", [{ id: "1", label: "select all", prefix: "fff", body: "SELECT *\nFROM my_table;" }]);
    expect(items).toEqual([]);
  });

  it("still matches a renamed snippet by label when typing a longer descriptive query", () => {
    const items = buildSnippetItemsForTest("select", [{ id: "1", label: "select all", prefix: "fff", body: "SELECT *\nFROM my_table;" }]);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("select all");
  });

  // A completion prefix cannot contain spaces, so a spaced trigger/label must
  // also match its whitespace-free spelling, and the CodeMirror-facing
  // filterText must be a word the user can actually type.
  const SPACED_TRIGGER_SNIPPET: SqlSnippet = { id: "spaced", label: "S item", prefix: "S item", body: "SELECT * FROM ${table};" };

  it("matches a space-containing trigger by its space-free spelling", () => {
    const items = buildSnippetItemsForTest("sitem", [SPACED_TRIGGER_SNIPPET]);

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        label: "S item",
        filterText: "Sitem",
        type: "snippet",
        exactMatch: true,
      }),
    );
  });

  it("still surfaces a space-containing trigger from its first letter", () => {
    const items = buildSnippetItemsForTest("s", [SPACED_TRIGGER_SNIPPET]);

    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("S item");
    expect(items[0].filterText).toBe("Sitem");
  });

  it("matches a spaced label's compact spelling but keeps a space-free trigger as filterText", () => {
    const items = buildSnippetItemsForTest("sitem", [{ id: "spaced-label", label: "S item", prefix: "si", body: "SELECT 1;" }]);

    expect(items).toHaveLength(1);
    expect(items[0].filterText).toBe("si");
  });

  it("keeps space-free snippet triggers unchanged", () => {
    const items = buildSnippetItemsForTest("scgb", [{ id: "plain", label: "scgb", prefix: "scgb", body: "select count(*) from ${table} group by ${column};" }]);

    expect(items).toHaveLength(1);
    expect(items[0].filterText).toBe("scgb");
  });

  it("ranks an exactly typed space-free spelling ahead of keywords", () => {
    const sql = "SELECT * FROM sitem";
    const items = buildSqlCompletionItems(sql, sql.length, {
      snippets: [SPACED_TRIGGER_SNIPPET],
      tables: [{ name: "other", type: "table" }],
      columnsByTable: new Map(),
      databaseType: "mysql",
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "S item", type: "snippet", exactMatch: true }));
  });

  it("ranks an exactly typed table name ahead of a snippet whose trigger only matches without spaces", () => {
    const sql = "SELECT * FROM orders";
    const items = buildSqlCompletionItems(sql, sql.length, {
      snippets: [{ id: "custom-orders", label: "orders export", prefix: "ord ers", body: "SELECT *\nFROM orders;" }],
      tables: [{ name: "orders", type: "table" }],
      columnsByTable: new Map(),
      databaseType: "mysql",
    });

    expect(items[0]).toEqual(expect.objectContaining({ label: "orders", type: "table", exactMatch: true }));
    const snippet = items.find((item) => item.type === "snippet" && item.label === "orders export");
    expect(snippet).toBeDefined();
    expect(snippet?.exactMatch).toBeFalsy();
    expect(items.indexOf(snippet!)).toBeGreaterThan(0);
  });

  it("returns empty for no match", () => {
    const items = buildSnippetItemsForTest("zzz", TEST_SNIPPETS);
    expect(items).toEqual([]);
  });

  it("returns empty for empty prefix", () => {
    const items = buildSnippetItemsForTest("", TEST_SNIPPETS);
    expect(items).toEqual([]);
  });

  it("renumbers a VSCode-style $0 final cursor past the last tabstop", () => {
    const items = buildSnippetItemsForTest("ssf", [{ id: "1", label: "select", prefix: "ssf", body: "SELECT *\nFROM ${1:table}\nWHERE $0" }]);

    // CodeMirror has no $0: it is renumbered to max tabstop + 1 so Tab walks
    // ${1} and then lands on the $0 position as the final field.
    expect(items[0].apply).toBe("SELECT *\nFROM ${1:table}\nWHERE ${2}");
    // The completion detail keeps showing the body as typed.
    expect(items[0].detail).toBe("SELECT *\nFROM ${1:table}\nWHERE $0");
  });

  it("keeps $0 as the only field when the snippet has no other tabstops", () => {
    const items = buildSnippetItemsForTest("ssf", [{ id: "1", label: "select", prefix: "ssf", body: "SELECT * FROM $0;" }]);

    expect(items[0].apply).toBe("SELECT * FROM ${1};");
  });

  it.each([
    ["${0}", "SELECT * FROM ${1:table} ${2};"],
    ["${0:value}", "SELECT * FROM ${1:table} ${2:value};"],
  ] as const)("renumbers the braced %s final cursor form", (cursor, expected) => {
    const items = buildSnippetItemsForTest("ssf", [{ id: "1", label: "select", prefix: "ssf", body: `SELECT * FROM \${1:table} ${cursor};` }]);

    expect(items[0].apply).toBe(expected);
  });

  it("mirrors repeated $0 positions into one final field", () => {
    const items = buildSnippetItemsForTest("jf", [{ id: "1", label: "join", prefix: "jf", body: "$0 JOIN $0" }]);

    expect(items[0].apply).toBe("${1} JOIN ${1}");
  });

  it("keeps escaped and PostgreSQL bind-parameter dollars literal", () => {
    const items = buildSnippetItemsForTest("pf", [{ id: "1", label: "prepared", prefix: "pf", body: "EXECUTE stmt($1, $2) -- \\$0 stays" }]);

    // $1/$2 are valid PostgreSQL bind parameters, not tabstops; \$0 is escaped.
    expect(items[0].apply).toBe("EXECUTE stmt($1, $2) -- \\$0 stays");
  });
});
