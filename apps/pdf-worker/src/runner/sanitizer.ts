import {
  FORBIDDEN_TEX_COMMANDS,
  MARKDOWN_STRUCTURE_LIMITS,
  MAX_MARKDOWN_BYTES,
  type DocumentLang,
  type TemplateName,
} from "@awesome-pdf/shared-types";
import type { Definition, Image, Link, Nodes, Parent, PhrasingContent, Root } from "mdast";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { SKIP, visit, type VisitorResult } from "unist-util-visit";

/**
 * ユーザーの Markdown を pfpdf に渡せる「安全な Markdown」に作り直す（仕様書 §5.2）。
 *
 * pfpdf は raw HTML・スクリプトをそのまま実行し、ローカルファイルやリモート URL を読めるため、
 * ここで HTML・front matter・危険な URL・危険な TeX コマンドを取り除く。
 * レンダラーはネットワークなし・秘密情報なしのコンテナで動くが、それは突破された場合の備えであり、
 * このサニタイザーが第一の防御線である。
 */

export type SanitizeErrorReason =
  | "TOO_LARGE"
  | "TOO_DEEP"
  | "TOO_MANY_MATH"
  | "TOO_MANY_MERMAID"
  | "TOO_MANY_IMAGES"
  | "FORBIDDEN_TEX_COMMAND"
  | "VERIFICATION_FAILED";

export class SanitizeError extends Error {
  override name = "SanitizeError";
  readonly reason: SanitizeErrorReason;

  constructor(reason: SanitizeErrorReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

export interface SanitizeInput {
  markdown: string;
  template: TemplateName;
  lang: DocumentLang;
  /** このドラフトにアップロード済みの画像ファイル名 */
  assetFilenames: ReadonlySet<string>;
}

export interface SanitizeResult {
  /** front matter を含む、pfpdf に渡す Markdown */
  markdown: string;
  /** 参照された画像: 元のファイル名 → レンダラー上の安全な名前（`img-1.png` 等） */
  assets: ReadonlyMap<string, string>;
}

/** 受信箱の Markdown から見た画像ディレクトリ */
export const ASSET_DIR = "assets";

const LINK_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:", "mailto:"]);

/** 禁止コマンドの一覧と理由は shared-types の FORBIDDEN_TEX_COMMANDS */
const FORBIDDEN_TEX: ReadonlySet<string> = new Set(FORBIDDEN_TEX_COMMANDS);

const CODE_LANG_PATTERN = /^[A-Za-z0-9_+#.-]{1,32}$/;

/** pfpdf（remark-parse + gfm + cjk-friendly + math）と同じ解釈でパースする */
function parser() {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkCjkFriendly)
    .use(remarkMath, { singleDollarTextMath: true });
}

function stringifier() {
  return unified()
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: true })
    .use(remarkStringify, { bullet: "-", fence: "`", fences: true, rule: "-" });
}

export function sanitizeMarkdown(input: SanitizeInput): SanitizeResult {
  if (new TextEncoder().encode(input.markdown).byteLength > MAX_MARKDOWN_BYTES) {
    throw new SanitizeError("TOO_LARGE");
  }

  const tree = parser().parse(input.markdown);
  checkDepth(tree);

  const definitions = collectDefinitions(tree);
  const assets = new Map<string, string>();
  let mathNodes = 0;
  let mermaidBlocks = 0;
  let imageNodes = 0;

  visit(tree, (node, index, parent) => {
    switch (node.type) {
      case "html":
      case "yaml":
      case "definition":
        return removeNode(parent, index);

      case "link":
        if (isAllowedLinkUrl(node.url)) {
          node.title = null;
          return;
        }
        return unwrapNode(parent, index, node.children);

      case "linkReference": {
        const def = definitions.get(node.identifier);
        if (def && isAllowedLinkUrl(def.url)) {
          return replaceNode(parent, index, {
            type: "link",
            url: def.url,
            children: node.children,
          } satisfies Link);
        }
        return unwrapNode(parent, index, node.children);
      }

      case "image":
      case "imageReference": {
        imageNodes++;
        const url = node.type === "image" ? node.url : definitions.get(node.identifier)?.url;
        const filename = url === undefined ? undefined : matchAsset(url, input.assetFilenames);
        if (filename === undefined) return removeNode(parent, index);
        const safeName = safeAssetName(assets, filename);
        return replaceNode(parent, index, {
          type: "image",
          url: `${ASSET_DIR}/${safeName}`,
          alt: node.alt ?? "",
        } satisfies Image);
      }

      case "code":
        if (node.lang === "mermaid") mermaidBlocks++;
        node.lang = node.lang && CODE_LANG_PATTERN.test(node.lang) ? node.lang : null;
        node.meta = null;
        return;

      case "math":
      case "inlineMath":
        mathNodes++;
        assertSafeTex(node.value);
        if (node.type === "math") node.meta = null;
        return;

      default:
        return;
    }
  });

  const limits = MARKDOWN_STRUCTURE_LIMITS;
  if (mathNodes > limits.maxMathNodes) throw new SanitizeError("TOO_MANY_MATH");
  if (mermaidBlocks > limits.maxMermaidBlocks) throw new SanitizeError("TOO_MANY_MERMAID");
  if (imageNodes > limits.maxImageNodes) throw new SanitizeError("TOO_MANY_IMAGES");

  // ユーザーの front matter は破棄済み。許可リストの値だけでサーバー側が生成する
  tree.children.unshift({
    type: "yaml",
    value: `template: ${input.template}\nlang: ${input.lang}`,
  });
  const markdown = stringifier().stringify(tree);

  verify(markdown, new Set(assets.values()));
  return { markdown, assets };
}

