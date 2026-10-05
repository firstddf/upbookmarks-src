#!/usr/bin/env node
/**
 * WebCrypto 跨平台一致性 —— 浏览器侧采集 + 与 Node 对比
 *
 * 为什么不用 --dump-dom：
 *   本机上 Chrome 已有实例在运行，--dump-dom 会被转发给现有实例后静默退出，
 *   什么都不返回。Firefox 这个构建的 --dump-dom/--screenshot 也不产出输出。
 *   因此改为：本地起 HTTP 服务，让浏览器页面把结果 POST 回来。
 *
 * 用法：
 *   node tools/crypto-consistency/compare.mjs
 *   node tools/crypto-consistency/compare.mjs --browser chrome
 *   node tools/crypto-consistency/compare.mjs --browser "D:\firefox\firefox.exe"
 *   node tools/crypto-consistency/compare.mjs --timeout 180000
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeReference } from './reference-node.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, 'harness.html');

const CANDIDATES = {
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  firefox: ['D:\\firefox\\firefox.exe'],
};

const argv = process.argv.slice(2);
const bIdx = argv.indexOf('--browser');
const browserArg = bIdx >= 0 ? argv[bIdx + 1] : 'chrome';
const tIdx = argv.indexOf('--timeout');
const TIMEOUT_MS = tIdx >= 0 ? Number(argv[tIdx + 1]) : 180_000;

/** 确定浏览器可执行文件与类型 */
function resolveBrowser(arg) {
  const lower = String(arg).toLowerCase();
  if (CANDIDATES[lower]) {
    for (const p of CANDIDATES[lower]) {
      return { kind: lower, path: p };
    }
    return { kind: lower, path: CANDIDATES[lower][0], guess: true };
  }
  const kind = /firefox/i.test(arg) ? 'firefox' : 'chromium';
  return { kind, path: arg };
}

function browserArgs(kind, exe, profileDir, url) {
  if (kind === 'firefox') {
    return [exe, ['--headless', '--no-remote', '--profile', profileDir, url]];
  }
  return [exe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profileDir}`,
    url,
  ]];
}

async function main() {
  const b = resolveBrowser(browserArg);
  console.log('='.repeat(74));
  console.log('WebCrypto 跨平台一致性对比');
  console.log(`浏览器: ${b.kind} → ${b.path}`);
  console.log(`超时: ${TIMEOUT_MS} ms`);
  console.log('='.repeat(74));

  const refLines = await computeReference();
  const parseKv = (text) => {
    const m = new Map();
    for (const line of String(text).split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    return m;
  };
  const ref = parseKv(refLines.join('\n'));

  // ---- 起服务，等浏览器回报
  let resolveResult;
  const resultPromise = new Promise((r) => { resolveResult = r; });
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/result') {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        res.writeHead(204).end();
        resolveResult(body);
      });
      return;
    }
    if (req.url === '/' || req.url === '/harness.html') {
      const html = await readFile(HARNESS, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      return;
    }
    res.writeHead(404).end('not found');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/harness.html`;
  console.log(`\n本地服务: ${url}`);

  const profileDir = await mkdtemp(join(tmpdir(), 'upbookmarks-crypto-prof-'));
  const [exe, args] = browserArgs(b.kind, b.path, profileDir, url);
  console.log(`临时 profile: ${profileDir}\n`);

  let child;
  let captured = null;
  let timedOut = false;
  try {
    child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => resolveResult(`__SPAWN_ERROR__ ${e.message}`));

    const timer = setTimeout(() => { timedOut = true; resolveResult('__TIMEOUT__'); }, TIMEOUT_MS);
    captured = await resultPromise;
    clearTimeout(timer);
    if (stderr && (captured.startsWith('__'))) console.log(`浏览器 stderr 尾部:\n${stderr.slice(-500)}`);
  } finally {
    try { child?.kill(); } catch { /* ignore */ }
    server.close();
    // 浏览器可能仍持有 profile 目录（Crashpad 等），清理失败不应影响结果
    try {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch (e) {
      console.log(`（临时 profile 未能删除，可稍后手动清理：${profileDir}）`);
    }
  }

  if (captured === '__TIMEOUT__') {
    console.log(`❌ 超时（${TIMEOUT_MS} ms）未收到浏览器回报。`);
    console.log('   可加大 --timeout，或确认该浏览器能否无头访问 http://127.0.0.1。');
    process.exitCode = 2;
    return;
  }
  if (captured?.startsWith('__SPAWN_ERROR__')) {
    console.log(`❌ 无法启动浏览器：${captured}`);
    process.exitCode = 2;
    return;
  }

  console.log('—— 浏览器侧输出 ——');
  console.log(captured);
  console.log('');

  const browser = parseKv(captured);
  if (browser.get('C9.done') !== 'true') {
    console.log(`❌ 浏览器侧未跑完（C9.done=${browser.get('C9.done')}）`);
    if (browser.get('ERROR')) console.log(`   浏览器报错: ${browser.get('ERROR')}`);
    process.exitCode = 1;
    return;
  }

  const SKIP = new Set(['C8.runtime', 'C8.userAgent', 'C9.done']);
  const keys = refLines.map((l) => l.slice(0, l.indexOf('='))).filter((k) => !SKIP.has(k));

  console.log('—— 逐项对比 ——');
  let same = 0;
  const diffs = [];
  const shown = (v) => (v && v.length > 44 ? `${v.slice(0, 44)}…` : v);
  for (const k of keys) {
    const a = ref.get(k);
    if (a === undefined) continue;
    const bv = browser.get(k);
    const ok = a === bv;
    if (ok) same++; else diffs.push({ key: k, node: a, browser: bv });
    console.log(`  ${ok ? '✅' : '❌'} ${k} = ${shown(a)}`);
    if (!ok) console.log(`      浏览器值 = ${shown(bv)}`);
  }

  console.log('\n' + '='.repeat(74));
  if (diffs.length === 0) {
    console.log(`✅ 全部一致：${same} 项逐字节相同`);
    console.log(`   结论：Node 验证脚本确认的加密参数，在浏览器 WebCrypto 下产出完全相同的结果。`);
  } else {
    console.log(`❌ ${diffs.length} 项不一致：`);
    for (const d of diffs) console.log(`   ${d.key}\n     node=${d.node}\n     浏览器=${d.browser}`);
  }
  console.log('='.repeat(74));

  const reportPath = resolve(HERE, '..', 'out', `crypto-consistency-report-${b.kind}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    browserKind: b.kind,
    browserPath: b.path,
    browserUserAgent: browser.get('C8.userAgent') ?? null,
    compared: same,
    diffs,
    node: Object.fromEntries(ref),
    browser: Object.fromEntries(browser),
  }, null, 2), 'utf8');
  console.log(`报告已写入: ${reportPath}`);
  process.exitCode = diffs.length ? 1 : 0;
}

main().catch((e) => { console.error('对比脚本异常终止:', e); process.exitCode = 2; });
