import { MAX_IMAGE_PIXELS } from "@awesome-pdf/shared-types";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { detectImageType, extensionMatches, processImage } from "./assets.ts";

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } } });
}

describe("processImage", () => {
  it.each([
    ["image/png", () => solid(4, 4).png().toBuffer()],
    ["image/jpeg", () => solid(4, 4).jpeg().toBuffer()],
    ["image/webp", () => solid(4, 4).webp().toBuffer()],
  ] as const)("re-encodes %s in the same format", async (type, make) => {
    const result = await processImage(await make(), type);
    expect(result.contentType).toBe(type);
    expect(detectImageType(result.data)).toBe(type);
  });

  it("strips EXIF metadata such as GPS location", async () => {
    const withExif = await solid(4, 4)
      .jpeg()
      .withExif({ IFD0: { Artist: "secret-person" }, IFD3: { GPSLatitudeRef: "N" } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const result = await processImage(withExif, "image/jpeg");

    expect((await sharp(result.data).metadata()).exif).toBeUndefined();
    expect(result.data.includes("secret-person")).toBe(false);
  });

  it("removes appended script payloads (polyglot)", async () => {
    const png = await solid(4, 4).png().toBuffer();
    const polyglot = Buffer.concat([png, Buffer.from("<script>alert(1)</script>")]);

    const result = await processImage(polyglot, "image/png");

    expect(result.data.includes("<script>")).toBe(false);
  });

  it("rejects a file whose signature does not match the declared type", async () => {
    const png = await solid(4, 4).png().toBuffer();
    await expect(processImage(png, "image/jpeg")).rejects.toThrow(/signature/);
  });

  it.each([
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["HTML", Buffer.from("<html><script>alert(1)</script></html>")],
    ["empty", Buffer.alloc(0)],
  ])("rejects %s disguised as an image", async (_, data) => {
    await expect(processImage(data, "image/png")).rejects.toThrow(/signature/);
  });

  it("rejects truncated images", async () => {
    const png = await solid(64, 64).png().toBuffer();
    await expect(processImage(png.subarray(0, 40), "image/png")).rejects.toThrow(/decoded/);
  });

  it("rejects decompression bombs before decoding", async () => {
    const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
    const bomb = await sharp({
      create: { width: side, height: side, channels: 3, background: { r: 0, g: 0, b: 0 } },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.byteLength).toBeLessThan(10 * 1024 * 1024);

    await expect(processImage(bomb, "image/png")).rejects.toThrow(/decoded/);
  });
});

describe("extensionMatches", () => {
  it("checks the safe name against the content type", () => {
    expect(extensionMatches("img-1.jpg", "image/jpeg")).toBe(true);
    expect(extensionMatches("img-1.jpeg", "image/jpeg")).toBe(true);
    expect(extensionMatches("img-1.png", "image/jpeg")).toBe(false);
    expect(extensionMatches("img-1", "image/png")).toBe(false);
  });
});
