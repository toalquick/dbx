use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::io::Write;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvQuoteMode {
    #[default]
    All,
    Necessary,
    Never,
    /// 类型感知引号（mod 42）：字符串值一律加引号，数值/布尔裸写。
    /// 到达 [`push_csv_field_with_format`] 的都是文本（表头、字符串单元格、
    /// JSON 化的对象/数组），与 [`CsvQuoteMode::All`] 同路径；数值/布尔在
    /// [`push_csv_value_formatted`] 的类型分发里根本不会走到这里。
    Strings,
}

/// CSV 里 NULL 的默认字面量（`\N`，MySQL `SELECT ... INTO OUTFILE` 惯例）。
///
/// 默认值必须同时被导出与导入两侧引用：导出写出该字面量、导入按该字面量还原 NULL，
/// 空字符串则始终写成 `""`，这样「空字符串」与「NULL」在 CSV 中不再互相冒充。
pub const DEFAULT_CSV_NULL_LITERAL: &str = "\\N";

/// 把导出/导入配置里的原始字面量解析成实际生效的值：空串表示「不写 NULL 标记」，
/// 即沿用历史行为（NULL 写成空字段，无法与空字符串区分）。
pub fn csv_null_literal(raw: &str) -> Option<&str> {
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

/// 导出/导入配置里 NULL 字面量的 serde 默认值：未显式配置时用 [`DEFAULT_CSV_NULL_LITERAL`]。
pub fn default_csv_null_literal() -> String {
    DEFAULT_CSV_NULL_LITERAL.to_string()
}

/// 分隔符 + 引号模式 + 引号字符 + 表头开关 + NULL 字面量：导出对话框/设置一次选定后
/// 随请求下发，格式化函数按它写单元格。`Default` 保持旧语义（逗号 + `"` + 全部加引号 +
/// 含表头 + NULL 写空字段），legacy `_with_quote_mode` 系列委托到这里的默认变体。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsvTextFormat {
    pub quote_mode: CsvQuoteMode,
    pub delimiter: char,
    pub quote_char: char,
    pub include_header: bool,
    /// CSV/TSV 里 NULL 写成什么；`None` 表示不写 NULL 标记（NULL 与空字符串同为空字段）。
    pub null_literal: Option<String>,
}

impl Default for CsvTextFormat {
    fn default() -> Self {
        Self {
            quote_mode: CsvQuoteMode::All,
            delimiter: ',',
            quote_char: '"',
            include_header: true,
            null_literal: None,
        }
    }
}

impl From<CsvQuoteMode> for CsvTextFormat {
    fn from(quote_mode: CsvQuoteMode) -> Self {
        Self { quote_mode, ..Default::default() }
    }
}

/// 请求里的分隔符是字符串（serde 兼容旧前端缺省）；取首字符，空串回退逗号。
pub fn resolve_csv_delimiter(value: &str) -> char {
    value.chars().next().unwrap_or(',')
}

/// 请求里的引号字符同样是字符串；取首字符，空串回退 `"`。
pub fn resolve_csv_quote_char(value: &str) -> char {
    value.chars().next().unwrap_or('"')
}

/// Excel/Sheets 公式注入中和（OWASP CSV Injection 触发字符）：以 `=`、`+`、`-`、
/// `@`、Tab、CR 开头的文本在导出时前置 `'`，避免 `=WEBSERVICE(...)` 类值被电子
/// 表格应用按公式执行（数据外泄）。DataGrip 导出 CSV 时采用同一惯例。
/// 数值列不受影响（Number 分支不走文本路径）。
///
/// `@` 只在后面跟着 ASCII 记号时才触发（见 [`at_sign_begins_excel_formula`]）：
/// `@冯十二` 这类 `@` + 非 ASCII 文本没有可执行的公式面，加 `'` 只会污染内容。
///
/// 前缀的写入/剥离必须保持每单元格一次的对称对：[`push_formula_guard`] 与
/// [`strip_formula_guard`]。guard 绝不能放进 [`push_csv_escaped_content`] 这类
/// 片段级写入路径——serde_json 的 `Display` 会把对象/数组拆成多个片段经
/// `CsvEscapedWriter` 逐段写入，片段级 guard 会在 JSON 单元格中间插 `'`。
const FORMULA_TRIGGER_BYTES: &[u8] = b"=+-@\t\r";

/// Excel 数值列可保留的有效十进制数字位数上限：超过即被折成浮点丢失尾数。
const EXCEL_SIGNIFICANT_DIGIT_LIMIT: usize = 15;

/// 文本是否需要公式中和：跳过前导空格（OWASP 标注的 `" =cmd"` 前导空白绕过）
/// 后，首字节是触发字符即命中；例外有两个：
/// - `-` 开头且**整串**构成 Excel 可无损解析的十进制字面量（见
///   [`is_excel_exact_decimal_literal`]）；
/// - `@` 开头但后面不是 ASCII 记号，在 Excel 里没有可求值的表达式（见
///   [`at_sign_begins_excel_formula`]）。
pub fn needs_formula_guard(value: &str) -> bool {
    let rest = value.trim_start_matches(' ');
    match rest.as_bytes().first() {
        Some(b'-') if is_excel_exact_decimal_literal(&rest[1..]) => false,
        Some(b'@') if !at_sign_begins_excel_formula(&rest[1..]) => false,
        Some(byte) if FORMULA_TRIGGER_BYTES.contains(byte) => true,
        _ => false,
    }
}

/// `@` 之后是否还有 ASCII 记号：Excel 的 `@`（AppleWorks 兼容触发符，现代 Excel
/// 里是隐式交集运算符）要绑定到 ASCII 的函数名、单元格引用、数字或运算符才构成
/// 可求值的表达式——`=@WEBSERVICE("https://evil")` 会真的发起请求，`@SUM(1)`、
/// `@A1` 也都会求值，这些值必须继续中和。
///
/// 反过来，`@` 后直接跟非 ASCII 文本（Oracle 里 `@冯十二` 这类 `@` 开头的文本很
/// 常见）或 `@` 后字符串就结束时，`@` 没有可绑定的记号，Excel 最多落到 `#NAME?`，
/// 不存在公式执行面；此时前置 `'` 只会污染导出文件和复制内容，而不提供任何防护。
fn at_sign_begins_excel_formula(rest: &str) -> bool {
    rest.as_bytes().first().is_some_and(u8::is_ascii)
}

