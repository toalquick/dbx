import type { DatabaseType, QueryResult } from "@/types/database";
import * as api from "@/lib/backend/api";
import { escapeCsvField, type CsvQuoteMode, type CsvTextFormatOptions } from "@/lib/export/csvQuoteMode";
import { DEFAULT_CSV_NULL_LITERAL } from "@/lib/export/csvNullMode";
import type { SqlInsertDialect, SqlInsertMode } from "@/lib/export/sqlInsertMode";

export type ExportCellValue = string | number | boolean | null;

/**
 * The third argument accepts both the export dialog's full options object and
 * the bare quote-mode string callers pass elsewhere in the codebase; with a
 * bare mode the fourth argument carries the NULL literal (upstream callers).
 * The NULL literal defaults to `\N` — NULL and the empty string stay
 * distinguishable, matching the Rust formatter's request default.
 */
export function formatCsv(columns: string[], rows: ExportCellValue[][], options: Partial<CsvTextFormatOptions & { nullLiteral?: string }> | CsvQuoteMode = {}, nullLiteralArg?: string): string {
  const { quoteMode = "all", delimiter = ",", quoteChar = '"', includeHeader = true, nullLiteral } = typeof options === "string" ? { quoteMode: options, nullLiteral: nullLiteralArg } : options;
  const literal = nullLiteral ?? nullLiteralArg ?? DEFAULT_CSV_NULL_LITERAL;
  const header = columns.map((column) => escapeCsvField(column, quoteMode, delimiter, quoteChar)).join(delimiter);
  // NULL 写成独立字面量、空字符串写成空字段，否则导入端无法把两者区分开
  // （写回 NOT NULL DEFAULT '' 的列时会把空字符串还原成 NULL）。
  //
  // 字面量裸写：PostgreSQL 的 COPY ... FORMAT csv 不认带引号的 NULL（`"\N"` 是普通字符串，
  // 整数列直接报错），ClickHouse 的 CSV 读取在引号内遇到 `\N` 会解析失败；只有裸 `\N` 是
  // 它们与 MySQL 共同识别的 NULL。字面量自身含分隔符/引号/换行时才加引号。
  const nullField = literal ? escapeCsvField(literal, "necessary", delimiter, quoteChar) : "";
  const body = rows
    .map((row) =>
      row
        .map((cell) => {
          if (cell === null) return nullField;
          // strings（mod 42）按单元格原始类型分流：字符串加引号（escapeCsvField 把
          // strings 当 all 处理），数值/布尔裸写——与 Rust push_csv_value_formatted 的
          // Value 分发对齐；NULL 字面量沿用 necessary，裸 `\N` 才能被回读端识别。
          if (quoteMode === "strings" && typeof cell !== "string") return String(cell);
          return escapeCsvField(String(cell), quoteMode, delimiter, quoteChar);
        })
        .join(delimiter),
    )
    .join("\n");
  return includeHeader ? `${header}\n${body}` : body;
}

// Tab-separated values with a header row, mirroring Navicat's "Text File (*.txt)"
// export: fields are joined by a tab and NULL becomes the null literal. A field
// is wrapped in double quotes only when it contains a tab or a line break - the
// characters that would otherwise corrupt the TSV row/column shape. A field that
// merely contains a double quote is emitted verbatim: TSV is parsed by splitting
// on the tab alone (there is no quote state machine on paste-back), so quoting
// such a value would corrupt it (e.g. a value of `"abc"` must not become `"""abc"""`).
export function formatTsv(columns: string[], rows: ExportCellValue[][], nullLiteral: string = DEFAULT_CSV_NULL_LITERAL): string {
  const esc = (value: ExportCellValue) => {
    // 与 CSV 一致：NULL 写字面量、空字符串写空字段，导出→导入才能无损往返
    const text = value === null ? nullLiteral || "" : String(value);
    if (text.includes("\t") || text.includes("\n") || text.includes("\r")) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  const header = columns.map(esc).join("\t");
  const body = rows.map((row) => row.map(esc).join("\t")).join("\n");
  return `${header}\n${body}`;
}

export interface FormatSqlInsertOptions {
  databaseType?: DatabaseType;
  identifierQuote?: string;
  schema?: string;
  tableName?: string;
  qualifiedTableName?: string;
  columns: string[];
  columnTypes?: Array<string | null | undefined>;
  /** 与 `columns` 对齐的列 EXTRA 元数据，用于 identity 列的 `SET IDENTITY_INSERT` 包裹。 */
  columnExtras?: Array<string | null | undefined>;
  spatialColumns?: QueryResult["spatial_columns"];
  spatialValues?: QueryResult["spatial_values"];
  rows: ExportCellValue[][];
  insertMode?: SqlInsertMode;
  insertDialect?: SqlInsertDialect;
  excludeColumns?: string[];
}

export function formatSqlInsert({ insertMode = "batch", ...options }: FormatSqlInsertOptions): Promise<string> {
  return api.buildExportSqlInsert({
    ...options,
    batchSize: insertMode === "single" ? 1 : undefined,
  });
}
