import { z } from "zod";
import {
  assetFilenameSchema,
  documentTitleSchema,
  documentLangSchema,
  imageContentTypeSchema,
  markdownSchema,
  templateNameSchema,
} from "./document.ts";

/** BullMQ のキュー名 */
export const PDF_QUEUE_NAME = "pdf-generation";

export const JOB_STATUSES = ["QUEUED", "PROCESSING", "COMPLETED", "FAILED"] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** ユーザーに返すエラー種別（内部の詳細は含めない） */
export const JOB_ERROR_CODES = [
  "INVALID_INPUT",
  "ASSET_INVALID",
  "RENDER_TIMEOUT",
  "RENDER_FAILED",
  "OUTPUT_TOO_LARGE",
  "INTERNAL",
] as const;
export const jobErrorCodeSchema = z.enum(JOB_ERROR_CODES);
export type JobErrorCode = z.infer<typeof jobErrorCodeSchema>;

/**
 * api-server → pdf-worker のジョブ payload。
 * ワーカーに不要な個人情報（userId 等）は含めない。
 */
export const pdfJobPayloadSchema = z.object({
  jobId: z.uuid(),
  markdown: markdownSchema,
  title: documentTitleSchema,
  template: templateNameSchema,
  lang: documentLangSchema,
  /** 無料枠で生成するジョブはウォーターマークを入れる */
  watermark: z.boolean(),
  assets: z.array(
    z.object({
      filename: assetFilenameSchema,
      objectKey: z.string().min(1),
      contentType: imageContentTypeSchema,
    }),
  ),
});
export type PdfJobPayload = z.infer<typeof pdfJobPayloadSchema>;

/** pdf-worker → api-server のジョブ結果（BullMQ の returnvalue） */
export const pdfJobResultSchema = z.object({
  outputKey: z.string().min(1),
  pageCount: z.int().nonnegative(),
  sizeBytes: z.int().nonnegative(),
});
export type PdfJobResult = z.infer<typeof pdfJobResultSchema>;

/** SSE で web に配信するイベント */
export const jobStreamEventSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("QUEUED") }),
  z.object({ status: z.literal("PROCESSING"), progress: z.int().min(0).max(100) }),
  z.object({ status: z.literal("COMPLETED") }),
  z.object({ status: z.literal("FAILED"), errorCode: jobErrorCodeSchema }),
]);
export type JobStreamEvent = z.infer<typeof jobStreamEventSchema>;
