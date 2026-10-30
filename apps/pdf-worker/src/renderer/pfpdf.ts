import { spawn } from "node:child_process";

/**
 * pfpdf CLI の起動（仕様書 §5.4）。pfpdf はサンドボックスではないため、
 * 引数配列 + shell なし、最小限の環境変数、プロセスグループ単位のタイムアウトで実行する。
 */

export interface PfpdfCommand {
  /** 実行ファイル（通常は node） */
  executable: string;
  /** 実行ファイルに渡す先頭の引数（通常は pfpdf の CLI スクリプトのパス） */
  args: readonly string[];
  /** Chromium の実行ファイル（イメージに同梱） */
  browserPath?: string;
}

export interface RunPfpdfOptions {
  inputPath: string;
  /** 表紙・メタデータのタイトル（検証済み。ここで HTML として解釈されないようにエスケープする） */
  title: string;
  outputPath: string;
  /** ジョブ専用の一時ディレクトリ（0700）。HOME / TMPDIR にする */
  workDir: string;
  timeoutMs: number;
}

export type PfpdfResult = { ok: true } | { ok: false; code: "RENDER_TIMEOUT" | "RENDER_FAILED" };

/** 子プロセスに渡す環境変数。呼び出し元の環境は一切継承しない */
export function pfpdfEnv(workDir: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: workDir,
    TMPDIR: workDir,
    LANG: "C.UTF-8",
    TZ: "UTC",
  };
}

export function pfpdfArgs(command: PfpdfCommand, options: RunPfpdfOptions): string[] {
  return [
    ...command.args,
    "--input",
    options.inputPath,
    "--output",
    options.outputPath,
    // 値は次の引数としてそのまま渡る（"-" で始まってもオプションとは解釈されない）
    "--title",
    escapeTitle(options.title),
    "--no-logo",
    "--log-level",
    "error",
    // pfpdf 自身の期限は外側の kill より短くし、正常に後始末する機会を与える
    "--render-timeout-ms",
    String(Math.max(1000, options.timeoutMs - 5000)),
    ...(command.browserPath ? ["--browser-path", command.browserPath] : []),
  ];
}

/**
 * pfpdf のタイトルは「文字・文字参照・<br>」のみ受け付け、HTML として表紙に入る。
 * ユーザーのタイトルはすべて文字として扱うため、& < > を文字参照にする。
 */
export function escapeTitle(title: string): string {
  return title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function runPfpdf(command: PfpdfCommand, options: RunPfpdfOptions): Promise<PfpdfResult> {
  return new Promise((resolve) => {
    const child = spawn(command.executable, pfpdfArgs(command, options), {
      cwd: options.workDir,
      env: pfpdfEnv(options.workDir),
      shell: false,
      // 新しいプロセスグループにして、Chromium 等の孫プロセスもまとめて kill できるようにする
      detached: true,
      // stderr にはユーザーの入力が含まれうるため読まない（ログに出さない）
      stdio: "ignore",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, options.timeoutMs);

    child.once("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, code: "RENDER_FAILED" });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      // 正常終了でも、取り残された孫プロセスがあれば片付ける
      killGroup(child.pid);
      if (timedOut) resolve({ ok: false, code: "RENDER_TIMEOUT" });
      else resolve(code === 0 ? { ok: true } : { ok: false, code: "RENDER_FAILED" });
    });
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 既に終了している
  }
}
