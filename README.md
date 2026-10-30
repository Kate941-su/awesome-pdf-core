# awesome-pdf-core

[Awesome PDF](https://github.com/Kate941-su/awesome-pdf-core) の PDF 生成部分のソースコードです。
This repository contains the PDF generation component of the Awesome PDF service.

このリポジトリは非公開の開発リポジトリから自動で同期しています（タグ `src-<commit>` は同期元のコミットに対応）。
It is synchronized automatically from the private development repository. Each `src-<commit>` tag
corresponds to the source commit that was deployed.

## 内容 / Contents

| パス / Path             | ライセンス / License | 説明 / Description                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/pdf-worker`       | AGPL-3.0-only        | ジョブランナー（入力のサニタイズ・画像の検証）と、ネットワークから隔離されたレンダラー（[pfpdf](https://github.com/pfnet-research/pfpdf) を CLI として実行） / Job runner (input sanitization, image validation) and a network-isolated renderer that runs pfpdf as a CLI |
| `packages/shared-types` | MIT                  | サービス間で共有する型・zod スキーマ・定数 / Types, zod schemas and constants shared between services                                                                                                                                                                     |

ルートの設定ファイル（`package.json` など）は、上記をビルド・テストするためのものです（AGPL-3.0-only）。
Root configuration files exist only to build and test the packages above (AGPL-3.0-only).

## ビルドとテスト / Build and test

Node.js 26（`.nvmrc`）と pnpm 12 が必要です。 / Requires Node.js 26 (`.nvmrc`) and pnpm 12.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test

# レンダラーのコンテナイメージ / Container image (renderer + runner)
docker build -f apps/pdf-worker/Dockerfile -t awesome-pdf-worker .
```

レンダラーは `apps/pdf-worker/seccomp/renderer.json` の seccomp プロファイルとネットワークなしで動かす前提です。
The renderer is meant to run with the seccomp profile in `apps/pdf-worker/seccomp/renderer.json` and without network access.

## セキュリティ / Security

脆弱性は公開の Issue ではなく、GitHub の Private vulnerability reporting で報告してください。
Please report vulnerabilities via GitHub private vulnerability reporting, not public issues.
