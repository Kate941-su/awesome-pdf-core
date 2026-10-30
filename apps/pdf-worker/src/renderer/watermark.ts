import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

/**
 * 無料枠で生成した PDF の全ページにウォーターマークを入れる。
 * テンプレートに依存しないよう、pfpdf の出力後に PDF へ直接描画する。
 * 文字は PDF 標準フォント（埋め込み不要）で描けるラテン文字に限る。
 */

export const WATERMARK_TEXT = {
  diagonal: "FREE PLAN",
  footer: "Created with Awesome PDF - Free plan",
} as const;

const COLOR = rgb(0.5, 0.5, 0.5);

export interface FinalizedPdf {
  pdf: Uint8Array;
  pageCount: number;
}

/** ページ数を数え、必要ならウォーターマークを入れる。PDF として読めなければ例外 */
export async function finalizePdf(
  pdf: Uint8Array,
  options: { watermark: boolean },
): Promise<FinalizedPdf> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  if (!options.watermark) return { pdf, pageCount: doc.getPageCount() };
  await stampPages(doc);
  return { pdf: await doc.save(), pageCount: doc.getPageCount() };
}

async function stampPages(doc: PDFDocument): Promise<void> {
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();

    // 対角線に沿って中央に配置する
    const angle = Math.atan2(height, width);
    const diagonalSize = Math.min(width, height) / 6;
    const textWidth = font.widthOfTextAtSize(WATERMARK_TEXT.diagonal, diagonalSize);
    const textHeight = font.heightAtSize(diagonalSize, { descender: false });
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    page.drawText(WATERMARK_TEXT.diagonal, {
      x: width / 2 - (textWidth / 2) * cos + (textHeight / 2) * sin,
      y: height / 2 - (textWidth / 2) * sin - (textHeight / 2) * cos,
      size: diagonalSize,
      font,
      color: COLOR,
      opacity: 0.12,
      rotate: degrees((angle * 180) / Math.PI),
    });

    const footerSize = 7;
    const footerWidth = font.widthOfTextAtSize(WATERMARK_TEXT.footer, footerSize);
    page.drawText(WATERMARK_TEXT.footer, {
      x: (width - footerWidth) / 2,
      y: 8,
      size: footerSize,
      font,
      color: COLOR,
      opacity: 0.6,
    });
  }
}
