import { z } from "zod";
import { RUNNER_WAIT_TIMEOUT_MS } from "../shared/handoff.ts";
import { ensureHandoffDirs, sweepStale } from "./handoff.ts";
import { createR2Storage } from "./s3.ts";
import { createPdfWorker, type Logger } from "./worker.ts";

/** runner のエントリポイント（Redis・R2 に接続する唯一のコンテナ） */

const env = z
  .object({
    REDIS_URL: z.url(),
    R2_ACCOUNT_ID: z.string().min(1),
    R2_JURISDICTION: z.enum(["eu", "fedramp", "default"]),
    R2_BUCKET_UPLOADS: z.string().min(1),
    R2_BUCKET_OUTPUTS: z.string().min(1),
    RUNNER_R2_ACCESS_KEY_ID: z.string().min(1),
    RUNNER_R2_SECRET_ACCESS_KEY: z.string().min(1),
    HANDOFF_ROOT: z.string().default("/jobs"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  })
  .parse(process.env);

// 1 行 1 JSON の構造化ログ。ユーザーの入力・生成物は fields に入れない
const log: Logger = {
  info: (event, fields) =>
    process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`),
  error: (event, fields) =>
    process.stderr.write(`${JSON.stringify({ level: "error", event, ...fields })}\n`),
};

const STALE_AFTER_MS = 60 * 60 * 1000;

await ensureHandoffDirs(env.HANDOFF_ROOT);

const worker = createPdfWorker(
  { redisUrl: env.REDIS_URL, concurrency: env.WORKER_CONCURRENCY },
  {
    storage: createR2Storage({
      accountId: env.R2_ACCOUNT_ID,
      jurisdiction: env.R2_JURISDICTION,
      accessKeyId: env.RUNNER_R2_ACCESS_KEY_ID,
      secretAccessKey: env.RUNNER_R2_SECRET_ACCESS_KEY,
      uploadsBucket: env.R2_BUCKET_UPLOADS,
      outputsBucket: env.R2_BUCKET_OUTPUTS,
    }),
    handoffRoot: env.HANDOFF_ROOT,
    renderTimeoutMs: RUNNER_WAIT_TIMEOUT_MS,
    log,
  },
);
worker.on("error", (error) => log.error("worker.error", { error: error.name }));

const sweeper = setInterval(
  () => {
    sweepStale(env.HANDOFF_ROOT, STALE_AFTER_MS)
      .then((removed) => removed > 0 && log.info("handoff.swept", { removed }))
      .catch((error: unknown) =>
        log.error("handoff.sweep_failed", {
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
  },
  10 * 60 * 1000,
);

log.info("runner.started", { concurrency: env.WORKER_CONCURRENCY });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    clearInterval(sweeper);
    worker
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