/// 整串是否为 Excel 能原样保留的十进制字面量：`[+-]? 数字 [. 数字]`（无指数
/// 记法、无千分位、无空白），有效数字不超过 15 位。
///
/// 驱动为保精度把 DECIMAL/NUMERIC/BIGINT 以文本下发（PostgreSQL numeric、
/// MySQL DECIMAL/BIGINT 都返回字符串），负值因此以 `-` 开头命中触发符；这类
/// 整串数值在电子表格里只会被解析成数字，不构成公式执行面，加 `'` 反而污染
/// 复制内容（`-1` 变 `'-1`）。公式注入载荷（`-2+1+cmd|…`）因无法整串解析成
/// 数字仍被中和。超过 15 位有效数字的（i64::MIN 一类大整数）不豁免：Excel
/// 会把它折成浮点丢尾数，守卫维持文本语义才是无损的。
///
/// 仅 `-` 号豁免：`+` 开头的数字是电话号码等标识文本的常见形态（`+86138…`），
/// Excel 会把它当数值吞掉前导加号与尾部精度，守卫保留文本。
fn is_excel_exact_decimal_literal(value: &str) -> bool {
    let bytes = value.as_bytes();
    let digits = if matches!(bytes.first(), Some(b'+') | Some(b'-')) { &bytes[1..] } else { bytes };
    let valid_digits = |part: &[u8]| !part.is_empty() && part.iter().all(u8::is_ascii_digit);
    let valid = match digits.iter().position(|&byte| byte == b'.') {
        Some(dot) => valid_digits(&digits[..dot]) && valid_digits(&digits[dot + 1..]),
        None => valid_digits(digits),
    };
    // Count the whole decimal together: fractional zeros are significant once
    // the first nonzero digit has appeared in either part.
    valid
        && digits.iter().filter(|&&byte| byte != b'.').skip_while(|&&byte| byte == b'0').count()
            <= EXCEL_SIGNIFICANT_DIGIT_LIMIT
}

/// 在单元格值开头写入公式中和前缀，每单元格调用一次：
/// - 命中 [`needs_formula_guard`] 的文本前置 `'`；
/// - 以 `'` 开头且其后仍需中和（或本身以 `''` 开头）的文本前置一个额外 `'`
///   转义字面撇号，使 [`strip_formula_guard`] 的剥离成为无歧义逆操作——
///   用户字面数据 `'+8613800000000` 导出为 `''+86…`、回导无损。
pub fn push_formula_guard(out: &mut String, value: &str) {
    if value.as_bytes().first() == Some(&b'\'') {
        if value.as_bytes().get(1) == Some(&b'\'') || needs_formula_guard(&value[1..]) {
            out.push('\'');
        }
    } else if needs_formula_guard(value) {
        out.push('\'');
    }
}

/// [`push_formula_guard`] 的逆操作：单元格以 `'` 开头且其后命中中和条件（字面
/// 撇号转义的 `''`，或 `'<触发字符>` / `' <触发字符>` 守卫）时剥掉一个 `'`，
/// 否则原样返回——单独的 `'` 是用户数据，不动。
pub fn strip_formula_guard(value: &str) -> &str {
    let guarded = value.as_bytes().first() == Some(&b'\'')
        && (value.as_bytes().get(1) == Some(&b'\'') || needs_formula_guard(&value[1..]));
    if guarded {
        &value[1..]
    } else {
        value
    }
}

/// CSV 转义直写目标 buffer：包引号 + 内部引号字符翻倍。值不含引号字符时整段拷贝，
/// 不做 replace 分配（逐批流式导出对每个单元格调用，是导出热路径）。
/// 这里是纯转义原语，不含公式中和——guard 属于单元格级语义（见 [`push_formula_guard`]）。
fn push_csv_escaped_content(out: &mut String, value: &str, quote_char: char) {
    let mut rest = value;
    while let Some(pos) = rest.find(quote_char) {
        out.push_str(&rest[..=pos]);
        out.push(quote_char);
        rest = &rest[pos + quote_char.len_utf8()..];
    }
    out.push_str(rest);
}

pub fn push_csv_escaped(out: &mut String, value: &str) {
    push_csv_escaped_with_quote(out, value, '"');
}

pub fn push_csv_escaped_with_quote(out: &mut String, value: &str, quote_char: char) {
    out.push(quote_char);
    push_csv_escaped_content(out, value, quote_char);
    out.push(quote_char);
}

fn csv_field_needs_quotes(value: &str, delimiter: char, quote_char: char) -> bool {
    value.chars().any(|ch| matches!(ch, '\n' | '\r') || ch == delimiter || ch == quote_char)
}

pub fn push_csv_field(out: &mut String, value: &str, quote_mode: CsvQuoteMode) {
    push_csv_field_with_format(out, value, &CsvTextFormat::from(quote_mode));
}

pub fn push_csv_field_with_format(out: &mut String, value: &str, format: &CsvTextFormat) {
    match format.quote_mode {
        // 守卫前缀写在引号内：`"'-total"` 是合法的带引号字段，`'"-total"'` 不是
        // Strings（mod 42）与 All 同路径：进入这里的值都是文本，一律加引号；
        // 数值/布尔裸写的分流在 push_csv_value_formatted 的类型分发里。
        CsvQuoteMode::All | CsvQuoteMode::Strings => {
            out.push(format.quote_char);
            push_formula_guard(out, value);
            push_csv_escaped_content(out, value, format.quote_char);
            out.push(format.quote_char);
        }
        // Never 显式不加引号（即使值含分隔符/引号/换行，由用户自担）；
        // Necessary 只在破坏字段结构时加引号。
        CsvQuoteMode::Necessary if csv_field_needs_quotes(value, format.delimiter, format.quote_char) => {
            out.push(format.quote_char);
            push_formula_guard(out, value);
            push_csv_escaped_content(out, value, format.quote_char);
            out.push(format.quote_char);
        }
        _ => {
            push_formula_guard(out, value);
            out.push_str(value);
        }
    }
}

struct CsvEscapedWriter<'a>(&'a mut String, char);

impl fmt::Write for CsvEscapedWriter<'_> {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        push_csv_escaped_content(self.0, value, self.1);
        Ok(())
    }
}

/// 将表导出 CSV 值直接写入已有 buffer；包括 NULL 在内的值均保留分页导出的带引号旧语义。
pub fn push_csv_text_value(out: &mut String, value: &Value) {
    push_csv_text_value_with_quote(out, value, '"');
}

