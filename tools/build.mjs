#!/usr/bin/env node
/**
 * 构建可加载的扩展目录
 *
 * 为什么需要这一步：**两个浏览器都要求清单文件必须叫 `manifest.json`**，
 * 且都必须位于扩展根目录。所以我们无法"指定清单路径"，
 * 只能把「共享的 src/ + 目标浏览器的清单」组装成一个独立目录。
 *
 * 产物：
 *   build/firefox/   ← about:debugging 里选这个目录里的 manifest.json
 *   build/chrome/    ← chrome://extensions 里选这个目录
 *
 * 源码仍是单一来源（src/ 只有一个），构建只是复制 + 改名。
 *
 * 用法：
 *   node tools/build.mjs            # 两个都构建
 *   node tools/build.mjs firefox
 *   node tools/build.mjs chrome
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = join(ROOT, 'src');
const BUILD = join(ROOT, 'build');

const TARGETS = {
  firefox: { manifest: join(ROOT, 'manifest', 'firefox.json') },
  chrome: { manifest: join(ROOT, 'manifest', 'chrome.json') },
};

async function buildOne(name) {
  const spec = TARGETS[name];
  if (!spec) throw new Error(`未知目标：${name}（可选：${Object.keys(TARGETS).join(' / ')}）`);
  if (!existsSync(spec.manifest)) throw new Error(`找不到清单模板：${spec.manifest}`);

  const outDir = join(BUILD, name);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // 1) 复制共享源码
  await cp(SRC, join(outDir, 'src'), { recursive: true });

  // 2) 清单改名成 manifest.json（两个浏览器都只认这个名字）
  const manifest = JSON.parse(await readFile(spec.manifest, 'utf8'));
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // 3) 校验：清单引用的文件在产物里必须存在
  const refs = [];
  if (manifest.background?.scripts) refs.push(...manifest.background.scripts);
  if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
  if (manifest.options_ui?.page) refs.push(manifest.options_ui.page);
  if (manifest.action?.default_popup) refs.push(manifest.action.default_popup);
  const missing = refs.filter((r) => !existsSync(join(outDir, r)));
  if (missing.length) throw new Error(`产物缺少清单引用的文件：${missing.join(', ')}`);

  console.log(`✅ build/${name}/`);
  console.log(`   清单：manifest.json（由 manifest/${name}.json 改名）`);
  console.log(`   条目：${refs.join(', ')}`);
  return outDir;
}

async function main() {
  const arg = process.argv[2];
  const names = arg ? [arg] : Object.keys(TARGETS);
  for (const n of names) await buildOne(n);
  console.log('\n把下面的路径填进浏览器的「加载扩展」对话框：');
  for (const n of names) console.log(`  ${n === 'firefox' ? 'Firefox（about:debugging → 临时载入附加组件）' : 'Chrome/Edge（chrome://extensions → 加载已解压的扩展程序）'}：${join(BUILD, n)}`);
}

main().catch((e) => {
  console.error(`构建失败：${e.message}`);
  process.exitCode = 1;
});
