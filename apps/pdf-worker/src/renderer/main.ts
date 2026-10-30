import { z } from "zod";
import { RENDER_TIMEOUT_MS } from "../shared/handoff.ts";
import { runWatcher, type Logger } from "./watcher.ts";

/**
 * renderer のエントリポイント。ネットワークなし・秘密情報なしのコンテナで動かす。
 * 受け取る環境変数はパスと並列数のみ。
 */

const env = z
  .object({
    HANDOFF_ROOT: z.string().default("/jobs"),
    RENDER_TMP: z.string().default("/tmp"),
    PFPDF_CLI: z.string().min(1),
    BROWSER_PATH: z.string().min(1).optional(),
    RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  })
  .parse(process.env);

// 1 行 1 JSON の構造化ログ。ユーザーの入力・生成物は fields に入れない
const log: Logger = {
  info: (event, fields) =>
    process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`),
  error: (event, fields) =>
    process.stderr.write(`${JSON.stringify({ level: "error", event, ...fields })}\n`),
};

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => controller.abort());
}

log.info("renderer.started", { concurrency: env.RENDER_CONCURRENCY });
await runWatcher(
  {
    root: env.HANDOFF_ROOT,
    tmpRoot: env.RENDER_TMP,
    command: {
      executable: process.execPath,
      args: [env.PFPDF_CLI],
      ...(env.BROWSER_PATH ? { browserPath: env.BROWSER_PATH } : {}),
    },
    timeoutMs: RENDER_TIMEOUT_MS,
    concurrency: env.RENDER_CONCURRENCY,
  },
  log,
  controller.signal,
);
log.info("renderer.stopped");
