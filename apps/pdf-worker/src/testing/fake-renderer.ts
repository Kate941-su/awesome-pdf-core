import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import type { Logger, RendererConfig } from "../renderer/watcher.ts";
import { ensureHandoffDirs } from "../runner/handoff.ts";

/**
 * テスト専用: pfpdf の代わりに使う CLI。入力 Markdown の内容で振る舞いを変える。
 *   FAIL  … 異常終了
 *   HANG  … 孫プロセスを作って終わらない（孫の PID を出力パス + .pid に書く）
 *   ENV   … 受け取った環境変数を出力に書く
 *   それ以外 … 入力が参照する assets/ の画像がすべて存在すればフィクスチャの PDF をコピー
 */
const FAKE_PFPDF = `
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const inputPath = arg("--input");
const input = fs.readFileSync(inputPath, "utf8");
const output = arg("--output");
if (input.includes("FAIL")) process.exit(3);
if (input.includes("ENV")) { fs.writeFileSync(output, JSON.stringify(process.env)); process.exit(0); }
if (input.includes("HANG")) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(output + ".pid", String(child.pid));
  setInterval(() => {}, 1000);
} else {
  for (const m of input.matchAll(/\\]\\((assets\\/[^)]+)\\)/g)) {
    if (!fs.existsSync(path.join(path.dirname(inputPath), m[1]))) process.exit(4);
  }
  fs.copyFileSync(process.env.HOME + "/../fixture.pdf", output);
}
`;

export const silentLogger: Logger = { info: () => undefined, error: () => undefined };

export interface FakeRendererEnv {
  base: string;
  config: RendererConfig;
  /** フェイク CLI が出力する 2 ページ（縦・横）の PDF */
  fixture: Uint8Array;
  cleanup(): Promise<void>;
}

export async function setupFakeRenderer(): Promise<FakeRendererEnv> {
  const base = await mkdtemp(path.join(tmpdir(), "pdf-worker-test-"));
  const root = path.join(base, "jobs");
  const tmpRoot = path.join(base, "tmp");
  await mkdir(tmpRoot);
  await ensureHandoffDirs(root);

  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([842, 595]);
  const fixture = await doc.save();
  // フェイク CLI は HOME（= tmpRoot/job-xxx）の親からフィクスチャを読む
  await writeFile(path.join(tmpRoot, "fixture.pdf"), fixture);
  await writeFile(path.join(base, "fake-pfpdf.cjs"), FAKE_PFPDF);

  return {
    base,
    fixture,
    config: {
      root,
      tmpRoot,
      command: { executable: process.execPath, args: [path.join(base, "fake-pfpdf.cjs")] },
      timeoutMs: 10_000,
      concurrency: 2,
      pollMs: 10,
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

/** ページに使われているフォント名（ウォーターマークの有無の確認用） */
export function fontNames(doc: PDFDocument, pageIndex: number): string[] {
  const fonts = doc.getPage(pageIndex).node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
  if (!fonts) return [];
  return fonts
    .values()
    .map((ref) => doc.context.lookup(ref, PDFDict).get(PDFName.of("BaseFont"))?.toString() ?? "");
}
