/** `strings`（mod 42）是类型感知模式：字符串值与表头一律加引号，数值/布尔裸写；
 *  类型分流在 formatCsv 的调用侧完成——进入 escapeCsvField 的都是文本值。 */
export type CsvQuoteMode = "all" | "necessary" | "never" | "strings";

export const DEFAULT_CSV_QUOTE_MODE: CsvQuoteMode = "all";

export function normalizeCsvQuoteMode(value: unknown): CsvQuoteMode {
  return value === "necessary" || value === "never" || value === "strings" ? value : DEFAULT_CSV_QUOTE_MODE;
}

/** 导出对话框一次选定的 CSV 文本格式（分隔符/引号字符/引号模式/表头开关）。 */
export interface CsvTextFormatOptions {
  quoteMode: CsvQuoteMode;
  /** 单字符分隔符；发送到后端时按字符串原样传，Rust 取首字符。 */
  delimiter: string;
  /** 单字符引号字符。 */
  quoteChar: string;
  includeHeader: boolean;
}

export const DEFAULT_CSV_DELIMITER = ",";
export const DEFAULT_CSV_QUOTE_CHAR = '"';

export function csvFieldNeedsQuotes(value: string, delimiter = DEFAULT_CSV_DELIMITER, quoteChar = DEFAULT_CSV_QUOTE_CHAR): boolean {
  return value.includes(quoteChar) || value.includes(delimiter) || value.includes("\r") || value.includes("\n");
}

export function escapeCsvField(value: string, quoteMode: CsvQuoteMode, delimiter = DEFAULT_CSV_DELIMITER, quoteChar = DEFAULT_CSV_QUOTE_CHAR): string {
  if (quoteMode === "never") return value;
  // strings 与 all 同路径：本函数只接收文本值（表头/字符串单元格），数值/布尔的
  // 裸写分流在 formatCsv 里做，与 Rust push_csv_value_formatted 的类型分发对齐。
  if (quoteMode === "necessary" && !csvFieldNeedsQuotes(value, delimiter, quoteChar)) return value;
  return `${quoteChar}${value.split(quoteChar).join(quoteChar + quoteChar)}${quoteChar}`;
}

/** 制表符分隔的导出按惯例落成 .tsv，其余仍是 .csv。 */
export function csvFileExtension(delimiter: string): string {
  return delimiter === "\t" ? "tsv" : "csv";
}
