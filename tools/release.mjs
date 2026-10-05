#!/usr/bin/env node
/**
 * 生成 GitHub Release 所需的产物
 *
 * 产物设计目标：**下载即用，不需要 Node、不需要构建**。
 *
 *   upbookmarks-chrome-<ver>.zip   ← 解压到任意目录，Chrome/Edge「加载已解压的扩展程序」指向它
 *   upbookmarks-firefox-<ver>.xpi  ← Firefox 直接安装
 *   upbookmarks-source-<ver>.zip   ← 完整源码（含测试与工具），给想审查/自行构建的人
 *
 * 安全性：**xpi 绝不能包含测试与工具目录**。它们本身不含密钥，
 * 但会让扩展体积变大、审核面变宽，而且那些文件对运行毫无用处。
 *
 * 用法：
 *   node tools/release.mjs          # 生成全部产物（含跑测试）
 *   node tools/release.mjs --skip-tests
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = join(ROOT, 'release');

const skipTests = process.argv.includes('--skip-tests');

// ---------------------------------------------------------------- 工具

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts });
}

function zipDir(srcDir, outZip, entries) {
  const r = sh('tar', ['-a', '-c', '-f', outZip, '-C', srcDir, ...entries]);
  if (r.error) throw new Error(`tar 启动失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`tar 失败：${(r.stderr || '').trim()}`);
}

/** 校验 zip：文件头必须是 PK，且 manifest.json 字面上位于根层 */
async function verifyExtZip(zipPath) {
  const head = await readFile(zipPath);
  if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error('产物文件头不是 zip');
  const r = sh('tar', ['-t', '-f', zipPath]);
  const entries = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!entries.includes('manifest.json')) {
    throw new Error(`清单不在根层（实际条目含 ${entries.slice(0, 3).join(', ')}）`);
  }
  // 扩展包不该混入测试/工具/文档
  const leaked = entries.filter((e) => /^(tests|tools|node_modules)\//.test(e) || e.endsWith('.md') || e === 'LICENSE');
  if (leaked.length) throw new Error(`扩展包混入了不该有的文件：${leaked.slice(0, 5).join(', ')}`);
  return entries;
}

/** 读版本号：以常量文件为准（源码里也用它做自述） */
async function readVersion() {
  const src = await readFile(join(ROOT, 'src/lib/constants.js'), 'utf8');
  const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(src);
  if (!m) throw new Error('constants.js 里没有 APP_VERSION，无法确定版本号');
  return m[1];
}

async function run(cmd, args, label) {
  process.stdout.write(`▶ ${label}\n`);
  const r = sh(process.execPath, [cmd, ...args], { cwd: ROOT });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const failMatch = /FAIL=(\d+)/g;
  let fails = 0;
  for (const m of out.matchAll(failMatch)) fails += Number(m[1]);
  const hasFailLines = /\[FAIL\]/.test(out);
  if (r.status !== 0 || fails > 0 || hasFailLines) {
    console.error(out.split('\n').filter((l) => /\[FAIL\]|FAIL=|错误|Error/.test(l)).slice(0, 20).join('\n'));
    throw new Error(`${label} 未通过（退出码 ${r.status}，失败断言 ${fails}）`);
  }
  const pass = (out.match(/\[PASS\]/g) ?? []).length;
  console.log(`  ✅ ${label}${pass ? `（${pass} 项通过）` : ''}`);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const version = await readVersion();
  console.log(`upbookmarks 发布打包  v${version}\n`);

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 0) 先确认清单版本与常量版本一致
  for (const t of ['firefox', 'chrome']) {
    const mf = JSON.parse(await readFile(join(ROOT, 'manifest', `${t}.json`), 'utf8'));
    if (mf.version !== version) {
      throw new Error(`版本不一致：manifest/${t}.json 是 ${mf.version}，constants.js 是 ${version}`);
    }
  }
  console.log(`✅ 版本号一致：${version}\n`);

  // 1) 构建
  if (!skipTests) {
    await run('tools/build.mjs', [], '构建');
    await run('tests/run-all.mjs', [], '全部测试');
    // 构建可能被测试流程重做，这里确保产物是最新的
    await run('tools/build.mjs', [], '重新构建（确保产物最新）');
  } else {
    await run('tools/build.mjs', [], '构建（跳过测试）');
  }

  console.log('\n—— 生成发布产物 ——');

  // 2) 扩展包：只含 manifest.json + src/
  const extAssets = [];
  for (const t of ['firefox', 'chrome']) {
    const srcDir = join(ROOT, 'build', t);
    if (!existsSync(join(srcDir, 'manifest.json'))) throw new Error(`build/${t} 不完整`);

    const suffix = t === 'firefox' ? 'xpi' : 'zip';
    const tmp = join(DIST, `upbookmarks-${t}-${version}.zip`);
    const out = join(DIST, `upbookmarks-${t}-${version}.${suffix}`);
    zipDir(srcDir, tmp, ['manifest.json', 'src']);
    const entries = await verifyExtZip(tmp);
    if (tmp !== out) await rename(tmp, out);
    const size = (await readFile(out)).length;
    console.log(`✅ ${out.replace(ROOT + '\\', '')}  (${(size / 1024).toFixed(1)} KB, ${entries.length} 个条目)`);
    extAssets.push(out);
  }

  // 3) 源码包：全部源码 + 文档 + 测试 + 工具，但排除构建产物
  const srcZip = join(DIST, `upbookmarks-source-${version}.zip`);
  zipDir(ROOT, srcZip, [
    'LICENSE', 'README.md', 'CHANGELOG.md', 'PUBLISHING.md', '.gitignore',
    '01-threat-model.md', '02-design.md', '03-parameters.md', '04-repo-layout.md', '05-roadmap.md',
    'manifest', 'src', 'tests', 'tools', 'docs', 'release-notes.md',
  ].filter((e) => existsSync(join(ROOT, e))));
  const srcSize = (await readFile(srcZip)).length;
  console.log(`✅ ${srcZip.replace(ROOT + '\\', '')}  (${(srcSize / 1024).toFixed(1)} KB)`);

  console.log('\n—— Release 附件清单 ——');
  for (const f of await readdir(DIST)) console.log(`  ${f}`);

  console.log('\n不要上传到 Release 的东西：');
  console.log('  build/  dist/  tools/out/  —— 均可重新生成，且 out/ 含运行痕迹');
}

main().catch((e) => {
  console.error(`\n发布打包失败：${e.message}`);
  process.exitCode = 1;
});