pub fn push_csv_text_value_with_quote(out: &mut String, value: &Value, quote_char: char) {
    out.push(quote_char);
    match value {
        Value::Null => {}
        Value::String(value) => {
            push_formula_guard(out, value);
            push_csv_escaped_content(out, value, quote_char)
        }
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            fmt::write(out, format_args!("{value}")).expect("writing a number into a String cannot fail")
        }
        // 数组和对象可能包含引号，通过转义 writer 格式化，避免分配中间 JSON 字符串
        other => fmt::write(&mut CsvEscapedWriter(out, quote_char), format_args!("{other}"))
            .expect("writing JSON into a String cannot fail"),
    }
    out.push(quote_char);
}

fn push_csv_value_formatted(out: &mut String, value: &Value, format: &CsvTextFormat, quote_null: bool) {
    if value.is_null() {
        // 配置了 NULL 字面量时，NULL 写成该字面量；空字符串仍然写成 `""`。
        // 两者不再互相冒充，导出→导入才能无损往返。
        //
        // 字面量必须尽量裸写：PostgreSQL 的 COPY ... FORMAT csv 从不把带引号的值当成 NULL
        // （`"\N"` 是普通字符串，整数列直接报错），ClickHouse 的 CSV 读取更是在引号内遇到
        // `\N` 就解析失败；只有裸 `\N` 才是这两者与 MySQL 共同识别的 NULL。字面量自身含
        // 分隔符/引号/换行时才加引号（此时它本来也不再是标准 NULL 标记）。
        if let Some(literal) = format.null_literal.as_deref() {
            push_csv_field_with_format(
                out,
                literal,
                &CsvTextFormat { quote_mode: CsvQuoteMode::Necessary, ..format.clone() },
            );
            return;
        }
    }
    if format.quote_mode == CsvQuoteMode::All {
        if value.is_null() && !quote_null {
            return;
        }
        push_csv_text_value_with_quote(out, value, format.quote_char);
        return;
    }

    match value {
        Value::Null => {}
        Value::String(value) => push_csv_field_with_format(out, value, format),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            fmt::write(out, format_args!("{value}")).expect("writing a number into a String cannot fail")
        }
        other => push_csv_field_with_format(out, &other.to_string(), format),
    }
}

/// TSV 转义直写：仅含特殊字符时包引号（语义与原 escape_tsv 一致），守卫前缀在引号内。
fn push_tsv_escaped(out: &mut String, value: &str) {
    if value.contains('\t') || value.contains('\n') || value.contains('\r') || value.contains('"') {
        out.push('"');
        push_formula_guard(out, value);
        push_csv_escaped_content(out, value, '"');
        out.push('"');
    } else {
        push_formula_guard(out, value);
        out.push_str(value);
    }
}

fn push_tsv_value(out: &mut String, value: &Value, null_literal: Option<&str>) {
    if value.is_null() {
        // 与 CSV 一致：NULL 写字面量、空字符串写空字段，导出→导入才能无损往返。
        if let Some(literal) = null_literal {
            push_tsv_escaped(out, literal);
            return;
        }
    }
    match value {
        Value::Null => {}
        Value::String(v) => push_tsv_escaped(out, v),
        Value::Bool(v) => out.push_str(if *v { "true" } else { "false" }),
        Value::Number(value) => {
            fmt::write(out, format_args!("{value}")).expect("writing a number into a String cannot fail")
        }
        other => push_tsv_escaped(out, &other.to_string()),
    }
}

pub fn push_tsv_row(out: &mut String, row: &[Value], null_literal: Option<&str>) {
    for (cell_index, cell) in row.iter().enumerate() {
        if cell_index > 0 {
            out.push('\t');
        }
        push_tsv_value(out, cell, null_literal);
    }
}

/// 预分配粗估：按全部行的实际单元格数求和（不假设等宽），饱和运算防溢出，
/// 并设上限——估算只是性能提示，绝不能因病态输入放大成巨额分配
const ROWS_CAPACITY_ESTIMATE_MAX: usize = 16 * 1024 * 1024;

