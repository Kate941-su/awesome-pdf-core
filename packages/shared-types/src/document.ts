import { z } from "zod";
import {
  ALLOWED_IMAGE_TYPES,
  IMAGE_EXTENSIONS,
  MAX_ASSET_FILENAME_LENGTH,
  MAX_MARKDOWN_BYTES,
} from "./limits.ts";

/**
 * pfpdf 同梱テンプレートのうち提供するもの。
 * `pfn` は Preferred Networks 社のブランドデザインのため除外（docs/decisions.md）。
 */
export const TEMPLATE_NAMES = [
  "default",
  "academic",
  "book",
  "compact",
  "notebook",
  "technical",
] as const;
export const templateNameSchema = z.enum(TEMPLATE_NAMES);
export type TemplateName = z.infer<typeof templateNameSchema>;

/** 文書の言語（組版用。UI ロケールとは別） */
export const DOCUMENT_LANGS = ["ja", "en"] as const;
export const documentLangSchema = z.enum(DOCUMENT_LANGS);
export type DocumentLang = z.infer<typeof documentLangSchema>;

/** 文書タイトル（PDF の表紙・メタデータに入る）。改行・制御文字は不可 */
export const MAX_TITLE_LENGTH = 200;
export const documentTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TITLE_LENGTH)
  .refine((s) => !/[\p{Cc}\u2028\u2029]/u.test(s), {
    message: "title must not contain line breaks or control characters",
  });

export const markdownSchema = z
  .string()
  .min(1)
  .refine((s) => new TextEncoder().encode(s).byteLength <= MAX_MARKDOWN_BYTES, {
    message: `markdown must be at most ${MAX_MARKDOWN_BYTES} bytes`,
  });

export const imageContentTypeSchema = z.enum(ALLOWED_IMAGE_TYPES);

const ALL_IMAGE_EXTENSIONS = Object.values(IMAGE_EXTENSIONS).flat();

/**
 * Markdown から参照されるアップロード画像のファイル名。
 * パス区切り・制御文字・先頭ドット・NFC 以外の正規化形を拒否する。
 */
export const assetFilenameSchema = z
  .string()
  .min(1)
  .max(MAX_ASSET_FILENAME_LENGTH)
  .refine((s) => s === s.normalize("NFC"), { message: "filename must be NFC-normalized" })
  .refine((s) => !/[/\\\p{Cc}\p{Cf}]/u.test(s), {
    message: "filename must not contain path separators or control characters",
  })
  .refine((s) => !s.startsWith(".") && s.trim() === s, {
    message: "filename must not start with a dot or have surrounding whitespace",
  })
  .refine((s) => ALL_IMAGE_EXTENSIONS.some((ext) => s.toLowerCase().endsWith(ext)), {
    message: "filename must have an allowed image extension",
  });
