import { MARKDOWN_STRUCTURE_LIMITS } from "@awesome-pdf/shared-types";
import { describe, expect, it } from "vitest";
import { assertSafeTex, sanitizeMarkdown, type SanitizeInput } from "./sanitizer.ts";

function sanitize(markdown: string, assets: string[] = []) {
  const input: SanitizeInput = {
    markdown,
    template: "default",
    lang: "ja",
    assetFilenames: new Set(assets),
  };
  return sanitizeMarkdown(input);
}

/** front matter を除いた本文 */
function body(markdown: string, assets: string[] = []): string {
  return sanitize(markdown, assets).markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, "");
}

describe("sanitizeMarkdown", () => {
  it("keeps ordinary Japanese Markdown, GFM, math and mermaid", () => {
    const source = [
      "# 見出し",
      "",
      "**太字**と`コード`。",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "- [x] 完了",
      "",
      "$E = mc^2$",
      "",
      "$$",
      "\\int_0^1 x\\,dx",
      "$$",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
    ].join("\n");

    const out = body(source);

    expect(out).toContain("# 見出し");
    expect(out).toContain("**太字**");
    expect(out).toContain("| a | b |");
    expect(out).toContain("- [x] 完了");
    expect(out).toContain("$E = mc^2$");
    expect(out).toContain("\\int_0^1 x\\,dx");
    expect(out).toContain("```mermaid\ngraph TD; A-->B\n```");
  });

  it("generates the front matter from allow-listed values only", () => {
    const { markdown } = sanitizeMarkdown({
      markdown: "本文",
      template: "academic",
      lang: "en",
      assetFilenames: new Set(),
    });
    expect(markdown.startsWith("---\ntemplate: academic\nlang: en\n---\n")).toBe(true);
  });

  describe("raw HTML (XSS)", () => {
    it.each([
      ["script block", "<script>alert(1)</script>"],
      ["style block", "<style>@import url(http://evil.example/x.css)</style>"],
      ["iframe", '<iframe src="http://169.254.169.254/latest/meta-data/"></iframe>'],
      ["event handler", '<img src=x onerror="alert(1)">'],
      ["inline tag", "text <svg onload=alert(1)> more"],
      ["link stylesheet", '<link rel="stylesheet" href="file:///etc/passwd">'],
      ["object", '<object data="file:///etc/passwd"></object>'],
      ["comment", "<!-- <script>alert(1)</script> -->"],
      ["processing instruction", "<?php system('id'); ?>"],
      ["cdata", "<![CDATA[<script>alert(1)</script>]]>"],
    ])("removes %s", (_, payload) => {
      const out = body(`前\n\n${payload}\n\n後`);
      expect(out).not.toMatch(/<\s*(script|style|iframe|img|svg|link|object)/i);
      expect(out).not.toMatch(/<[!?]/);
      expect(out).toContain("前");
      expect(out).toContain("後");
    });

    it("escapes HTML built from entities so it stays text", () => {
      const out = body("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(out).not.toMatch(/(?<!\\)<script/i);
    });

    it("does not let escaped angle brackets become HTML after re-serialization", () => {
      const out = body("\\<script>alert(1)\\</script>");
      expect(out).not.toMatch(/(?<!\\)<script/i);
    });

    it("treats full-width look-alikes as plain text", () => {
      expect(body("＜script＞alert(1)＜/script＞")).toContain("＜script＞");
    });
  });

  describe("front matter injection", () => {
    it("drops the user's YAML front matter", () => {
      const out = sanitize(
        "---\ntemplate: pfn\nlogo: /etc/passwd\nbibliography: /etc/passwd.bib\n---\n\n本文",
      ).markdown;
      expect(out).not.toContain("pfn");
      expect(out).not.toContain("/etc/passwd");
      expect(out.match(/^---$/gm)).toHaveLength(2);
    });

    it("cannot smuggle YAML through a thematic break after the generated front matter", () => {
      const out = sanitize("---\n\nlogo: /etc/passwd\n\n---\n\n本文").markdown;
      const [, frontMatter] = /^---\n([\s\S]*?)\n---\n/.exec(out) ?? [];
      expect(frontMatter).toBe("template: default\nlang: ja");
    });
  });

  describe("links", () => {
    it.each([
      ["https", "https://example.com/a?b=c"],
      ["http", "http://example.com"],
      ["mailto", "mailto:a@example.com"],
      ["anchor", "#section-1"],
    ])("keeps %s links", (_, url) => {
      expect(body(`[x](${url})`)).toContain(`[x](${url})`);
    });

    it.each([
      ["javascript", "javascript:alert(1)"],
      ["javascript with entities", "jav&#x61;script:alert(1)"],
      ["javascript with mixed case", "JaVaScRiPt:alert(1)"],
      ["javascript with tab", "java%09script:alert(1)"],
      ["file", "file:///etc/passwd"],
      ["data", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
      ["vbscript", "vbscript:msgbox(1)"],
      ["relative path", "../../etc/passwd"],
      ["absolute path", "/etc/passwd"],
    ])("unwraps %s links but keeps the text", (_, url) => {
      const out = body(`[テキスト](${url})`);
      expect(out.trim()).toBe("テキスト");
    });

    it("checks reference-style links against their definition", () => {
      const out = body("[ok][a] [bad][b]\n\n[a]: https://example.com\n[b]: javascript:alert(1)");
      expect(out).toContain("[ok](https://example.com)");
      expect(out).not.toContain("javascript");
      expect(out).toContain("bad");
    });

    it("unwraps autolinks with forbidden protocols", () => {
      expect(body("<file:///etc/passwd>")).not.toContain("](file:");
    });

    it("drops link titles", () => {
      expect(body('[x](https://example.com "title")')).toBe("[x](https://example.com)\n");
    });
  });

  describe("images (LFI / SSRF)", () => {
    it("rewrites uploaded images to safe names", () => {
      const result = sanitize("![図](<図 1.png>)\n\n![b](photo.JPG)\n\n![again](図%201.png)", [
        "図 1.png",
        "photo.JPG",
      ]);
      expect(result.assets).toEqual(
        new Map([
          ["図 1.png", "img-1.png"],
          ["photo.JPG", "img-2.jpg"],
        ]),
      );
      expect(result.markdown).toContain("![図](assets/img-1.png)");
      expect(result.markdown).toContain("![b](assets/img-2.jpg)");
      expect(result.markdown).toContain("![again](assets/img-1.png)");
    });

    it.each([
      ["remote URL", "http://169.254.169.254/latest/meta-data/"],
      ["remote https", "https://evil.example/track.png"],
      ["file URL", "file:///etc/passwd"],
      ["absolute path", "/etc/passwd"],
      ["traversal", "../../../etc/passwd"],
      ["traversal to an uploaded name", "../a.png"],
      ["subdirectory", "assets/a.png"],
      ["data URL", "data:image/png;base64,iVBORw0KGgo="],
      ["unuploaded name", "b.png"],
    ])("removes %s images", (_, url) => {
      const result = sanitize(`前 ![x](${url}) 後`, ["a.png"]);
      expect(result.markdown).not.toContain("![");
      expect(result.assets.size).toBe(0);
    });

    it("resolves reference-style images only to uploaded files", () => {
      const result = sanitize("![a][ok] ![b][bad]\n\n[ok]: a.png\n[bad]: /etc/passwd", ["a.png"]);
      expect(result.markdown).toContain("![a](assets/img-1.png)");
      expect(result.markdown).not.toContain("/etc/passwd");
    });

    it("drops image titles", () => {
      expect(body('![x](a.png "t")', ["a.png"])).toBe("![x](assets/img-1.png)\n");
    });
  });

  describe("code blocks", () => {
    it("drops code fence meta and suspicious languages", () => {
      const out = body('```js title="x" file=/etc/passwd\nconsole.log(1)\n```\n\n```a"b\nx\n```');
      expect(out).toContain("```js\nconsole.log(1)\n```");
      expect(out).not.toContain("/etc/passwd");
      expect(out).not.toContain('a"b');
    });

    it("keeps HTML inside code as code", () => {
      const out = body("```html\n<script>alert(1)</script>\n```");
      expect(out).toContain("```html\n<script>alert(1)</script>\n```");
    });
  });

  describe("math", () => {
    it.each([
      ["\\href", "$\\href{javascript:alert(1)}{x}$"],
      ["\\style", "$$\n\\style{background:url(file:///etc/passwd)}{x}\n$$"],
      ["\\class", "$\\class{x}{y}$"],
      ["\\require", "$\\require{html}$"],
      ["\\def", "$\\def\\h{\\hr}\\h ef{x}{y}$"],
      ["\\newcommand", "$\\newcommand{\\x}{y}$"],
      ["\\bbox", "$\\bbox[background:url(x)]{y}$"],
      ["\\unicode", "$\\unicode[Arial]{x41}$"],
    ])("rejects %s", (_, source) => {
      expect(() => sanitize(source)).toThrow(/FORBIDDEN_TEX_COMMAND/);
    });
  });

  describe("limits", () => {
    it("rejects excessive nesting", () => {
      const nested = Array.from({ length: MARKDOWN_STRUCTURE_LIMITS.maxDepth + 2 }, () => ">")
        .join(" ")
        .concat(" x");
      expect(() => sanitize(nested)).toThrow(/TOO_DEEP/);
    });

    it("rejects too many mermaid blocks", () => {
      const block = "```mermaid\ngraph TD; A-->B\n```\n\n";
      expect(() => sanitize(block.repeat(MARKDOWN_STRUCTURE_LIMITS.maxMermaidBlocks + 1))).toThrow(
        /TOO_MANY_MERMAID/,
      );
    });

    it("rejects too many math nodes", () => {
      expect(() => sanitize("$x$ ".repeat(MARKDOWN_STRUCTURE_LIMITS.maxMathNodes + 1))).toThrow(
        /TOO_MANY_MATH/,
      );
    });

    it("rejects oversized input", () => {
      expect(() => sanitize("a".repeat(600 * 1024))).toThrow(/TOO_LARGE/);
    });
  });
});

describe("assertSafeTex", () => {
  it("allows ordinary TeX", () => {
    expect(() =>
      assertSafeTex("\\frac{a}{b} \\\\ \\textbf{x} \\color{red}{y} \\operatorname{f}"),
    ).not.toThrow();
  });

  it("is not fooled by a preceding escaped backslash", () => {
    // \\href は「改行 + href という文字列」なので許可される
    expect(() => assertSafeTex("a \\\\href b")).not.toThrow();
    expect(() => assertSafeTex("a \\\\\\href b")).toThrow(/FORBIDDEN_TEX_COMMAND/);
  });
});
