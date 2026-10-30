# syntax=docker/dockerfile:1
#
# pdf-worker（AGPL-3.0-only）。1 イメージ・2 エントリポイント（仕様書 §2, §5）:
#   runner   : node apps/pdf-worker/src/runner/main.ts    （Redis・R2 に接続）
#   renderer : node apps/pdf-worker/src/renderer/main.ts  （network_mode: none、秘密情報なし）
# ビルドはリポジトリのルートで: docker build -f apps/pdf-worker/Dockerfile .
# （コンテキストの許可リストは同じディレクトリの Dockerfile.dockerignore）
#
# Chromium とフォントはビルド時に取得する（renderer は実行時にネットワークを使えない）。

ARG NODE_IMAGE=node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39

# --- 依存のインストール --------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install --global pnpm@12.16.1 --ignore-scripts && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/pdf-worker/package.json apps/pdf-worker/
# lockfile どおり・本番依存のみ。サプライチェーン設定（pnpm-workspace.yaml）もそのまま効く
RUN pnpm install --frozen-lockfile --prod --filter "@awesome-pdf/pdf-worker..."

# --- 実行イメージ --------------------------------------------------------------
FROM ${NODE_IMAGE}
# Chromium は Debian のセキュリティ更新が入るパッケージを使う。定期的に再ビルドして更新する。
# 本文のフォントは pfpdf 同梱だが、Mermaid 図（SVG）の描画は OS のフォントで代替されるため CJK フォントを入れる
RUN apt-get update \
  && apt-get install --yes --no-install-recommends chromium fontconfig fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared-types/node_modules ./packages/shared-types/node_modules
COPY --from=deps /app/apps/pdf-worker/node_modules ./apps/pdf-worker/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared-types/ packages/shared-types/
COPY apps/pdf-worker/ apps/pdf-worker/

ENV NODE_ENV=production \
    HANDOFF_ROOT=/jobs \
    RENDER_TMP=/tmp \
    PFPDF_CLI=/app/apps/pdf-worker/node_modules/@pfnet-research/pfpdf/dist/launcher.js \
    BROWSER_PATH=/usr/bin/chromium

# 共有ボリュームの初期所有者（名前付きボリュームは初回マウント時にこのディレクトリの所有者を引き継ぐ）
RUN mkdir -p /jobs && chown 1000:1000 /jobs && chmod 0700 /jobs

# 非 root（公式イメージの node ユーザー = 1000:1000）。アプリのファイルは root 所有のまま読み取り専用
USER 1000:1000
WORKDIR /app/apps/pdf-worker
# 既定は renderer。runner は compose の command で上書きする
CMD ["node", "src/renderer/main.ts"]
