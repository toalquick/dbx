import { describe, expect, it } from "vitest";
import { csvFieldNeedsQuotes, csvFileExtension, escapeCsvField, normalizeCsvQuoteMode } from "@/lib/export/csvQuoteMode";
import { formatCsv } from "@/lib/export/exportFormats";

describe("csvQuoteMode", () => {
  it("normalizes the quote mode and accepts the never option", () => {
    expect(normalizeCsvQuoteMode("necessary")).toBe("necessary");
    expect(normalizeCsvQuoteMode("never")).toBe("never");
    expect(normalizeCsvQuoteMode("strings")).toBe("strings");
    expect(normalizeCsvQuoteMode("all")).toBe("all");
    expect(normalizeCsvQuoteMode("bogus")).toBe("all");
    expect(normalizeCsvQuoteMode(undefined)).toBe("all");
  });

  it("escapes with the custom quote character and doubles it inside values", () => {
    expect(escapeCsvField("O'Brien", "all", ",", "'")).toBe("'O''Brien'");
    expect(escapeCsvField('say "hi"', "all", ",", '"')).toBe('"say ""hi"""');
  });

  it("treats the delimiter and quote character as quoting triggers in necessary mode", () => {
    expect(csvFieldNeedsQuotes("plain")).toBe(false);
    expect(csvFieldNeedsQuotes("a,b")).toBe(true);
    expect(csvFieldNeedsQuotes("a;b", ";")).toBe(true);
    expect(csvFieldNeedsQuotes("it's", ",", "'")).toBe(true);
    // 默认引号字符不再是自定义引号时的触发条件，反之亦然。
    expect(csvFieldNeedsQuotes('has "quotes"', ",", "'")).toBe(false);
    expect(csvFieldNeedsQuotes("line\nbreak")).toBe(true);
  });

  it("writes fields raw in never mode", () => {
    expect(escapeCsvField('a,"b"\nc', "never")).toBe('a,"b"\nc');
  });

  it("maps the tab delimiter to the tsv extension", () => {
    expect(csvFileExtension("\t")).toBe("tsv");
    expect(csvFileExtension(",")).toBe("csv");
    expect(csvFileExtension(";")).toBe("csv");
  });
});

describe("formatCsv", () => {
  const columns = ["id", "note"];
  const rows = [
    [1, "plain"],
    [2, 'has "quotes", and commas'],
  ];

  it("keeps the legacy default output (quote everything, comma, header)", () => {
    expect(formatCsv(columns, rows)).toBe('"id","note"\n"1","plain"\n"2","has ""quotes"", and commas"');
  });

  it("applies the delimiter, quote character, and quote mode together", () => {
    // 分号分隔后逗号/默认双引号不再触发引号；值内含 ' 才加引号。
    expect(csvFieldNeedsQuotes('has "quotes", and commas', ";", "'")).toBe(false);
    expect(
      formatCsv(columns, rows, {
        quoteMode: "necessary",
        delimiter: ";",
        quoteChar: "'",
        includeHeader: true,
      }),
    ).toBe('id;note\n1;plain\n2;has "quotes", and commas');
    expect(formatCsv(columns, [[2, "it's"]], { quoteMode: "necessary", delimiter: ";", quoteChar: "'" })).toBe("id;note\n2;'it''s'");
  });

  it("omits the header row when includeHeader is false", () => {
    expect(formatCsv(columns, rows, { includeHeader: false })).toBe('"1","plain"\n"2","has ""quotes"", and commas"');
    expect(formatCsv(columns, [], { includeHeader: false })).toBe("");
  });

  it("never mode writes raw fields", () => {
    expect(formatCsv(columns, rows, { quoteMode: "never" })).toBe('id,note\n1,plain\n2,has "quotes", and commas');
  });

  it("strings mode quotes text values and headers but not numbers or booleans", () => {
    expect(
      formatCsv(
        ["id", "note"],
        [
          [1, "0123"],
          [true, 'say "hi"'],
        ],
        { quoteMode: "strings", includeHeader: false },
      ),
    ).toBe('1,"0123"\ntrue,"say ""hi"""');
    expect(formatCsv(["id", "note"], [[2, "plain"]], { quoteMode: "strings" })).toBe('"id","note"\n2,"plain"');
    // NULL 字面量保持裸写（necessary），回读端才能识别。
    expect(formatCsv(["id", "note"], [[1, null]], { quoteMode: "strings", nullLiteral: "\\N" })).toBe('"id","note"\n1,\\N');
  });
});
