import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimNext, renderJob, type RendererConfig } from "./renderer/watcher.ts";
import { runPfpdf } from "./renderer/pfpdf.ts";
import { cleanupJob, submitJob, sweepStale, waitForResult } from "./runner/handoff.ts";
import {
  fontNames,
  setupFakeRenderer,
  silentLogger,
  type FakeRendererEnv,
} from "./testing/fake-renderer.ts";

const silent = silentLogger;

let env: FakeRendererEnv;
let config: RendererConfig;
let fixture: Uint8Array;

beforeEach(async () => {
  env = await setupFakeRenderer();
  ({ config, fixture } = env);
});

afterEach(() => env.cleanup());

function jobId(): string {
  return crypto.randomUUID();
}

async function roundTrip(markdown: string, watermark = false, timeoutMs = 10_000) {
  const id = jobId();
  await submitJob(config.root, { jobId: id, title: "t", markdown, watermark, assets: new Map() });
  expect(await claimNext(config.root)).toBe(id);
  await renderJob({ ...config, timeoutMs }, id, silent);
  return { id, outcome: await waitForResult(config.root, id, { timeoutMs: 1000, pollMs: 10 }) };
}

describe("runner ↔ renderer handoff", () => {
  it("delivers the rendered PDF unchanged when no watermark is requested", async () => {
    const { outcome } = await roundTrip("PDF");

    if (!outcome.ok) throw new Error(outcome.code);
    expect(new Uint8Array(await readFile(outcome.pdfPath))).toEqual(fixture);
    expect(outcome.result).toEqual({ pageCount: 2, sizeBytes: fixture.byteLength });
  });

  it("stamps every page when a watermark is requested", async () => {
    const { outcome } = await roundTrip("PDF", true);

    if (!outcome.ok) throw new Error(outcome.code);
    const doc = await PDFDocument.load(await readFile(outcome.pdfPath));
    expect(doc.getPageCount()).toBe(2);
    for (const i of [0, 1]) expect(fontNames(doc, i)).toContain("/Helvetica-Bold");
  });

  it("copies uploaded assets and the manifest into the inbox atomically", async () => {
    const id = jobId();
    await submitJob(config.root, {
      jobId: id,
      title: "t",
      markdown: "x",
      watermark: true,
      assets: new Map([["img-1.png", Buffer.from("png")]]),
    });

    expect(await readdir(path.join(config.root, "inbox"))).toEqual([id]);
    const dir = path.join(config.root, "inbox", id);
    expect(JSON.parse(await readFile(path.join(dir, "job.json"), "utf8"))).toEqual({
      jobId: id,
      title: "t",
      watermark: true,
    });
    expect(await readFile(path.join(dir, "assets", "img-1.png"), "utf8")).toBe("png");
  });

  it("rejects asset names that escape the assets directory", async () => {
    await expect(
      submitJob(config.root, {
        jobId: jobId(),
        title: "t",
        markdown: "x",
        watermark: false,
        assets: new Map([["../job.json", Buffer.from("{}")]]),
      }),
    ).rejects.toThrow(/invalid asset name/);
  });

  it("reports RENDER_FAILED when pfpdf exits with an error", async () => {
    const { outcome } = await roundTrip("FAIL");
    expect(outcome).toEqual({ ok: false, code: "RENDER_FAILED" });
  });

  it("kills the whole process group on timeout", async () => {
    const id = jobId();
    await submitJob(config.root, {
      jobId: id,
      title: "t",
      markdown: "HANG",
      watermark: false,
      assets: new Map(),
    });
    await claimNext(config.root);

    // 一時ディレクトリは renderJob の終了時に消えるので、孫の PID は途中で読む
    let grandchild: number | undefined;
    const rendering = renderJob({ ...config, timeoutMs: 1500 }, id, silent);
    for (let i = 0; i < 100 && grandchild === undefined; i++) {
      await sleep(20);
      const [jobTmp] = await readdir(config.tmpRoot).then((e) =>
        e.filter((n) => n.startsWith("job-")),
      );
      if (!jobTmp) continue;
      const pid = await readFile(path.join(config.tmpRoot, jobTmp, "output.pdf.pid"), "utf8").catch(
        () => "",
      );
      if (pid) grandchild = Number(pid);
    }
    await rendering;

    expect(await waitForResult(config.root, id, { timeoutMs: 1000, pollMs: 10 })).toEqual({
      ok: false,
      code: "RENDER_TIMEOUT",
    });
    expect(grandchild).toBeDefined();
    await sleep(100);
    expect(() => process.kill(grandchild!, 0)).toThrow(/ESRCH/);
  });

  it("does not leak the caller's environment variables to pfpdf", async () => {
    process.env["TEST_SECRET_TOKEN"] = "do-not-leak";
    try {
      const work = await mkdtemp(path.join(config.tmpRoot, "env-"));
      const input = path.join(work, "input.md");
      const output = path.join(work, "env.json");
      await writeFile(input, "ENV");

      const result = await runPfpdf(config.command, {
        inputPath: input,
        title: "t",
        outputPath: output,
        workDir: work,
        timeoutMs: 5000,
      });

      expect(result.ok).toBe(true);
      const childEnv = JSON.parse(await readFile(output, "utf8")) as Record<string, string>;
      expect(childEnv["TEST_SECRET_TOKEN"]).toBeUndefined();
      // __CF_USER_TEXT_ENCODING は macOS が子プロセスに自動で付与する
      const keys = Object.keys(childEnv).filter((k) => k !== "__CF_USER_TEXT_ENCODING");
      expect(keys.toSorted()).toEqual(["HOME", "LANG", "PATH", "TMPDIR", "TZ"]);
      expect(childEnv["HOME"]).toBe(work);
    } finally {
      delete process.env["TEST_SECRET_TOKEN"];
    }
  });

  it("lets only one renderer claim a job", async () => {
    const id = jobId();
    await submitJob(config.root, {
      jobId: id,
      title: "t",
      markdown: "PDF",
      watermark: false,
      assets: new Map(),
    });

    const claims = await Promise.all(Array.from({ length: 5 }, () => claimNext(config.root)));

    expect(claims.filter((c) => c === id)).toHaveLength(1);
  });

  it("ignores jobs that are still being written", async () => {
    await mkdir(path.join(config.root, "inbox", `${jobId()}.tmp`));
    expect(await claimNext(config.root)).toBeNull();
  });

  it("times out when the renderer never answers", async () => {
    const outcome = await waitForResult(config.root, jobId(), { timeoutMs: 50, pollMs: 10 });
    expect(outcome).toEqual({ ok: false, code: "RENDER_TIMEOUT" });
  });

  it("cleans up all files of a job", async () => {
    const { id } = await roundTrip("PDF");
    await cleanupJob(config.root, id);
    for (const dir of ["inbox", "work", "outbox", "status"]) {
      expect(await readdir(path.join(config.root, dir))).toEqual([]);
    }
  });

  it("sweeps stale leftovers", async () => {
    const { id } = await roundTrip("PDF");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(config.root, "outbox", id), old, old);

    expect(await sweepStale(config.root, 60 * 60 * 1000)).toBeGreaterThanOrEqual(1);
    expect(await readdir(path.join(config.root, "outbox"))).toEqual([]);
  });
});
