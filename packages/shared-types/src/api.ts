import { z } from "zod";
import {
  assetFilenameSchema,
  documentTitleSchema,
  documentLangSchema,
  imageContentTypeSchema,
  markdownSchema,
  templateNameSchema,
} from "./document.ts";
import { jobErrorCodeSchema, jobStatusSchema } from "./jobs.ts";
import { MAX_IMAGE_BYTES } from "./limits.ts";

/** POST /api/assets/upload-url */
export const createUploadUrlRequestSchema = z.object({
  draftId: z.uuid(),
  filename: assetFilenameSchema,
  contentType: imageContentTypeSchema,
  sizeBytes: z.int().positive().max(MAX_IMAGE_BYTES),
});
export type CreateUploadUrlRequest = z.infer<typeof createUploadUrlRequestSchema>;

export const createUploadUrlResponseSchema = z.object({
  assetId: z.uuid(),
  uploadUrl: z.url(),
  /** 同名ファイルを置き換えた場合 true（web 側で事前に確認ダイアログを出す） */
  replaced: z.boolean(),
});
export type CreateUploadUrlResponse = z.infer<typeof createUploadUrlResponseSchema>;

/** GET /api/drafts/:draftId/assets */
export const draftAssetsResponseSchema = z.object({
  assets: z.array(
    z.object({
      assetId: z.uuid(),
      filename: assetFilenameSchema,
      contentType: imageContentTypeSchema,
      sizeBytes: z.int().positive(),
      previewUrl: z.url(),
    }),
  ),
});
export type DraftAssetsResponse = z.infer<typeof draftAssetsResponseSchema>;

/** POST /api/pdf-jobs （Idempotency-Key ヘッダー必須） */
export const createPdfJobRequestSchema = z.object({
  markdown: markdownSchema,
  /** 省略時は本文の最初の見出し（なければ「無題」/ "Untitled"） */
  title: documentTitleSchema.optional(),
  template: templateNameSchema,
  lang: documentLangSchema,
  draftId: z.uuid().optional(),
});
export type CreatePdfJobRequest = z.infer<typeof createPdfJobRequestSchema>;

export const createPdfJobResponseSchema = z.object({
  jobId: z.uuid(),
  creditsCharged: z.int().positive(),
});
export type CreatePdfJobResponse = z.infer<typeof createPdfJobResponseSchema>;

/** GET /api/pdf-jobs/:id/download */
export const downloadResponseSchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
export type DownloadResponse = z.infer<typeof downloadResponseSchema>;

/** GET /api/pdf-jobs — 保存期間内（24 時間）に作ったジョブの一覧（新しい順） */
export const RECENT_JOBS_LIMIT = 20;
export const pdfJobSummarySchema = z.object({
  jobId: z.uuid(),
  status: jobStatusSchema,
  template: templateNameSchema,
  creditsCharged: z.int().positive(),
  watermark: z.boolean(),
  errorCode: jobErrorCodeSchema.nullable(),
  createdAt: z.iso.datetime(),
  /** 完了したジョブの PDF が削除される時刻（未完了・失敗は null） */
  expiresAt: z.iso.datetime().nullable(),
});
export type PdfJobSummary = z.infer<typeof pdfJobSummarySchema>;
export const pdfJobListResponseSchema = z.object({ jobs: z.array(pdfJobSummarySchema) });
export type PdfJobListResponse = z.infer<typeof pdfJobListResponseSchema>;

/** GET /api/me/credits */
export const creditsResponseSchema = z.object({
  subscription: z.int().nonnegative(),
  package: z.int().nonnegative(),
  /** 今月の無料枠の残り（使うとウォーターマーク付き） */
  free: z.int().nonnegative(),
  /** 契約中のサブスクの lookup_key */
  plan: z.string().nullable(),
});
export type CreditsResponse = z.infer<typeof creditsResponseSchema>;

export const BILLING_CURRENCIES = ["eur", "usd", "jpy"] as const;

/** POST /api/billing/checkout */
export const checkoutRequestSchema = z.object({
  /** Stripe Price の lookup_key（サーバー側の許可リストで検証する） */
  lookupKey: z.string().min(1).max(64),
  /** 省略時は Stripe が顧客の地域から選ぶ */
  currency: z.enum(BILLING_CURRENCIES).optional(),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/** POST /api/billing/checkout, POST /api/billing/portal */
export const redirectResponseSchema = z.object({ url: z.url() });
export type RedirectResponse = z.infer<typeof redirectResponseSchema>;

/** 共通エラーレスポンス */
export const API_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "INSUFFICIENT_CREDITS",
  "UNRESOLVED_ASSETS",
  "IDEMPOTENCY_KEY_REQUIRED",
  "ALREADY_SUBSCRIBED",
  "NO_BILLING_ACCOUNT",
  "TOO_MANY_ASSETS",
  "OUTPUT_EXPIRED",
  /** 退会など重要な操作の前に、パスワードの再入力（再ログイン）が必要 */
  "REAUTHENTICATION_REQUIRED",
  "RATE_LIMITED",
  "INTERNAL",
] as const;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    /** UNRESOLVED_ASSETS の場合、未アップロードのファイル名一覧 */
    unresolvedAssets: z.array(z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
