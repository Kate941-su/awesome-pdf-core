import { readdir } from "node:fs/promises";
import path from "node:path";
import type { PdfJobPayload } from "@awesome-pdf/shared-types";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWatcher } from "./renderer/watcher.ts";
import type { Storage } from "./runner/s3.ts";
import { JobFailure, processPdfJob, type RunnerDeps } from "./runner/worker.ts";
import {
  fontNames,
  setupFakeRenderer,
  silentLogger,
  type FakeRendererEnv,
} from "./testing/fake-renderer.ts";

class FakeStorage implements Storage {
  readonly objects = new Map<string, Buffer | Error>();
  readonly outputs = new Map<string, Uint8Array>();
  readonly fetched: string[] = [];

  async getAsset(objectKey: string): Promise<Buffer> {
    this.fetched.push(objectKey);
    const value = this.objects.get(objectKey);
    if (value === undefined) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    if (value instanceof Error) throw value;
    return value;
  }

  async putOutput(objectKey: string, pdf: Uint8Array): Promise<void> {
    this.outputs.set(objectKey, pdf);
  }
}

let env: FakeRendererEnv;
let storage: FakeStorage;
let deps: RunnerDeps;
let stopRenderer: AbortController;
let renderer: Promise<void>;
let png: Buffer;

beforeEach(async () => {
  env = await setupFakeRenderer();
  storage = new FakeStorage();
  deps = {
    storage,
    handoffRoot: env.config.root,
    renderTimeoutMs: 10_000,
    log: silentLogger,
    pollMs: 10,
  };
  png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#c33" } })
    .png()
    .toBuffer();
  stopRenderer = new AbortController();
  renderer = runWatcher(env.config, silentLogger, stopRenderer.signal);
});

afterEach(async () => {
  stopRenderer.abort();
  await renderer;
  await env.cleanup();
});

function payload(overrides: Partial<PdfJobPayload> = {}): PdfJobPayload {
  return {
    jobId: crypto.randomUUID(),
    markdown: "# タイトル\n\n本文",
    title: "タイトル",
    template: "default",
    lang: "ja",
    watermark: false,
    assets: [],
    ...overrides,
  };
}

async function run(data: unknown) {
  const progress: number[] = [];
  const result = await processPdfJob(data, deps, async (p) => {
    progress.push(p);
  });
  return { result, progress };
}

async function failureCode(data: unknown): Promise<string> {
  try {
    await run(data);
  } catch (error) {
    if (error instanceof JobFailure) return error.code;
    throw error;
  }
  throw new Error("expected the job to fail");
}

async function handoffIsEmpty(): Promise<boolean> {
  for (const dir of ["inbox", "work", "outbox", "status"]) {
    if ((await readdir(path.join(env.config.root, dir))).length > 0) return false;
  }
  return true;
}

describe("processPdfJob", () => {
  it("renders, uploads the PDF and reports monotonic progress", async () => {
    storage.objects.set("u/draft/a.png", png);
    const job = payload({
      markdown: "![図](a.png)\n\n![未使用の参照](b.png)",
      assets: [
        { filename: "a.png", objectKey: "u/draft/a.png", contentType: "image/png" },
        { filename: "unused.png", objectKey: "u/draft/unused.png", contentType: "image/png" },
      ],
    });

    const { result, progress } = await run(job);

    expect(result).toEqual({
      outputKey: `${job.jobId}.pdf`,
      pageCount: 2,
      sizeBytes: env.fixture.byteLength,
    });
    expect(storage.outputs.get(`${job.jobId}.pdf`)).toEqual(Buffer.from(env.fixture));
    // 参照されていない画像は取得しない
    expect(storage.fetched).toEqual(["u/draft/a.png"]);
    expect(progress).toEqual(progress.toSorted((a, b) => a - b));
    expect(progress.at(-1)).toBe(100);
    expect(await handoffIsEmpty()).toBe(true);
  });

  it("watermarks free-plan jobs", async () => {
    const job = payload({ watermark: true });

    const { result } = await run(job);

    const pdf = storage.outputs.get(result.outputKey);
    if (!pdf) throw new Error("no output");
    const doc = await PDFDocument.load(pdf);
    expect(fontNames(doc, 0)).toContain("/Helvetica-Bold");
    expect(result.sizeBytes).toBe(pdf.byteLength);
  });

  it("rejects payloads that do not match the schema", async () => {
    expect(await failureCode({ jobId: "not-a-uuid" })).toBe("INVALID_INPUT");
  });

  it("rejects dangerous input before touching storage or the renderer", async () => {
    storage.objects.set("k", png);
    const job = payload({
      markdown: "![a](a.png) $\\href{javascript:alert(1)}{x}$",
      assets: [{ filename: "a.png", objectKey: "k", contentType: "image/png" }],
    });

    expect(await failureCode(job)).toBe("INVALID_INPUT");
    expect(storage.fetched).toEqual([]);
    expect(await handoffIsEmpty()).toBe(true);
  });

  it.each([
    ["is not an image", Buffer.from("<svg onload=alert(1)>")],
    ["does not match its declared type", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])],
  ])("fails with ASSET_INVALID when the stored file %s", async (_, data) => {
    storage.objects.set("k", data);
    const job = payload({
      markdown: "![a](a.png)",
      assets: [{ filename: "a.png", objectKey: "k", contentType: "image/png" }],
    });

    expect(await failureCode(job)).toBe("ASSET_INVALID");
  });

  it("fails with ASSET_INVALID when the stored file was deleted", async () => {
    const job = payload({
      markdown: "![a](a.png)",
      assets: [{ filename: "a.png", objectKey: "gone", contentType: "image/png" }],
    });
    expect(await failureCode(job)).toBe("ASSET_INVALID");
  });

  it("fails with ASSET_INVALID when the file extension and type disagree", async () => {
    storage.objects.set("k", png);
    const job = payload({
      markdown: "![a](a.png)",
      assets: [{ filename: "a.png", objectKey: "k", contentType: "image/jpeg" }],
    });
    expect(await failureCode(job)).toBe("ASSET_INVALID");
  });

  it("passes renderer failures through and cleans up", async () => {
    expect(await failureCode(payload({ markdown: "FAIL" }))).toBe("RENDER_FAILED");
    expect(await handoffIsEmpty()).toBe(true);
  });

  it("lets unexpected storage errors propagate so BullMQ can retry", async () => {
    storage.objects.set("k", new Error("ECONNRESET"));
    const job = payload({
      markdown: "![a](a.png)",
      assets: [{ filename: "a.png", objectKey: "k", contentType: "image/png" }],
    });

    await expect(run(job)).rejects.toThrow(/ECONNRESET/);
    expect(await handoffIsEmpty()).toBe(true);
  });
});