/**
 * 再生成した Markdown を pfpdf と同じ解釈でパースし直し、危険なノードが残っていないことを確かめる。
 * 文字列化の過程で新たな構文（HTML 等）が生まれる回避手法への多層防御。
 */
function verify(markdown: string, safeNames: ReadonlySet<string>): void {
  const tree = parser().parse(markdown);
  let frontMatters = 0;
  visit(tree, (node) => {
    switch (node.type) {
      case "html":
      case "definition":
      case "linkReference":
      case "imageReference":
        throw new SanitizeError("VERIFICATION_FAILED", node.type);
      case "yaml":
        frontMatters++;
        return;
      case "link":
        if (!isAllowedLinkUrl(node.url)) throw new SanitizeError("VERIFICATION_FAILED", "link");
        return;
      case "image": {
        const name = node.url.startsWith(`${ASSET_DIR}/`)
          ? node.url.slice(ASSET_DIR.length + 1)
          : "";
        if (!safeNames.has(name)) throw new SanitizeError("VERIFICATION_FAILED", "image");
        return;
      }
      case "math":
      case "inlineMath":
        assertSafeTex(node.value);
        return;
      default:
        return;
    }
  });
  if (frontMatters !== 1 || tree.children[0]?.type !== "yaml") {
    throw new SanitizeError("VERIFICATION_FAILED", "front matter");
  }
}

function checkDepth(tree: Root): void {
  const stack: { node: Nodes; depth: number }[] = [{ node: tree, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MARKDOWN_STRUCTURE_LIMITS.maxDepth) throw new SanitizeError("TOO_DEEP");
    if ("children" in node) {
      for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
    }
  }
}

function collectDefinitions(tree: Root): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  visit(tree, "definition", (node) => {
    // CommonMark では最初の定義が優先される
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  return definitions;
}

/** リンクは http(s) / mailto と文書内アンカー（#...）のみ許可 */
function isAllowedLinkUrl(url: string): boolean {
  if (/^#[^\s]*$/u.test(url)) return true;
  if (!URL.canParse(url)) return false;
  return LINK_PROTOCOLS.has(new URL(url).protocol);
}

/** 画像 URL がアップロード済みのファイル名そのもの（URL エンコード可）と一致するか */
function matchAsset(url: string, filenames: ReadonlySet<string>): string | undefined {
  if (filenames.has(url)) return url;
  try {
    const decoded = decodeURIComponent(url);
    if (filenames.has(decoded)) return decoded;
  } catch {
    // 不正なパーセントエンコードは一致しない
  }
  return undefined;
}

function safeAssetName(assets: Map<string, string>, filename: string): string {
  const existing = assets.get(filename);
  if (existing) return existing;
  const ext = /\.[A-Za-z]+$/.exec(filename)?.[0]?.toLowerCase() ?? "";
  const name = `img-${assets.size + 1}${ext}`;
  assets.set(filename, name);
  return name;
}

/** TeX の制御綴（\ + 英字列）を走査し、禁止コマンドを含めば拒否する */
export function assertSafeTex(tex: string): void {
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] !== "\\") continue;
    const match = /^[A-Za-z]+/.exec(tex.slice(i + 1));
    if (!match) {
      i++; // \\ や \{ などの制御記号は 1 文字読み飛ばす
      continue;
    }
    if (FORBIDDEN_TEX.has(match[0])) {
      throw new SanitizeError("FORBIDDEN_TEX_COMMAND", `\\${match[0]}`);
    }
    i += match[0].length;
  }
}

function removeNode(parent: Parent | undefined, index: number | undefined): VisitorResult {
  if (!parent || index === undefined) return undefined;
  parent.children.splice(index, 1);
  return [SKIP, index];
}

function replaceNode(
  parent: Parent | undefined,
  index: number | undefined,
  node: Parent["children"][number],
): VisitorResult {
  if (!parent || index === undefined) return undefined;
  parent.children.splice(index, 1, node);
  return [SKIP, index + 1];
}

/** リンクを外して中身（テキスト）だけ残す。中身は続けて検査する */
function unwrapNode(
  parent: Parent | undefined,
  index: number | undefined,
  children: PhrasingContent[],
): VisitorResult {
  if (!parent || index === undefined) return undefined;
  parent.children.splice(index, 1, ...children);
  return index;
}
