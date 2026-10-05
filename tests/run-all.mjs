#!/usr/bin/env node
/**
 * 跑全部测试。
 *
 * 用法：
 *   node tests/run-all.mjs
 *   node tests/run-all.mjs --with-network    # 额外跑需要令牌的端到端（需 GITEE_TOKEN）
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const withNetwork = process.argv.includes('--with-network');

/** 本地测试：无需网络、无需令牌 */
const LOCAL = [
  ['构建可加载目录（build/firefox、build/chrome）', 'tools/build.mjs'],
  ['crypto.js 与冻结参考值对拍', 'tests/crypto-parity.test.mjs'],
  ['gitee.js 客户端（假 Gitee）', 'tests/gitee-client.test.mjs'],
  ['snapshot.js 快照与索引（假 Gitee）', 'tests/snapshot.test.mjs'],
  ['collect.js 采集（假浏览器 API）', 'tests/collect.test.mjs'],
  ['restore.js 还原（内存适配器）', 'tests/restore.test.mjs'],
  ['app.js 端到端编排（假 Gitee + 假浏览器 + 真加密）', 'tests/app-flow.test.mjs'],
  ['扩展静态校验（清单 / 产物 / 引用 / 语法 / 禁用 API）', 'tests/validate-extension.mjs'],
];

/** 需要令牌与真实 Gitee 的测试 */
const NETWORK = [
  ['阶段二 V1–V8 加解密', 'tools/v1-v8-verify.mjs'],
  ['阶段二 V9 Gitee 接口探针', 'tools/v9-probe-gitee.mjs'],
  ['阶段二 V11 真实端到端', 'tools/e2e-real-gitee.mjs'],
];

function run(label, script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      const pass = (out.match(/\[PASS\]/g) ?? []).length;
      const fail = (out.match(/\[FAIL\]/g) ?? []).length;
      resolve({ label, script, code, pass, fail, out });
    });
  });
}

async function main() {
  console.log('='.repeat(72));
  console.log('全部测试');
  console.log('='.repeat(72));

  const suites = withNetwork ? [...LOCAL, ...NETWORK] : LOCAL;
  if (withNetwork && !process.env.GITEE_TOKEN) {
    console.log('\n⚠ --with-network 已指定，但未设置 GITEE_TOKEN；联网用例会自行跳过或失败。\n');
  }

  const rows = [];
  for (const [label, script] of suites) {
    process.stdout.write(`\n▶ ${label}\n`);
    const r = await run(label, script);
    rows.push(r);
    console.log(`  ${r.code === 0 ? '✅ 通过' : '❌ 失败'}  PASS=${r.pass} FAIL=${r.fail}  (${script})`);
    if (r.code !== 0 && r.fail > 0) {
      for (const line of r.out.split('\n').filter((l) => l.includes('[FAIL]') || /^\s{8}/.test(l))) {
        console.log(`     ${line.trim()}`);
      }
    }
  }

  const totalPass = rows.reduce((n, r) => n + r.pass, 0);
  const totalFail = rows.reduce((n, r) => n + r.fail, 0);
  const badSuites = rows.filter((r) => r.code !== 0);

  console.log('\n' + '='.repeat(72));
  console.log(`总计: ${rows.length} 个测试文件，PASS=${totalPass} FAIL=${totalFail}`);
  for (const r of rows) console.log(`  ${r.code === 0 ? '✅' : '❌'} ${r.label}`);
  console.log('='.repeat(72));
  process.exitCode = badSuites.length ? 1 : 0;
}

main().catch((e) => { console.error('运行器异常:', e); process.exitCode = 2; });
