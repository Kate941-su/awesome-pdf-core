import { describe, expect, it } from "vitest";
import { escapeTitle, pfpdfArgs } from "./pfpdf.ts";

describe("pfpdfArgs", () => {
  const command = {
    executable: "node",
    args: ["/pfpdf/launcher.js"],
    browserPath: "/usr/bin/chromium",
  };
  const options = {
    inputPath: "/jobs/work/x/input.md",
    outputPath: "/tmp/job/output.pdf",
    workDir: "/tmp/job",
    timeoutMs: 120_000,
  };

  it("passes the title as a separate, escaped argument", () => {
    const args = pfpdfArgs(command, { ...options, title: "--browser-path /bin/sh <b>&" });
    const i = args.indexOf("--title");
    expect(args[i + 1]).toBe("--browser-path /bin/sh &lt;b&gt;&amp;");
    // 本物の --browser-path は 1 つだけ（タイトルで上書きされない）
    expect(args.filter((a) => a === "--browser-path")).toHaveLength(1);
    expect(args.at(-1)).toBe("/usr/bin/chromium");
  });

  it("disables the logo and keeps pfpdf's own deadline below the kill timeout", () => {
    const args = pfpdfArgs(command, { ...options, title: "t" });
    expect(args).toContain("--no-logo");
    expect(Number(args[args.indexOf("--render-timeout-ms") + 1])).toBeLessThan(options.timeoutMs);
  });
});

describe("escapeTitle", () => {
  it("escapes ampersands first so existing references stay literal", () => {
    expect(escapeTitle("&lt;script&gt; <br>")).toBe("&amp;lt;script&amp;gt; &lt;br&gt;");
  });
});