pub fn estimated_rows_capacity(rows: &[Vec<Value>]) -> usize {
    let cells: usize = rows.iter().map(Vec::len).fold(0usize, usize::saturating_add);
    cells.saturating_mul(12).min(ROWS_CAPACITY_ESTIMATE_MAX)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn escape_csv(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    push_csv_escaped(&mut out, value);
    out
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn escape_tsv(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    push_tsv_escaped(&mut out, value);
    out
}

fn push_tsv_rows(out: &mut String, rows: &[Vec<Value>], null_literal: Option<&str>) {
    for (row_index, row) in rows.iter().enumerate() {
        if row_index > 0 {
            out.push('\n');
        }
        push_tsv_row(out, row, null_literal);
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn format_tsv_rows(rows: &[Vec<Value>]) -> String {
    let mut out = String::with_capacity(estimated_rows_capacity(rows));
    push_tsv_rows(&mut out, rows, None);
    out
}

pub fn format_tsv(columns: &[String], rows: &[Vec<Value>]) -> String {
    let mut out = String::with_capacity(
        estimated_rows_capacity(rows).saturating_add(columns.len().saturating_mul(12)).min(ROWS_CAPACITY_ESTIMATE_MAX),
    );
    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            out.push('\t');
        }
        push_tsv_escaped(&mut out, column);
    }
    out.push('\n');
    push_tsv_rows(&mut out, rows, None);
    out
}

/// Format query-result rows as CSV text without a header row. Database NULLs
/// use the same empty-cell representation as table-data exports. Used by the
/// streaming query-result export for batches after the first.
pub fn push_query_result_csv_row(out: &mut String, row: &[Value]) {
    push_query_result_csv_row_with_quote_mode(out, row, CsvQuoteMode::All);
}

pub fn push_query_result_csv_row_with_quote_mode(out: &mut String, row: &[Value], quote_mode: CsvQuoteMode) {
    push_query_result_csv_row_with_format(out, row, &CsvTextFormat::from(quote_mode));
}

pub fn push_query_result_csv_row_with_format(out: &mut String, row: &[Value], format: &CsvTextFormat) {
    for (cell_index, cell) in row.iter().enumerate() {
        if cell_index > 0 {
            out.push(format.delimiter);
        }
        push_csv_value_formatted(out, cell, format, false);
    }
}

pub fn push_query_result_csv_row_with_options(
    out: &mut String,
    row: &[Value],
    quote_mode: CsvQuoteMode,
    null_literal: Option<&str>,
) {
    push_query_result_csv_row_with_format(out, row, &format_with_null_literal(quote_mode, null_literal));
}

pub fn push_table_csv_row(out: &mut String, row: &[Value]) {
    push_table_csv_row_with_quote_mode(out, row, CsvQuoteMode::All);
}

pub fn push_table_csv_row_with_quote_mode(out: &mut String, row: &[Value], quote_mode: CsvQuoteMode) {
    push_table_csv_row_with_format(out, row, &CsvTextFormat::from(quote_mode));
}

pub fn push_table_csv_row_with_format(out: &mut String, row: &[Value], format: &CsvTextFormat) {
    for (cell_index, cell) in row.iter().enumerate() {
        if cell_index > 0 {
            out.push(format.delimiter);
        }
        push_csv_value_formatted(out, cell, format, true);
    }
}

pub fn push_table_csv_row_with_options(
    out: &mut String,
    row: &[Value],
    quote_mode: CsvQuoteMode,
    null_literal: Option<&str>,
) {
    push_table_csv_row_with_format(out, row, &format_with_null_literal(quote_mode, null_literal));
}

/// quote mode + NULL 字面量组装成完整 format（其余字段保持默认），
/// 供 upstream 风格的 `_with_options` 变体复用。
fn format_with_null_literal(quote_mode: CsvQuoteMode, null_literal: Option<&str>) -> CsvTextFormat {
    CsvTextFormat { null_literal: null_literal.map(str::to_string), ..CsvTextFormat::from(quote_mode) }
}

fn push_query_result_csv_rows(out: &mut String, rows: &[Vec<Value>]) {
    for (row_index, row) in rows.iter().enumerate() {
        if row_index > 0 {
            out.push('\n');
        }
        push_query_result_csv_row(out, row);
    }
}

pub fn format_query_result_csv_rows(rows: &[Vec<Value>]) -> String {
    let mut out = String::with_capacity(estimated_rows_capacity(rows));
    push_query_result_csv_rows(&mut out, rows);
    out
}

fn format_csv_with_value_formatter(columns: &[String], rows: &[Vec<Value>]) -> String {
    let mut out = String::with_capacity(
        estimated_rows_capacity(rows).saturating_add(columns.len().saturating_mul(12)).min(ROWS_CAPACITY_ESTIMATE_MAX),
    );
    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_csv_field(&mut out, column, CsvQuoteMode::All);
    }
    out.push('\n');
    push_query_result_csv_rows(&mut out, rows);
    out
}

pub fn format_csv(columns: &[String], rows: &[Vec<Value>]) -> String {
    format_csv_with_value_formatter(columns, rows)
}

pub fn format_csv_with_quote_mode(columns: &[String], rows: &[Vec<Value>], quote_mode: CsvQuoteMode) -> String {
    format_csv_with_format(columns, rows, CsvTextFormat::from(quote_mode))
}

pub fn format_csv_with_format(columns: &[String], rows: &[Vec<Value>], format: CsvTextFormat) -> String {
    let mut out = String::with_capacity(
        estimated_rows_capacity(rows).saturating_add(columns.len().saturating_mul(12)).min(ROWS_CAPACITY_ESTIMATE_MAX),
    );
    // 表头关闭时首行直接是数据行；各流式导出路径的表头也统一走这里（空表头
    // 返回空串，写侧 write_all 空串等价于跳过，行写入各自前置 '\n' 不受影响）。
    if format.include_header {
        for (index, column) in columns.iter().enumerate() {
            if index > 0 {
                out.push(format.delimiter);
            }
            push_csv_field_with_format(&mut out, column, &format);
        }
        out.push('\n');
    }
    for (row_index, row) in rows.iter().enumerate() {
        if row_index > 0 {
            out.push('\n');
        }
        push_query_result_csv_row_with_format(&mut out, row, &format);
    }
    out
}

pub fn format_csv_with_options(
    columns: &[String],
    rows: &[Vec<Value>],
    quote_mode: CsvQuoteMode,
    null_literal: Option<&str>,
) -> String {
    format_csv_with_format(columns, rows, format_with_null_literal(quote_mode, null_literal))
}

pub fn format_query_result_csv(columns: &[String], rows: &[Vec<Value>]) -> String {
    format_csv(columns, rows)
}

pub fn format_query_result_csv_with_quote_mode(
    columns: &[String],
    rows: &[Vec<Value>],
    quote_mode: CsvQuoteMode,
) -> String {
    format_csv_with_format(columns, rows, CsvTextFormat::from(quote_mode))
}

pub fn format_query_result_csv_with_format(columns: &[String], rows: &[Vec<Value>], format: CsvTextFormat) -> String {
    format_csv_with_format(columns, rows, format)
}

pub fn format_query_result_csv_with_options(
    columns: &[String],
    rows: &[Vec<Value>],
    quote_mode: CsvQuoteMode,
    null_literal: Option<&str>,
) -> String {
    format_csv_with_format(columns, rows, format_with_null_literal(quote_mode, null_literal))
}

pub fn write_csv_text_row(
    writer: &mut impl Write,
    values: impl IntoIterator<Item = String>,
    quote_mode: CsvQuoteMode,
) -> Result<(), String> {
    write_csv_text_row_with_format(writer, values, &CsvTextFormat::from(quote_mode))
}

pub fn write_csv_text_row_with_format(
    writer: &mut impl Write,
    values: impl IntoIterator<Item = String>,
    format: &CsvTextFormat,
) -> Result<(), String> {
    let delimiter = format.delimiter.to_string();
    let mut first = true;
    for value in values {
        if !first {
            writer.write_all(delimiter.as_bytes()).map_err(|err| err.to_string())?;
        }
        first = false;
        let mut formatted = String::with_capacity(value.len() + 2);
        push_csv_field_with_format(&mut formatted, &value, format);
        writer.write_all(formatted.as_bytes()).map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub fn write_csv_value_row(
    writer: &mut impl Write,
    values: impl IntoIterator<Item = Value>,
    quote_mode: CsvQuoteMode,
) -> Result<(), String> {
    write_csv_value_row_with_format(writer, values, &CsvTextFormat::from(quote_mode))
}

pub fn write_csv_value_row_with_format(
    writer: &mut impl Write,
    values: impl IntoIterator<Item = Value>,
    format: &CsvTextFormat,
) -> Result<(), String> {
    let delimiter = format.delimiter.to_string();
    let mut first = true;
    // 复用同一个格式化 buffer：逐行流式导出对每个单元格调用，是导出热路径。
    let mut formatted = String::new();
    for value in values {
        if !first {
            writer.write_all(delimiter.as_bytes()).map_err(|err| err.to_string())?;
        }
        first = false;
        formatted.clear();
        push_csv_value_formatted(&mut formatted, &value, format, false);
        writer.write_all(formatted.as_bytes()).map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub fn write_csv_value_row_with_options(
    writer: &mut impl Write,
    values: impl IntoIterator<Item = Value>,
    quote_mode: CsvQuoteMode,
    null_literal: Option<&str>,
) -> Result<(), String> {
    write_csv_value_row_with_format(writer, values, &format_with_null_literal(quote_mode, null_literal))
}

#[cfg(test)]
mod tests {
    use super::{
        format_csv, format_csv_with_options, format_csv_with_quote_mode, format_query_result_csv,
        format_query_result_csv_rows, format_tsv, CsvQuoteMode, DEFAULT_CSV_NULL_LITERAL,
    };
    use serde_json::json;

    #[test]
    fn formats_csv_with_header_and_escaped_values() {
        let out = format_csv(&["id".to_string(), "name".to_string()], &[vec![json!(1), json!("Ada \"Lovelace\"")]]);
        assert_eq!(out, "\"id\",\"name\"\n\"1\",\"Ada \"\"Lovelace\"\"\"");
    }

    #[test]
    fn formats_null_as_empty_cell() {
        let out = format_csv(&["id".to_string(), "note".to_string()], &[vec![json!(1), Value::Null]]);
        assert_eq!(out, "\"id\",\"note\"\n\"1\",");
    }

    #[test]
    fn formats_query_result_null_as_empty_cell() {
        let out = format_query_result_csv(&["id".to_string(), "note".to_string()], &[vec![json!(1), Value::Null]]);
        assert_eq!(out, "\"id\",\"note\"\n\"1\",");
    }

    #[test]
    fn necessary_quote_mode_only_quotes_csv_special_characters() {
        let out = format_csv_with_quote_mode(
            &["id".to_string(), "district,name".to_string(), "note".to_string()],
            &[
                vec![json!(2085252644_u64), json!("延庆县"), json!("plain")],
                vec![json!(2085252645_u64), json!("门头沟区"), json!("line 1\n\"line 2\"")],
            ],
            CsvQuoteMode::Necessary,
        );
        assert_eq!(
            out,
            "id,\"district,name\",note\n2085252644,延庆县,plain\n2085252645,门头沟区,\"line 1\n\"\"line 2\"\"\""
        );
    }

    #[test]
    fn csv_quote_mode_defaults_to_all_for_backward_compatibility() {
        assert_eq!(CsvQuoteMode::default(), CsvQuoteMode::All);
    }

    #[test]
    fn strings_quote_mode_quotes_text_values_headers_and_json_but_not_numbers_or_booleans() {
        // mod 42：类型感知引号——字符串/表头/JSON 化对象加引号，数值/布尔裸写，
        // NULL 字面量保持 necessary 的裸写语义（`\N` 带引号后回读端不再识别）。
        let out = format_csv_with_options(
            &["id".to_string(), "note".to_string(), "flag".to_string()],
            &[
                vec![json!(1), json!("0123"), json!(true)],
                vec![json!(2.5), json!("say \"hi\""), json!(false)],
                vec![json!(3), serde_json::Value::Null, json!("[1, 2]")],
            ],
            CsvQuoteMode::Strings,
            Some(DEFAULT_CSV_NULL_LITERAL),
        );
        assert_eq!(
            out,
            concat!(
                "\"id\",\"note\",\"flag\"\n",
                "1,\"0123\",true\n",
                "2.5,\"say \"\"hi\"\"\",false\n",
                "3,\\N,\"[1, 2]\""
            )
        );
    }

    #[test]
    fn semicolon_delimiter_separates_and_quotes_only_delimiter_occurrences() {
        let out = super::format_csv_with_format(
            &["id".to_string(), "comma".to_string(), "semi".to_string()],
            &[
                vec![json!(1), json!("a,b"), json!("x;y")],
                vec![json!(2), json!("line 1\n\"line 2\""), json!("plain")],
            ],
            super::CsvTextFormat { quote_mode: CsvQuoteMode::Necessary, delimiter: ';', ..Default::default() },
        );
        // 逗号不再触发引号（它不再是分隔符）；分号/引号/换行仍按需加引号。
        assert_eq!(out, "id;comma;semi\n1;a,b;\"x;y\"\n2;\"line 1\n\"\"line 2\"\"\";plain");
    }

    #[test]
    fn never_quote_mode_writes_fields_raw_even_with_special_characters() {
        let out = super::format_csv_with_format(
            &["a,b".to_string(), "plain".to_string()],
            &[vec![json!("line 1\n\"line 2\""), json!(Value::Null)]],
            super::CsvTextFormat { quote_mode: CsvQuoteMode::Never, delimiter: ',', ..Default::default() },
        );
        // Never 显式不转义：含逗号的表头/含换行的值原样输出，会与结构字符
        // 混在一起（空单元格为裸空）。这正是该模式的风险，由用户自担。
        assert_eq!(out, "a,b,plain\nline 1\n\"line 2\",");
    }

    #[test]
    fn never_quote_mode_deserializes_from_camel_case_json() {
        assert_eq!(serde_json::from_str::<CsvQuoteMode>("\"never\"").unwrap(), CsvQuoteMode::Never);
        assert_eq!(serde_json::from_str::<CsvQuoteMode>("\"necessary\"").unwrap(), CsvQuoteMode::Necessary);
    }

    #[test]
    fn resolve_csv_delimiter_takes_the_first_character_and_falls_back_to_comma() {
        assert_eq!(super::resolve_csv_delimiter(";"), ';');
        assert_eq!(super::resolve_csv_delimiter("\t"), '\t');
        assert_eq!(super::resolve_csv_delimiter(""), ',');
        assert_eq!(super::resolve_csv_delimiter(";;"), ';');
    }

    #[test]
    fn custom_quote_character_wraps_and_doubles_itself() {
        let out = super::format_csv_with_format(
            &["id".to_string(), "name".to_string()],
            &[vec![json!(1), json!("O'Brien"), json!("plain")]],
            super::CsvTextFormat { quote_mode: CsvQuoteMode::All, delimiter: ',', quote_char: '\'', ..Default::default() },
        );
        // 引号字符换成 ' 后：包裹用它、内部出现时翻倍；默认的 " 退化为普通字符。
        assert_eq!(out, "'id','name'\n'1','O''Brien','plain'");
    }

    #[test]
    fn necessary_mode_quotes_custom_quote_char_and_delimiter_but_not_default_quotes() {
        let out = super::format_csv_with_format(
            &["id".to_string(), "note".to_string()],
            &[vec![json!(7), json!("it's a, \"test\"")]],
            super::CsvTextFormat { quote_mode: CsvQuoteMode::Necessary, delimiter: ',', quote_char: '\'', ..Default::default() },
        );
        // `'` 触发引号（自定义引号字符）、`,` 触发（分隔符）；`"` 不再触发。
        assert_eq!(out, "id,note\n7,'it''s a, \"test\"'");
    }

    #[test]
    fn include_header_false_omits_the_header_row() {
        let out = super::format_csv_with_format(
            &["id".to_string(), "name".to_string()],
            &[vec![json!(1), json!("Ada")], vec![json!(2), json!("Bob")]],
            super::CsvTextFormat { include_header: false, ..Default::default() },
        );
        assert_eq!(out, "\"1\",\"Ada\"\n\"2\",\"Bob\"");
    }

    #[test]
    fn include_header_false_with_no_rows_yields_empty_output() {
        let out = super::format_csv_with_format(
            &["id".to_string(), "name".to_string()],
            &[],
            super::CsvTextFormat { include_header: false, ..Default::default() },
        );
        assert_eq!(out, "");
    }

    #[test]
    fn resolve_csv_quote_char_takes_the_first_character_and_falls_back_to_double_quote() {
        assert_eq!(super::resolve_csv_quote_char("'"), '\'');
        assert_eq!(super::resolve_csv_quote_char("`"), '`');
        assert_eq!(super::resolve_csv_quote_char(""), '"');
        assert_eq!(super::resolve_csv_quote_char("''"), '\'');
    }

    #[test]
    fn table_csv_rows_keep_quoted_nulls_in_all_mode_with_custom_delimiter() {
        let mut out = String::new();
        super::push_table_csv_row_with_format(
            &mut out,
            &[Value::Null, json!("NULL"), json!("tab\there")],
            &super::CsvTextFormat { quote_mode: CsvQuoteMode::All, delimiter: '\t', ..Default::default() },
        );
        assert_eq!(out, "\"\"\t\"NULL\"\t\"tab\there\"");
    }

    #[test]
    fn formats_streamed_query_result_null_as_empty_cell_and_preserves_literal_null() {
        let out = format_query_result_csv_rows(&[vec![Value::Null, json!("NULL"), json!("")]]);
        assert_eq!(out, ",\"NULL\",\"\"");
    }

    #[test]
    fn formats_tsv_with_empty_null_and_escaped_special_values() {
        let out = format_tsv(
            &["id".to_string(), "note".to_string()],
            &[vec![json!(1), Value::Null], vec![json!(2), json!("line1\n\"line2\"")]],
        );
        assert_eq!(out, "id\tnote\n1\t\n2\t\"line1\n\"\"line2\"\"\"");
    }

    #[test]
    fn capacity_estimate_sums_actual_cells_across_ragged_rows() {
        // 不等宽行按实际单元格数求和，不得按首行宽度放大
        let wide_first = vec![vec![serde_json::Value::Null; 1000], vec![], vec![serde_json::Value::Null]];
        assert_eq!(super::estimated_rows_capacity(&wide_first), 1001 * 12);
        assert!(super::estimated_rows_capacity(&[]) == 0);
    }

    #[test]
    fn escape_tsv_matches_reference_semantics() {
        // TSV 仅在含 \t/\n/\r/引号时包引号；逗号不触发
        for input in ["", "plain", "with,comma", "tab\there", "line\nbreak", "cr\rhere", "quo\"te", "\t\"mix\""] {
            // 公式中和前缀与转义正交：守卫由共享原语计算，无论是否包引号都带前缀
            let mut guard = String::new();
            super::push_formula_guard(&mut guard, input);
            let expected =
                if input.contains('\t') || input.contains('\n') || input.contains('\r') || input.contains('"') {
                    format!("\"{guard}{}\"", input.replace('"', "\"\""))
                } else {
                    format!("{guard}{input}")
                };
            assert_eq!(super::escape_tsv(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn push_csv_escaped_matches_replace_reference() {
        // 直写实现必须与原 replace 版本逐字节等价（含引号在首/尾/连续的边界）
        for input in ["", "plain", "\"", "\"\"", "a\"b", "\"start", "end\"", "mid\"\"dle", "逗,号\n换行"] {
            let expected = format!("\"{}\"", input.replace('"', "\"\""));
            assert_eq!(super::escape_csv(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn push_csv_text_value_preserves_paginated_export_semantics() {
        let cases = [
            (serde_json::Value::Null, "\"\""),
            (serde_json::json!(true), "\"true\""),
            (serde_json::json!(42.5), "\"42.5\""),
            (serde_json::json!("a\"b"), "\"a\"\"b\""),
            (serde_json::json!({"key": "value"}), "\"{\"\"key\"\":\"\"value\"\"}\""),
        ];

        for (value, expected) in cases {
            let mut out = String::from("prefix,");
            super::push_csv_text_value(&mut out, &value);
            assert_eq!(out, format!("prefix,{expected}"));
        }
    }

    #[test]
    fn default_null_literal_is_the_mysql_outfile_convention() {
        assert_eq!(DEFAULT_CSV_NULL_LITERAL, "\\N");
        // 空串表示「不写 NULL 标记」，即沿用历史行为
        assert_eq!(super::csv_null_literal(""), None);
        assert_eq!(super::csv_null_literal(DEFAULT_CSV_NULL_LITERAL), Some("\\N"));
    }

    #[test]
    fn tsv_null_literal_separates_null_from_an_empty_string() {
        let row = vec![Value::Null, json!("")];

        // 未配置字面量（旧行为）：NULL 与空串都写空字段，二者在文件里无法区分
        let mut out = String::new();
        super::push_tsv_row(&mut out, &row, None);
        assert_eq!(out, "\t");

        // 配置字面量后：NULL 写成字面量，空字符串仍是空字段
        let mut out = String::new();
        super::push_tsv_row(&mut out, &row, Some(DEFAULT_CSV_NULL_LITERAL));
        assert_eq!(out, "\\N\t");
    }

    #[test]
    fn null_literal_stops_null_from_impersonating_an_empty_string() {
        let columns = vec!["a".to_string(), "b".to_string()];
        let row = vec![Value::Null, json!("")];

        // 未配置字面量（旧行为）：NULL 写成裸空字段，空串写成 `""`，
        // 文件里看似可区分，但导入端拿不到引号信息，两者最终都会变成 NULL
        assert_eq!(
            format_csv_with_options(&columns, std::slice::from_ref(&row), CsvQuoteMode::All, None),
            "\"a\",\"b\"\n,\"\""
        );

        // 配置字面量后：NULL 写成裸字面量，空串写成 `""`；即使 quote mode = All 也不给
        // 字面量加引号，否则 PostgreSQL/ClickHouse 的 CSV 读取不认它是 NULL
        assert_eq!(
            format_csv_with_options(
                &columns,
                std::slice::from_ref(&row),
                CsvQuoteMode::All,
                Some(DEFAULT_CSV_NULL_LITERAL)
            ),
            "\"a\",\"b\"\n\\N,\"\""
        );
        // Necessary 模式：空串裸写为空字段，但 NULL 有独立字面量，仍然可区分
        assert_eq!(
            format_csv_with_options(
                &columns,
                std::slice::from_ref(&row),
                CsvQuoteMode::Necessary,
                Some(DEFAULT_CSV_NULL_LITERAL)
            ),
            "a,b\n\\N,"
        );
    }

    #[test]
    fn null_literal_is_quoted_only_when_it_needs_quoting() {
        let columns = vec!["a".to_string()];
        let row = vec![Value::Null];

        // 标准字面量裸写（PostgreSQL/ClickHouse/MySQL 共同识别的 NULL 写法）
        assert_eq!(
            format_csv_with_options(&columns, std::slice::from_ref(&row), CsvQuoteMode::All, Some("\\N")),
            "\"a\"\n\\N"
        );
        // 自定义字面量含分隔符时无法裸写，只能退化成带引号的普通字段
        assert_eq!(
            format_csv_with_options(&columns, std::slice::from_ref(&row), CsvQuoteMode::All, Some("a,b")),
            "\"a\"\n\"a,b\""
        );
    }

    #[test]
    fn null_literal_applies_to_streaming_row_writers_too() {
        let row = vec![Value::Null, json!("NULL"), json!("")];

        let mut table = String::new();
        super::push_table_csv_row_with_options(&mut table, &row, CsvQuoteMode::All, Some(DEFAULT_CSV_NULL_LITERAL));
        assert_eq!(table, "\\N,\"NULL\",\"\"");

        let mut query = String::new();
        super::push_query_result_csv_row_with_options(
            &mut query,
            &row,
            CsvQuoteMode::All,
            Some(DEFAULT_CSV_NULL_LITERAL),
        );
        assert_eq!(query, "\\N,\"NULL\",\"\"");

        let mut written = Vec::new();
        super::write_csv_value_row_with_options(&mut written, row, CsvQuoteMode::All, Some(DEFAULT_CSV_NULL_LITERAL))
            .unwrap();
        assert_eq!(String::from_utf8(written).unwrap(), "\\N,\"NULL\",\"\"");
    }

    #[test]
    fn null_literal_rides_the_format_carrier_with_custom_delimiter() {
        // 模 19 的 CsvTextFormat 载体同样携带 NULL 字面量：自定义分隔符下，
        // NULL 裸写字面量、空字符串仍按 quote mode 加引号，两者不互相冒充。
        let out = super::format_csv_with_format(
            &["id".to_string(), "note".to_string()],
            &[vec![json!(1), Value::Null], vec![json!(2), json!("")]],
            super::CsvTextFormat {
                quote_mode: CsvQuoteMode::All,
                delimiter: ';',
                null_literal: Some(DEFAULT_CSV_NULL_LITERAL.to_string()),
                ..Default::default()
            },
        );
        assert_eq!(out, "\"id\";\"note\"\n\"1\";\\N\n\"2\";\"\"");
    }

    #[test]
    fn reusable_row_buffers_match_batch_formatters() {
        let row = vec![Value::Null, json!("NULL"), json!("line\n\"two\""), json!(42)];

        let mut csv = String::new();
        super::push_query_result_csv_row(&mut csv, &row);
        assert_eq!(csv, super::format_query_result_csv_rows(std::slice::from_ref(&row)));

        let mut table_csv = String::new();
        super::push_table_csv_row(&mut table_csv, &row);
        assert_eq!(table_csv, "\"\",\"NULL\",\"line\n\"\"two\"\"\",\"42\"");

        let mut tsv = String::new();
        super::push_tsv_row(&mut tsv, &row, None);
        assert_eq!(tsv, super::format_tsv_rows(&[row]));
    }

    #[test]
    fn formula_like_text_cells_are_neutralized() {
        let out = format_csv(
            &["cmd".to_string()],
            &[
                vec![json!("=WEBSERVICE(\"https://evil\")")],
                vec![json!("+2")],
                vec![json!("-3")],
                vec![json!("@x")],
                vec![json!("\tlead")],
                vec![json!("safe")],
                vec![json!(-4)],
            ],
        );
        // `-3` 是整串十进制字面量（驱动 DECIMAL/BIGINT 文本形态），豁免中和
        assert_eq!(
            out,
            "\"cmd\"\n\"'=WEBSERVICE(\"\"https://evil\"\")\"\n\"'+2\"\n\"-3\"\n\"'@x\"\n\"'\tlead\"\n\"safe\"\n\"-4\""
        );
    }

    #[test]
    fn at_sign_before_non_ascii_text_keeps_its_plain_form() {
        // 回归：`@` + 非 ASCII 文本（Oracle 里 `@冯十二` 这类）曾被当成公式触发符
        // 写成 `'@冯十二`。`@` 后没有 ASCII 记号时 Excel 没有可求值的表达式；
        // `@` 后跟着 ASCII 记号的形态（函数调用、引用、数字）仍是公式面，继续守卫。
        let out = format_csv(
            &["v".to_string()],
            &[
                vec![json!("@冯十二")],
                vec![json!("@张三@李四")],
                vec![json!("@")],
                vec![json!("@🐴")],
                vec![json!("@ 冯十二")],
                vec![json!("@WEBSERVICE(\"https://evil\")")],
                vec![json!("@SUM(1)")],
                vec![json!("@A1")],
            ],
        );
        assert_eq!(
            out,
            concat!(
                "\"v\"\n",
                "\"@冯十二\"\n",
                "\"@张三@李四\"\n",
                "\"@\"\n",
                "\"@🐴\"\n",
                // `@` 后是 ASCII 空格，仍按触发符处理（保守）
                "\"'@ 冯十二\"\n",
                "\"'@WEBSERVICE(\"\"https://evil\"\")\"\n",
                "\"'@SUM(1)\"\n",
                "\"'@A1\""
            )
        );
    }

    #[test]
    fn negative_decimal_text_cells_keep_their_plain_numeric_form() {
        // 回归：DECIMAL/NUMERIC/BIGINT 负值以文本下发（PG numeric、MySQL DECIMAL
        // 都返回字符串），曾因 `-` 触发符被写成 `'-1`，复制/导出内容被污染。
        // 整串数字字面量豁免；超 15 位有效数字、`+` 号形态与注入载荷仍守卫。
        let out = format_csv(
            &["v".to_string()],
            &[
                vec![json!("-1")],
                vec![json!("-123.45")],
                vec![json!("-0.000000000000001")],
                vec![json!(" -1")],
                vec![json!("-9223372036854775808")],
                vec![json!("+8613800000000")],
                vec![json!("-2+1+cmd|'x'")],
                vec![json!("-cmd")],
            ],
        );
        assert_eq!(
            out,
            concat!(
                "\"v\"\n",
                "\"-1\"\n",
                "\"-123.45\"\n",
                "\"-0.000000000000001\"\n",
                "\" -1\"\n",
                // 19 位有效数字超出 Excel 15 位精度上限，按文本守卫防丢尾数
                "\"'-9223372036854775808\"\n",
                // `+` 号形态是电话号码类标识文本，守卫保留文本语义
                "\"'+8613800000000\"\n",
                "\"'-2+1+cmd|'x'\"\n",
                "\"'-cmd\""
            )
        );
    }

    #[test]
    fn negative_decimal_precision_counts_digits_across_the_decimal_point() {
        for (value, guarded) in [
            ("-123456789012345.6", true),
            ("-12345678.12345678", true),
            ("-12345678.01234567", true),
            ("-12345678.1234567", false),
            ("-00012345678.1234567", false),
            ("-0.000000000000000123456789012345", false),
            ("-0.0000000000000001234567890123456", true),
            ("-0.00000000000000000000", false),
        ] {
            let expected = format!("{}{value}", if guarded { "'" } else { "" });
            let rows = [vec![json!(value)]];
            assert_eq!(format_csv(&["v".to_string()], &rows), format!("\"v\"\n\"{expected}\""), "CSV: {value}");
            assert_eq!(format_tsv(&["v".to_string()], &rows), format!("v\n{expected}"), "TSV: {value}");
            assert_eq!(super::strip_formula_guard(&expected), value);
        }
    }

    #[test]
    fn formula_guard_covers_necessary_mode_raw_cells_and_tsv() {
        let out = format_csv_with_quote_mode(
            &["v".to_string()],
            &[vec![json!("=sum")], vec![json!("x=y")]],
            CsvQuoteMode::Necessary,
        );
        assert_eq!(out, "v\n'=sum\nx=y");
        let tsv = format_tsv(&["v".to_string()], &[vec![json!("=sum")], vec![json!("plain")]]);
        assert_eq!(tsv, "v\n'=sum\nplain");
    }

    #[test]
    fn formula_guard_covers_headers() {
        let out = format_csv(&["-total".to_string()], &[vec![json!(1)]]);
        assert_eq!(out, "\"'-total\"\n\"1\"");
    }

    #[test]
    fn json_cells_are_exported_verbatim_and_strings_still_guarded() {
        // 回归：guard 曾挂在片段级写入路径（push_csv_escaped_content）上，而它同时是
        // serde_json Display 的 fmt::Write sink，对象/数组被拆成多个片段逐段写入，
        // guard 在单元格中间触发，把 {"n": -5} 写成 {"n":'-5}、[1, -2] 写成 [1,'-2]，
        // 导出的 JSON 因此失效。guard 现在是单元格级语义，JSON 单元格逐字节原样。
        let out = format_csv(
            &["v".to_string()],
            &[
                vec![json!({"n": -5})],
                vec![json!([1, -2])],
                vec![json!(["-5"])],
                vec![json!({"formula": "=1+1"})],
                vec![json!("-5")],
            ],
        );
        assert_eq!(
            out,
            concat!(
                "\"v\"\n",
                "\"{\"\"n\"\":-5}\"\n",
                "\"[1,-2]\"\n",
                "\"[\"\"-5\"\"]\"\n",
                "\"{\"\"formula\"\":\"\"=1+1\"\"}\"\n",
                "\"-5\""
            )
        );
    }

    #[test]
    fn formula_guard_escapes_literal_leading_apostrophe_for_symmetric_round_trip() {
        // 字面前导撇号（'+86 是表格里存手机号的常见写法）导出时翻倍为 ''，
        // 使导入侧的剥离成为无歧义逆操作；前导空格后跟触发字符（OWASP " =cmd"
        // 绕过）同样中和；单独的 ' 或 ' 后接普通字符是用户数据，不动。
        let out = format_csv(
            &["v".to_string()],
            &[
                vec![json!("'+8613800000000")],
                vec![json!("''-already-doubled")],
                vec![json!("'plain")],
                vec![json!(" =cmd")],
                vec![json!("  -note")],
                vec![json!("' =spaced")],
            ],
        );
        assert_eq!(
            out,
            concat!(
                "\"v\"\n",
                "\"''+8613800000000\"\n",
                "\"'''-already-doubled\"\n",
                "\"'plain\"\n",
                "\"' =cmd\"\n",
                "\"'  -note\"\n",
                "\"'' =spaced\""
            )
        );
    }

    #[test]
    fn formula_guard_strip_is_the_exact_inverse_of_push() {
        // guard 之后再 strip 必须还原原值，覆盖触发字符、前导空格、撇号转义与
        // 空串边界；不以撇号开头的单元格 strip 一律原样返回。
        for value in [
            "=cmd",
            " =cmd",
            "  -x",
            "+2",
            "-3",
            "@a",
            "\tx",
            "\rx",
            "'+86",
            "''-e",
            "' =spaced",
            "'",
            "''",
            "'''",
            "'plain",
            "plain",
            "",
        ] {
            let mut guarded = String::new();
            super::push_formula_guard(&mut guarded, value);
            let cell = format!("{guarded}{value}");
            assert_eq!(super::strip_formula_guard(&cell), value, "value: {value:?}");
        }
        assert_eq!(super::strip_formula_guard("plain"), "plain");
        assert_eq!(super::strip_formula_guard("'"), "'");
    }

    use serde_json::Value;
}
