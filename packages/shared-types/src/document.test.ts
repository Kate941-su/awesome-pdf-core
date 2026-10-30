import { describe, expect, it } from "vitest";
import {
  assetFilenameSchema,
  documentTitleSchema,
  markdownSchema,
  templateNameSchema,
} from "./document.ts";
import { MAX_MARKDOWN_BYTES } from "./limits.ts";

describe("assetFilenameSchema", () => {
  it.each(["diagram.png", "写真.JPG", "chart-01.webp", "a b.jpeg"])("accepts %s", (name) => {
    expect(assetFilenameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    ["path traversal", "../secret.png"],
    ["absolute path", "/etc/passwd.png"],
    ["windows separator", "..\\x.png"],
    ["hidden file", ".x.png"],
    ["svg", "image.svg"],
    ["no extension", "image"],
    ["null byte", "a\u0000.png"],
    ["newline", "a\n.png"],
    ["bidi override", "a‮gnp.exe.png"],
    ["leading space", " a.png"],
    ["NFD", "が.png"],
    ["too long", `${"a".repeat(97)}.png`],
  ])("rejects %s", (_label, name) => {
    expect(assetFilenameSchema.safeParse(name).success).toBe(false);
  });
});

describe("markdownSchema", () => {
  it("rejects empty input", () => {
    expect(markdownSchema.safeParse("").success).toBe(false);
  });

  it("limits by UTF-8 bytes, not characters", () => {
    const chars = Math.floor(MAX_MARKDOWN_BYTES / 3) + 1;
    expect(markdownSchema.safeParse("あ".repeat(chars)).success).toBe(false);
  });
});

describe("templateNameSchema", () => {
  it("excludes the pfn brand template", () => {
    expect(templateNameSchema.safeParse("pfn").success).toBe(false);
  });
});

describe("documentTitleSchema", () => {
  it("trims and accepts ordinary titles, including HTML-like text (escaped later)", () => {
    expect(documentTitleSchema.parse("  技術書 <第1版> & 付録  ")).toBe("技術書 <第1版> & 付録");
  });

  it.each([
    ["empty", "   "],
    ["newline", "a\nb"],
    ["line separator", "a\u2028b"],
    ["control character", "a\u0007b"],
    ["too long", "a".repeat(201)],
  ])("rejects %s", (_, title) => {
    expect(documentTitleSchema.safeParse(title).success).toBe(false);
  });
});
