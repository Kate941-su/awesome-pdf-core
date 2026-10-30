import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  HANDOFF_DIRS,
  INPUT_ASSET_DIR,
  INPUT_MARKDOWN,
  JOB_MANIFEST,
  OUTPUT_ERROR,
  OUTPUT_PDF,
  OUTPUT_RESULT,
  handoffPaths,
  renderErrorSchema,
  renderResultSchema,
  renderStatusSchema,
  type JobManifest,
  type RenderError,
  type RenderResult,
} from "../shared/handoff.ts";

export interface HandoffJob extends JobManifest {
  markdown: string;
  /** レンダラー上の安全なファイル名 → 検証・再エンコード済みの画像 */
  assets: ReadonlyMap<string, Buffer>;
}

export type RenderOutcome =
  { ok: true; pdfPath: string; result: RenderResult } | { ok: false; code: RenderError["code"] };

export async function ensureHandoffDirs(root: string): Promise<void> {
  for (const dir of HANDOFF_DIRS)
    await mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
}

/** 受信箱にジョブを置く。`.tmp` に書き終えてからリネームするので、renderer は書きかけを見ない */
export async function submitJob(root: string, job: HandoffJob): Promise<void> {
  const paths = handoffPaths(root, job.jobId);
  await rm(paths.inboxTmp, { recursive: true, force: true });
  await mkdir(path.join(paths.inboxTmp, INPUT_ASSET_DIR), { recursive: true, mode: 0o700 });
  await writeFile(path.join(paths.inboxTmp, INPUT_MARKDOWN), job.markdown, { mode: 0o600 });
  for (const [name, data] of job.assets) {
    if (path.basename(name) !== name) throw new Error(`invalid asset name ${name}`);
    await writeFile(path.join(paths.inboxTmp, INPUT_ASSET_DIR, name), data, { mode: 0o600 });
  }
  const manifest: JobManifest = { jobId: job.jobId, title: job.title, watermark: job.watermark };
  await writeFile(path.join(paths.inboxTmp, JOB_MANIFEST), JSON.stringify(manifest), {
    mode: 0o600,
  });
  await rename(paths.inboxTmp, paths.inbox);
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs?: number;
  onProgress?: (progress: number) => void | Promise<void>;
  signal?: AbortSignal;
}

/** レンダラーの結果を待つ。期限を過ぎたら RENDER_TIMEOUT */
export async function waitForResult(
  root: string,
  jobId: string,
  options: WaitOptions,
): Promise<RenderOutcome> {
  const paths = handoffPaths(root, jobId);
  const deadline = Date.now() + options.timeoutMs;
  let lastProgress = -1;

  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    if (await exists(paths.outbox)) {
      if (await exists(path.join(paths.outbox, OUTPUT_PDF))) {
        const result = renderResultSchema.safeParse(
          await readJson(path.join(paths.outbox, OUTPUT_RESULT)),
        );
        if (!result.success) return { ok: false, code: "INTERNAL" };
        return { ok: true, pdfPath: path.join(paths.outbox, OUTPUT_PDF), result: result.data };
      }
      const parsed = renderErrorSchema.safeParse(
        await readJson(path.join(paths.outbox, OUTPUT_ERROR)),
      );
      return { ok: false, code: parsed.success ? parsed.data.code : "INTERNAL" };
    }

    const status = renderStatusSchema.safeParse(await readJson(paths.status));
    if (status.success && status.data.progress !== lastProgress) {
      lastProgress = status.data.progress;
      await options.onProgress?.(lastProgress);
    }
    await sleep(options.pollMs ?? 250, undefined, { signal: options.signal });
  }
  return { ok: false, code: "RENDER_TIMEOUT" };
}

/** ジョブに関する受け渡しファイルをすべて消す（成果物アップロード後・失敗後） */
export async function cleanupJob(root: string, jobId: string): Promise<void> {
  const paths = handoffPaths(root, jobId);
  await Promise.all(
    [paths.inboxTmp, paths.inbox, paths.work, paths.outboxTmp, paths.outbox, paths.status].map(
      (p) => rm(p, { recursive: true, force: true }),
    ),
  );
}

/**
 * 一定時間より古い受け渡しファイルを消す。runner がタイムアウトで諦めた後に
 * renderer が書いた成果物や、クラッシュで残ったファイルを回収する。
 */
export async function sweepStale(root: string, maxAgeMs: number): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const dir of HANDOFF_DIRS) {
    const base = path.join(root, dir);
    for (const entry of await readdir(base).catch(() => [])) {
      const target = path.join(base, entry);
      const info = await stat(target).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await rm(target, { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null)) !== null;
}

async function readJson(p: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}
