import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  INPUT_MARKDOWN,
  JOB_MANIFEST,
  MAX_OUTPUT_PDF_BYTES,
  OUTPUT_ERROR,
  OUTPUT_PDF,
  OUTPUT_RESULT,
  handoffPaths,
  jobIdSchema,
  jobManifestSchema,
  type RenderError,
  type RenderResult,
  type RenderStatus,
} from "../shared/handoff.ts";
import { runPfpdf, type PfpdfCommand } from "./pfpdf.ts";
import { finalizePdf, type FinalizedPdf } from "./watermark.ts";

export interface RendererConfig {
  /** 共有ボリューム（/jobs） */
  root: string;
  /** ジョブごとの一時ディレクトリを作る場所（tmpfs） */
  tmpRoot: string;
  command: PfpdfCommand;
  timeoutMs: number;
  concurrency: number;
  pollMs?: number;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * 受信箱から 1 件取り出す。work/ へのリネームで排他し、複数のレンダラーが
 * 同じジョブを処理しないようにする。
 */
export async function claimNext(root: string): Promise<string | null> {
  const entries = await readdir(path.join(root, "inbox")).catch(() => []);
  for (const entry of entries) {
    if (!jobIdSchema.safeParse(entry).success) continue; // .tmp（書き込み中）や不明なファイル
    const paths = handoffPaths(root, entry);
    try {
      await rename(paths.inbox, paths.work);
      return entry;
    } catch {
      // 他のレンダラーが先に取った
    }
  }
  return null;
}

/** 取り出したジョブを処理し、outbox に成果物かエラーを置く。例外は投げない */
export async function renderJob(config: RendererConfig, jobId: string, log: Logger): Promise<void> {
  const paths = handoffPaths(config.root, jobId);
  const tmp = await mkdtemp(path.join(config.tmpRoot, "job-"));
  const started = Date.now();
  try {
    const manifest = jobManifestSchema.parse(
      JSON.parse(await readFile(path.join(paths.work, JOB_MANIFEST), "utf8")),
    );
    if (manifest.jobId !== jobId) throw new Error("manifest job id mismatch");
    await writeStatus(config.root, jobId, { progress: 20 });

    const outputPath = path.join(tmp, OUTPUT_PDF);
    const result = await runPfpdf(config.command, {
      inputPath: path.join(paths.work, INPUT_MARKDOWN),
      title: manifest.title,
      outputPath,
      workDir: tmp,
      timeoutMs: config.timeoutMs,
    });
    if (!result.ok) return await finish(config.root, jobId, { code: result.code }, log, started);

    const size = (await stat(outputPath).catch(() => null))?.size;
    if (size === undefined)
      return await finish(config.root, jobId, { code: "RENDER_FAILED" }, log, started);
    if (size > MAX_OUTPUT_PDF_BYTES) {
      return await finish(config.root, jobId, { code: "OUTPUT_TOO_LARGE" }, log, started);
    }

    if (manifest.watermark) await writeStatus(config.root, jobId, { progress: 90 });
    const finalized = await finalizePdf(await readFile(outputPath), {
      watermark: manifest.watermark,
    }).catch(() => null);
    if (!finalized)
      return await finish(config.root, jobId, { code: "RENDER_FAILED" }, log, started);
    await finish(config.root, jobId, finalized, log, started);
  } catch (error) {
    log.error("render.internal_error", { jobId, error: errorName(error) });
    await finish(config.root, jobId, { code: "INTERNAL" }, log, started).catch(() => undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(paths.work, { recursive: true, force: true });
  }
}

/** outbox/<jobId>.tmp に書いてからリネームする */
async function finish(
  root: string,
  jobId: string,
  result: FinalizedPdf | RenderError,
  log: Logger,
  started: number,
): Promise<void> {
  const paths = handoffPaths(root, jobId);
  await rm(paths.outboxTmp, { recursive: true, force: true });
  await mkdir(paths.outboxTmp, { mode: 0o700 });
  if ("pdf" in result) {
    const meta: RenderResult = { pageCount: result.pageCount, sizeBytes: result.pdf.byteLength };
    await writeFile(path.join(paths.outboxTmp, OUTPUT_PDF), result.pdf, { mode: 0o600 });
    await writeFile(path.join(paths.outboxTmp, OUTPUT_RESULT), JSON.stringify(meta), {
      mode: 0o600,
    });
    await writeStatus(root, jobId, { progress: 100 });
  } else {
    await writeFile(path.join(paths.outboxTmp, OUTPUT_ERROR), JSON.stringify(result), {
      mode: 0o600,
    });
  }
  await rename(paths.outboxTmp, paths.outbox);
  log.info("render.finished", {
    jobId,
    ok: "pdf" in result,
    ...("pdf" in result ? {} : { code: result.code }),
    ms: Date.now() - started,
  });
}

async function writeStatus(root: string, jobId: string, status: RenderStatus): Promise<void> {
  const { status: target } = handoffPaths(root, jobId);
  await writeFile(`${target}.tmp`, JSON.stringify(status), { mode: 0o600 });
  await rename(`${target}.tmp`, target);
}

/** 受信箱を監視し、最大 concurrency 件を並行して処理する。signal で停止 */
export async function runWatcher(
  config: RendererConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  const running = new Set<Promise<void>>();
  while (!signal.aborted) {
    if (running.size < config.concurrency) {
      const jobId = await claimNext(config.root);
      if (jobId) {
        const task = renderJob(config, jobId, log).finally(() => running.delete(task));
        running.add(task);
        continue;
      }
    }
    await sleep(config.pollMs ?? 200, undefined, { signal }).catch(() => undefined);
  }
  await Promise.allSettled(running);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
