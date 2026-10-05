#!/usr/bin/env node
/**
 * 打包成可安装的 .xpi
 *
 * 为什么需要它：**临时加载的扩展在关闭 Firefox 后会被移除**，
 * 而且每次临时加载都是一个新的扩展身份 + 一份空存储。
 * 正式安装成 .xpi 后：
 *   - 重启 Firefox 依然在；
 *   - storage.local 跨重启保留（配置、令牌不用反复填）。
 *
 * 安装前提（Firefox）：`about:config` 里把
 *   `xpinstall.signatures.required` 设为 false
 * 否则未签名的扩展无法安装。Release 版不允许关闭该项，Nightly / Developer Edition 可以。
 *
 * 用法：
 *   node tools/package.mjs            # 两个都打包
 *   node tools/package.mjs firefox
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BUILD = join(ROOT, 'build');
const DIST = join(ROOT, 'dist');

const TARGETS = ['firefox', 'chrome'];

/**
 * 各目标浏览器的打包方式完全不同：
 *
 *   Firefox：`.xpi`（内部是 zip，清单必须字面上位于根层）。
 *            未签名包需要 `xpinstall.signatures.required = false` 才能装。
 *
 *   Chromium：**不安装打包文件**（除非上架商店），只「加载已解压的扩展程序」。
 *            所以这里额外产出一个 zip，只是为了便于传输/备份；
 *            真正加载时仍然指向 `build/chrome` 目录。
 */
const PACKAGING = {
  firefox: { ext: '.xpi', note: '需 xpinstall.signatures.required = false，或用 web-ext 签名' },
  chrome: { ext: '.zip', note: 'Chrome 不装打包文件；解压后用「加载已解压的扩展程序」指向该目录' },
};

/**
 * 打包成 zip。
 *
 * 两个必须踩对的坑：
 *
 * 1. Windows 的 tar 按**扩展名**判断格式，`.xpi` 它不认识，会打成未压缩的 tar。
 *    因此先生成 `.zip`，校验后再改名。
 *
 * 2. **不能用 `tar -C src .`** —— 那样每个条目都会带 `./` 前缀
 *    （`./manifest.json`），而 Firefox 要求清单**字面上**就在根层，
 *    不接受 `./manifest.json`。所以这里逐个顶层条目添加，
 *    而不是添加 `.`。
 */
function zipDir(srcDir, outZip, topLevel) {
  const args = ['-a', '-c', '-f', outZip, '-C', srcDir, ...topLevel];
  const r = spawnSync('tar', args, { encoding: 'utf8', shell: false });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() || `tar 退出码 ${r.status}` };
  return { ok: true };
}

/** 校验：文件头是 zip，且 `manifest.json` **字面**位于根层（不接受 `./` 前缀） */
async function verifyArchive(zipPath) {
  const head = await readFile(zipPath);
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) {
    return {
      ok: false,
      error: `文件头不是 zip（读到 ${[...head.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}，应为 50 4b 03 04）`,
    };
  }
  const r = spawnSync('tar', ['-t', '-f', zipPath], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() };
  const entries = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const hasLiteralRootManifest = entries.includes('manifest.json');

  if (!hasLiteralRootManifest) {
    const dotted = entries.find((e) => e.replace(/^\.\//, '') === 'manifest.json');
    return {
      ok: false,
      entries,
      error: dotted
        ? `清单路径是 "${dotted}" —— Firefox 只接受字面上的 "manifest.json"`
        : '压缩包里没有 manifest.json',
    };
  }
  return { ok: true, entries };
}

async function packageOne(target) {
  const src = join(BUILD, target);
  if (!existsSync(join(src, 'manifest.json'))) {
    throw new Error(`build/${target} 不存在或不完整，请先运行 node tools/build.mjs`);
  }

  const version = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8')).version ?? '0.0.0';
  await mkdir(DIST, { recursive: true });          // tar 不会自建输出目录，必须先建

  const spec = PACKAGING[target];
  // 先生成 .zip（tar 认识该扩展名会打 zip），校验通过后再改名成目标扩展名
  const tmpZip = join(DIST, `upbookmarks-${target}-${version}.zip`);
  const out = join(DIST, `upbookmarks-${target}-${version}${spec.ext}`);
  await rm(tmpZip, { force: true });
  await rm(out, { force: true });

  const z = zipDir(src, tmpZip, ['manifest.json', 'src']);
  if (!z.ok) throw new Error(`打包失败：${z.error}`);

  const v = await verifyArchive(tmpZip);
  if (!v.ok) throw new Error(`产物校验失败：${v.error}`);

  // 只有目标扩展名与临时文件不同时才需要改名（Chrome 的产物本身就是 .zip）
  if (tmpZip !== out) await rename(tmpZip, out);
  const size = (await readFile(out)).length;
  console.log(`✅ dist/upbookmarks-${target}-${version}${spec.ext}  (${size} 字节, ${v.entries.length} 个条目, PK ✅)`);
  console.log(`   ${spec.note}`);
  return out;
}

async function main() {
  const arg = process.argv[2];
  const targets = arg ? [arg] : TARGETS;
  for (const t of targets) {
    if (!TARGETS.includes(t)) throw new Error(`未知目标：${t}`);
  }
  await rm(DIST, { recursive: true, force: true });
  const made = [];
  for (const t of targets) made.push(await packageOne(t));

  console.log('\n安装方式：');
  console.log('  Firefox：about:addons → 齿轮 → 从文件安装附加组件 → 选 .xpi');
  console.log('           （需要 xpinstall.signatures.required = false，Nightly / Developer Edition 支持）');
  console.log('  Chrome / Edge：chrome://extensions → 打开「开发者模式」');
  console.log('           → 「加载已解压的扩展程序」→ 选 build/chrome 目录');
  console.log('           （Chromium 不接受打包文件，zip 仅供传输/备份）');
  console.log('\n产物：');
  for (const m of made) console.log(`  ${m}`);
}

main().catch((e) => {
  console.error(`打包失败：${e.message}`);
  process.exitCode = 1;
});
