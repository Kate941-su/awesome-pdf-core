import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * R2 の入出力。runner だけが使う（renderer にはネットワークも認証情報もない）。
 * トークンは「アップロード画像の読み取り」と「生成 PDF の書き込み」に限定したものを使う。
 */

export interface Storage {
  /** アップロード画像を読む。maxBytes を超えたら途中で打ち切って例外 */
  getAsset(objectKey: string, maxBytes: number): Promise<Buffer>;
  putOutput(objectKey: string, pdf: Uint8Array): Promise<void>;
}

export class AssetTooLargeError extends Error {
  override name = "AssetTooLargeError";
}

export interface R2Config {
  accountId: string;
  jurisdiction: "eu" | "fedramp" | "default";
  accessKeyId: string;
  secretAccessKey: string;
  uploadsBucket: string;
  outputsBucket: string;
}

export function r2Endpoint(accountId: string, jurisdiction: R2Config["jurisdiction"]): string {
  const sub = jurisdiction === "default" ? accountId : `${accountId}.${jurisdiction}`;
  return `https://${sub}.r2.cloudflarestorage.com`;
}

export function createR2Storage(config: R2Config): Storage {
  const client = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(config.accountId, config.jurisdiction),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  return {
    async getAsset(objectKey, maxBytes) {
      const res = await client.send(
        new GetObjectCommand({ Bucket: config.uploadsBucket, Key: objectKey }),
      );
      if ((res.ContentLength ?? 0) > maxBytes) throw new AssetTooLargeError(objectKey);
      if (!res.Body) throw new Error(`empty body for ${objectKey}`);
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of res.Body.transformToWebStream()) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new AssetTooLargeError(objectKey);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },

    async putOutput(objectKey, pdf) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.outputsBucket,
          Key: objectKey,
          Body: pdf,
          ContentType: "application/pdf",
          // ブラウザで開かずダウンロードさせる（PDF 内の JavaScript 等を同一オリジンで実行させない）
          ContentDisposition: "attachment",
        }),
      );
    },
  };
}
