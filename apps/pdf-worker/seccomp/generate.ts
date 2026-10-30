/**
 * renderer 用 seccomp プロファイルを生成する。
 *   node apps/pdf-worker/seccomp/generate.ts
 *
 * 元: Docker 標準プロファイル（docker-default.json, moby/profiles@6fe7deb1, Apache-2.0）。
 * 差分: Chromium の名前空間サンドボックスに必要な clone / unshare / setns / chroot を
 * CAP_SYS_ADMIN / CAP_SYS_CHROOT なしで許可する。名前空間の中で使うためのもので、
 * コンテナ自体のケーパビリティは増やさない（cap_drop: ALL のまま）。clone3 は標準どおり ENOSYS。
 */
import { readFileSync, writeFileSync } from "node:fs";

const dir = import.meta.dirname;
const profile: unknown = JSON.parse(readFileSync(`${dir}/docker-default.json`, "utf8"));
if (typeof profile !== "object" || profile === null || !("syscalls" in profile)) {
  throw new Error("unexpected seccomp profile format");
}
const { syscalls } = profile;
if (!Array.isArray(syscalls)) throw new Error("unexpected seccomp profile format");
syscalls.push({
  names: ["clone", "unshare", "setns", "chroot"],
  action: "SCMP_ACT_ALLOW",
});
writeFileSync(`${dir}/renderer.json`, `${JSON.stringify(profile, null, 2)}\n`);
