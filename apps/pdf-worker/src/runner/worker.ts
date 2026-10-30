import { readFile } from "node:fs/promises";
import {
  MAX_IMAGE_BYTES,
  PDF_QUEUE_NAME,
  pdfJobPayloadSchema,
  type JobErrorCode,
  type PdfJobPayload,
  type PdfJobResult,
} from "@awesome-pdf/shared-types";
import { UnrecoverableError, Worker } from "bullmq";
import { MAX_OUTPUT_PDF_BYTES } from "../shared/handoff.ts";
import { AssetError, extensionMatches, processImage } from "./assets.ts";
import { cleanupJob, submitJob, waitForResult } from "./handoff.ts";
import { AssetTooLargeError, type Storage } from "./s3.ts";
import { SanitizeError, sanitizeMarkdown } from "./sanitizer.ts";

/** 再試行しても結果が変わらない失敗。code はそのまま api-server に伝わる */
export class JobFailure extends Error {
  override name = "JobFailure";
  readonly code: JobErrorCode;

  constructor(code: JobErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface RunnerDeps {
  storage: Storage;
  handoffRoot: string;
  /** renderer の期限 + 余裕。これを過ぎたら RENDER_TIMEOUT */
  renderTimeoutMs: number;
  log: Logger;
  pollMs?: number;
}

export function outputKeyFor(jobId: string): string {
  return `${jobId}.pdf`;
}

/**
 * 1 件のジョブを処理する: 検証 → サニタイズ → 画像の取得・再エンコード → renderer へ受け渡し
 * → 成果物を R2 へ。ユーザーの入力・生成物はログに出さない。
 */
export async function processPdfJob(
  data: unknown,
  deps: RunnerDeps,
  onProgress: (progress: number) => Promise<void>,
): Promise<PdfJobResult> {
  const parsed = pdfJobPayloadSchema.safeParse(data);
  if (!parsed.success) throw new JobFailure("INVALID_INPUT");
  const payload = parsed.data;
  const started = Date.now();

  try {
    const sanitized = sanitize(payload);
    await onProgress(5);

    const assets = await loadAssets(payload, sanitized.assets, deps.storage);
    await onProgress(10);

    await submitJob(deps.handoffRoot, {
      jobId: payload.jobId,
      title: payload.title,
      markdown: sanitized.markdown,
      watermark: payload.watermark,
      assets,
    });
    await onProgress(15);

    const outcome = await waitForResult(deps.handoffRoot, payload.jobId, {
      timeoutMs: deps.renderTimeoutMs,
      ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
      onProgress: (p) => onProgress(15 + Math.floor(p * 0.75)),
    });
    if (!outcome.ok) throw new JobFailure(outcome.code);

    const pdf = await readFile(outcome.pdfPath);
    if (
      pdf.byteLength > MAX_OUTPUT_PDF_BYTES ||
      pdf.byteLength !== outcome.result.sizeBytes ||
      pdf.subarray(0, 5).toString("latin1") !== "%PDF-"
    ) {
      throw new JobFailure("INTERNAL");
    }
    const outputKey = outputKeyFor(payload.jobId);
    await deps.storage.putOutput(outputKey, pdf);
    await onProgress(100);

    deps.log.info("job.completed", { jobId: payload.jobId, ms: Date.now() - started });
    return { outputKey, pageCount: outcome.result.pageCount, sizeBytes: pdf.byteLength };
  } catch (error) {
    deps.log.error("job.failed", {
      jobId: payload.jobId,
      code: error instanceof JobFailure ? error.code : "UNEXPECTED",
      error: error instanceof Error ? error.name : "unknown",
      ms: Date.now() - started,
    });
    throw error;
  } finally {
    await cleanupJob(deps.handoffRoot, payload.jobId);
  }
}

function sanitize(payload: PdfJobPayload) {
  try {
    return sanitizeMarkdown({
      markdown: payload.markdown,
      template: payload.template,
      lang: payload.lang,
      assetFilenames: new Set(payload.assets.map((a) => a.filename)),
    });
  } catch (error) {
    if (error instanceof SanitizeError) throw new JobFailure("INVALID_INPUT");
    throw error;
  }
}

/** Markdown から参照された画像だけを取得し、検証・再エンコードする */
async function loadAssets(
  payload: PdfJobPayload,
  referenced: ReadonlyMap<string, string>,
  storage: Storage,
): Promise<Map<string, Buffer>> {
  const byName = new Map(payload.assets.map((a) => [a.filename, a]));
  const result = new Map<string, Buffer>();
  for (const [filename, safeName] of referenced) {
    const asset = byName.get(filename);
    if (!asset || !extensionMatches(safeName, asset.contentType)) {
      throw new JobFailure("ASSET_INVALID");
    }
    try {
      const raw = await storage.getAsset(asset.objectKey, MAX_IMAGE_BYTES);
      result.set(safeName, (await processImage(raw, asset.contentType)).data);
    } catch (error) {
      if (
        error instanceof AssetError ||
        error instanceof AssetTooLargeError ||
        (error instanceof Error && error.name === "NoSuchKey")
      ) {
        throw new JobFailure("ASSET_INVALID");
      }
      throw error;
    }
  }
  return result;
}

export interface WorkerOptions {
  redisUrl: string;
  concurrency: number;
}

/** BullMQ の Worker を起動する。JobFailure は再試行しない（UnrecoverableError） */
export function createPdfWorker(
  options: WorkerOptions,
  deps: RunnerDeps,
): Worker<unknown, PdfJobResult> {
  return new Worker<unknown, PdfJobResult>(
    PDF_QUEUE_NAME,
    async (job) => {
      try {
        return await processPdfJob(job.data, deps, (p) => job.updateProgress(p));
      } catch (error) {
        if (error instanceof JobFailure) throw new UnrecoverableError(error.code);
        throw error;
      }
    },
    {
      connection: { url: options.redisUrl },
      concurrency: options.concurrency,
      // payload にはユーザーの Markdown が含まれるため、処理後は早めに Redis から消す
      removeOnComplete: { age: 10 * 60 },
      removeOnFail: { age: 60 * 60 },
    },
  );
}
