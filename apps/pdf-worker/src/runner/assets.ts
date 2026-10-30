import {
  ALLOWED_IMAGE_TYPES,
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  type AllowedImageType,
} from "@awesome-pdf/shared-types";
import sharp from "sharp";

/**
 * アップロード画像の検証と再エンコード（仕様書 §5.3）。
 * 宣言された形式とマジックバイトの一致を確かめ、sharp でデコードし直して書き出すことで
 * EXIF（位置情報等）を除去し、画像に埋め込まれたスクリプト等のポリグロットを無害化する。
 */

export class AssetError extends Error {
  override name = "AssetError";
}

export interface ProcessedImage {
  data: Buffer;
  contentType: AllowedImageType;
}

const SIGNATURES: Record<AllowedImageType, (b: Buffer) => boolean> = {
  "image/png": (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  "image/webp": (b) =>
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP",
};

export function detectImageType(data: Buffer): AllowedImageType | null {
  for (const type of ALLOWED_IMAGE_TYPES) {
    if (SIGNATURES[type](data)) return type;
  }
  return null;
}

/** レンダラーに渡すファイル名（`img-1.png` 等）の拡張子が形式と一致するか */
export function extensionMatches(safeName: string, contentType: AllowedImageType): boolean {
  const ext = /\.[a-z]+$/.exec(safeName)?.[0];
  return ext !== undefined && IMAGE_EXTENSIONS[contentType].includes(ext);
}

export async function processImage(
  data: Buffer,
  declaredType: AllowedImageType,
): Promise<ProcessedImage> {
  if (data.byteLength > MAX_IMAGE_BYTES) throw new AssetError("image too large");
  const detected = detectImageType(data);
  if (detected !== declaredType) throw new AssetError("image signature does not match its type");

  try {
    // limitInputPixels でデコード前にピクセル数を検査する（デコンプレッション爆弾対策）。
    // rotate() は EXIF の向きを画素に反映してから、メタデータごと捨てる。
    const image = sharp(data, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: "error",
      animated: false,
    }).rotate();
    const output =
      declaredType === "image/png"
        ? image.png({ compressionLevel: 9 })
        : declaredType === "image/jpeg"
          ? image.jpeg({ quality: 90, mozjpeg: true })
          : image.webp({ quality: 90 });
    return { data: await output.toBuffer(), contentType: declaredType };
  } catch (error) {
    throw new AssetError("image could not be decoded", { cause: error });
  }
}
