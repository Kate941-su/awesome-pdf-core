/** 入力・アセット・クレジットに関する上限値と閾値（api-server / pdf-worker / web で共通） */

export const MAX_MARKDOWN_BYTES = 512 * 1024;

export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export const IMAGE_EXTENSIONS: Record<AllowedImageType, readonly string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
};

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_ASSETS_PER_DRAFT = 50;
export const MAX_ASSET_FILENAME_LENGTH = 100;

/** 生成 PDF の保持時間（R2 ライフサイクルと一致させる） */
export const OUTPUT_RETENTION_HOURS = 24;
/** アップロード画像の保持日数（最終更新から） */
export const ASSET_RETENTION_DAYS = 7;

/** 署名付き URL の有効期限 */
export const UPLOAD_URL_TTL_SECONDS = 5 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 10 * 60;

/**
 * クレジット算出ルール（docs/decisions.md 2026-10-29）
 * 基本 1 点。数式 > mathBlocks または Mermaid >= mermaidBlocks で +1、
 * 画像 > images または入力 > markdownBytes で +1。上限 max 点。
 */
export const CREDIT_RULES = {
  base: 1,
  max: 3,
  heavyContent: { mathBlocks: 10, mermaidBlocks: 1 },
  largeInput: { images: 5, markdownBytes: 100 * 1024 },
} as const;

/**
 * 無料枠（docs/decisions.md 2026-10-29）。メール確認済みのアカウントに毎月付与し、
 * 無料枠を 1 点でも使った PDF にはウォーターマークを入れる。
 */
export const FREE_MONTHLY_CREDITS = 5;

/** 退会などの前に求める再ログインの有効期間（ログインからこの秒数以内のトークンのみ受け付ける） */
export const REAUTHENTICATION_MAX_AGE_SECONDS = 10 * 60;

/** Markdown の構造上限（pdf-worker のサニタイザーで強制。api-server の事前チェックにも使える） */
export const MARKDOWN_STRUCTURE_LIMITS = {
  /** ノードの入れ子の深さ（リスト・引用の多重ネストによる DoS 対策） */
  maxDepth: 32,
  maxMathNodes: 1000,
  maxMermaidBlocks: 30,
  maxImageNodes: 200,
} as const;

/**
 * 数式中で禁止する TeX コマンド（`\` を除いた名前）。pdf-worker のサニタイザーが強制し、
 * web のプレビューは同じ一覧で事前に警告する。
 * MathJax（pfpdf は全拡張パッケージを有効化している）で HTML 属性・CSS・リンク・
 * 外部読み込み・マクロ定義につながるもの。マクロ定義を禁止するのは、
 * 禁止コマンドを別名で組み立てられないようにするため。
 */
export const FORBIDDEN_TEX_COMMANDS = [
  "href",
  "url",
  "style",
  "class",
  "cssId",
  "data",
  "require",
  "unicode",
  "bbox",
  "enclose",
  "mmlToken",
  "def",
  "gdef",
  "edef",
  "xdef",
  "let",
  "futurelet",
  "newcommand",
  "renewcommand",
  "providecommand",
  "newenvironment",
  "renewenvironment",
  "DeclareMathOperator",
  "csname",
  "expandafter",
  "input",
  "include",
] as const;
