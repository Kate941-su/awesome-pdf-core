import path from "node:path";
import { documentTitleSchema } from "@awesome-pdf/shared-types";
import { z } from "zod";

/**
 * runner ↔ renderer の受け渡し（仕様書 §5.1）。両者が共有してよいのはこのファイルだけ。
 *
 *   inbox/<jobId>.tmp/  runner が書き込み中
 *   inbox/<jobId>/      runner が書き終えた（アトミックにリネーム）: input.md, assets/, job.json
 *   work/<jobId>/       renderer が受信箱から取り出した（リネームで排他）
 *   outbox/<jobId>.tmp/ renderer が書き込み中
 *   outbox/<jobId>/     renderer が書き終えた: output.pdf + result.json または error.json
 *   status/<jobId>.json renderer の進捗
 */

export const HANDOFF_DIRS = ["inbox", "work", "outbox", "status"] as const;

export const INPUT_MARKDOWN = "input.md";
export const INPUT_ASSET_DIR = "assets";
export const JOB_MANIFEST = "job.json";
export const OUTPUT_PDF = "output.pdf";
export const OUTPUT_ERROR = "error.json";
export const OUTPUT_RESULT = "result.json";

/** renderer が pfpdf に与える期限 */
export const RENDER_TIMEOUT_MS = 120_000;
/** runner が renderer を待つ期限（キュー待ちと後処理の余裕を含む） */
export const RUNNER_WAIT_TIMEOUT_MS = RENDER_TIMEOUT_MS * 2 + 30_000;

/** 生成 PDF の上限サイズ */
export const MAX_OUTPUT_PDF_BYTES = 50 * 1024 * 1024;

export const jobIdSchema = z.uuid();

export const jobManifestSchema = z.object({
  jobId: jobIdSchema,
  title: documentTitleSchema,
  /** 無料枠で生成するジョブはウォーターマークを入れる */
  watermark: z.boolean(),
});
export type JobManifest = z.infer<typeof jobManifestSchema>;

export const RENDER_ERROR_CODES = [
  "RENDER_TIMEOUT",
  "RENDER_FAILED",
  "OUTPUT_TOO_LARGE",
  "INTERNAL",
] as const;
export const renderErrorSchema = z.object({ code: z.enum(RENDER_ERROR_CODES) });
export type RenderError = z.infer<typeof renderErrorSchema>;

/** 成果物の情報。runner（秘密情報あり）で PDF をパースしなくて済むよう renderer が書く */
export const renderResultSchema = z.object({
  pageCount: z.int().nonnegative(),
  sizeBytes: z.int().nonnegative(),
});
export type RenderResult = z.infer<typeof renderResultSchema>;

export const renderStatusSchema = z.object({ progress: z.int().min(0).max(100) });
export type RenderStatus = z.infer<typeof renderStatusSchema>;

export function handoffPaths(root: string, jobId: string) {
  // jobId は UUID のみ許可し、パス操作に使われる値を固定形式にする
  const id = jobIdSchema.parse(jobId);
  return {
    inboxTmp: path.join(root, "inbox", `${id}.tmp`),
    inbox: path.join(root, "inbox", id),
    work: path.join(root, "work", id),
    outboxTmp: path.join(root, "outbox", `${id}.tmp`),
    outbox: path.join(root, "outbox", id),
    status: path.join(root, "status", `${id}.json`),
  };
}
