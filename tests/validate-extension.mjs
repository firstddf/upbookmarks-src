#!/usr/bin/env node
/**
 * 扩展静态校验 —— 在真实浏览器加载之前先挡掉一批低级错误
 *
 * 检查项：
 *   1. 两个 manifest 是合法 JSON，且必备字段齐全；
 *   2. manifest 里引用的每个文件都真实存在；
 *   3. 所有 JS/CSS/HTML 引用的同目录文件都存在；
 *   4. 每个 JS 文件都能被解析（node --check 等价）；
 *   5. 源码里不出现浏览器没有的 Node 专有 API（`Buffer` / `require` / `process`）；
 *   6. 跨浏览器约定：background 同时含 scripts 与 service_worker。
 *
 * 用法：
 *   node tests/validate-extension.mjs
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const results = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} · ${title}${ok ? '' : `\n        ${detail ?? ''}`}`);
}

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'out' || e.name === 'node_modules') continue;
      await walk(p, out);
    } else out.push(p);
  }
  return out;
}

async function main() {
  console.log('='.repeat(72));
  console.log('扩展静态校验');
  console.log('='.repeat(72) + '\n');

  // ---------------------------------------------------------- manifest
  const manifests = {};
  for (const name of ['firefox', 'chrome']) {
    const p = join(ROOT, 'manifest', `${name}.json`);
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(p, 'utf8'));
    } catch (e) {
      check(`M-${name}`, `${name}.json 是合法 JSON`, false, e.message);
      continue;
    }
    manifests[name] = parsed;
    const required = ['manifest_version', 'name', 'version', 'background', 'options_ui', 'permissions', 'host_permissions'];
    const missing = required.filter((k) => !(k in parsed));
    check(`M-${name}`, `${name}.json 是合法 JSON 且含必备字段`,
      parsed.manifest_version === 3 && missing.length === 0,
      `manifest_version=${parsed.manifest_version} 缺失=${missing.join(',') || '无'}`);
  }

  // 跨浏览器后台约定
  for (const [name, m] of Object.entries(manifests)) {
    const bg = m.background ?? {};
    const expectsBoth = name === 'firefox';
    const ok = expectsBoth
      ? Boolean(bg.scripts && bg.service_worker)
      : Boolean(bg.service_worker);
    check(`M-${name}-bg`, `${name} 的 background 配置符合跨浏览器约定`,
      ok, JSON.stringify(bg));
  }

  // 权限检查：Chromium 不应声明 Firefox 专有的权限
  const chromePerms = manifests.chrome?.permissions ?? [];
  check('M-perms', 'chrome.json 不声明 Firefox 专有权限（browserSettings / privacy）',
    !chromePerms.includes('browserSettings') && !chromePerms.includes('privacy'),
    JSON.stringify(chromePerms));
  check('M-perms2', '两个 manifest 都声明了 bookmarks 与 storage',
    ['firefox', 'chrome'].every((n) => {
      const p = manifests[n]?.permissions ?? [];
      return p.includes('bookmarks') && p.includes('storage');
    }),
    JSON.stringify({ firefox: manifests.firefox?.permissions, chrome: manifests.chrome?.permissions }));

  // 自动备份需要 alarms 权限：漏了它后台定时器会静默不工作
  check('M-perms3', '两个 manifest 都声明了 alarms（自动备份需要）',
    ['firefox', 'chrome'].every((n) => (manifests[n]?.permissions ?? []).includes('alarms')),
    JSON.stringify({ firefox: manifests.firefox?.permissions, chrome: manifests.chrome?.permissions }));

  // 后台脚本依赖 app.js（自动备份要加密上传），确认它是 ES module 且能解析
  const bgSrc = await readFile(join(ROOT, 'src/background.js'), 'utf8').catch(() => '');
  check('B-bg-module', 'background.js 以 ES module 方式加载且引用 createApp',
    /from ['"]\.\/lib\/app\.js['"]/.test(bgSrc) && /createApp/.test(bgSrc),
    '后台未引用 createApp（自动备份无法工作）');
  check('B-bg-alarms', 'background.js 注册了 alarms 监听',
    /alarms\.onAlarm\.addListener/.test(bgSrc), '未注册 onAlarm');

  // 自动备份的前置条件必须在实现里体现：拿不到密钥就不上传
  check('B-bg-gate', 'background.js 在无可用密钥时跳过自动备份（不静默落盘）',
    /ensureUnlocked/.test(bgSrc) && /skipped: 'locked'/.test(bgSrc),
    '未找到"无密钥则跳过"的分支');

  // ---------------------------------------------------------- 引用文件存在
  const refs = [];
  for (const [name, m] of Object.entries(manifests)) {
    if (m.background?.scripts) for (const s of m.background.scripts) refs.push([name, s]);
    if (m.background?.service_worker) refs.push([name, m.background.service_worker]);
    if (m.options_ui?.page) refs.push([name, m.options_ui.page]);
    if (m.action?.default_popup) refs.push([name, m.action.default_popup]);
  }
  const missingFiles = refs.filter(([, rel]) => !existsSync(join(ROOT, rel)));
  check('F1', 'manifest 引用的文件都真实存在',
    missingFiles.length === 0,
    missingFiles.map(([n, r]) => `${n}: ${r}`).join(', '));

  // HTML 里引用的同目录资源
  const htmlRefs = [];
  for (const f of await walk(join(ROOT, 'src'))) {
    if (!f.endsWith('.html')) continue;
    const html = await readFile(f, 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const target = m[1];
      if (/^(https?:|data:|#|\/)/.test(target)) continue;
      htmlRefs.push([f, target, join(dirname(f), target)]);
    }
  }
  const brokenHtml = htmlRefs.filter(([, , abs]) => !existsSync(abs));
  check('F2', 'HTML 引用的脚本与样式都存在',
    brokenHtml.length === 0,
    brokenHtml.map(([h, t]) => `${h} → ${t}`).join(', '));

  // JS 内部 import 的相对路径
  const badImports = [];
  for (const f of await walk(join(ROOT, 'src'))) {
    if (!f.endsWith('.js')) continue;
    const src = await readFile(f, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const abs = resolve(dirname(f), m[1]);
      if (!existsSync(abs)) badImports.push(`${f.replace(ROOT, '.')} → ${m[1]}`);
    }
  }
  check('F3', 'JS 里的相对 import 都能解析到真实文件',
    badImports.length === 0, badImports.join(', '));

  // ---------------------------------------------------------- 语法与禁用 API
  const jsFiles = (await walk(join(ROOT, 'src'))).filter((f) => f.endsWith('.js'));
  const syntaxErrors = [];
  for (const f of jsFiles) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) syntaxErrors.push(`${f.replace(ROOT, '.')}: ${(r.stderr ?? '').split('\n')[0]}`);
  }
  check('S1', `src/ 下 ${jsFiles.length} 个 JS 文件全部可解析`,
    syntaxErrors.length === 0, syntaxErrors.join('\n        '));

  // Node 专有 API 不能在扩展源码里出现
  const forbidden = [];
  for (const f of jsFiles) {
    const src = await readFile(f, 'utf8');
    const rel = f.replace(ROOT, '.');
    for (const [pat, label] of [
      [/\bBuffer\s*[.(]/, 'Buffer'],
      [/\brequire\s*\(/, 'require()'],
      [/\bprocess\.(env|argv|platform)\b/, 'process.*'],
      [/from\s+['"]node:/, "import 'node:…'"],
    ]) {
      // 允许出现在注释里说明"不要用"
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;          // 跳过注释行
        if (pat.test(line) && !/扩展环境没有 Buffer|不要用|禁止/.test(line)) {
          forbidden.push(`${rel}:${i + 1} ${label}`);
        }
      });
    }
  }
  check('S2', '扩展源码里没有 Node 专有 API（Buffer / require / process / node:）',
    forbidden.length === 0, forbidden.join('\n        '));

  // ---------------------------------------------------------- 关键约定
  const crypto = await readFile(join(ROOT, 'src/lib/crypto.js'), 'utf8');
  check('C1', 'crypto.js 的运行态 DEK 不可导出（unlockDek 传 false）',
    /unlockDek\(keyfile, \{ password, recoveryCode \}, false\)/.test(crypto),
    '未找到 unlockDek(..., false)');

  const constants = await readFile(join(ROOT, 'src/lib/constants.js'), 'utf8');
  check('C2', 'constants.js 里参数与文档一致（抽查 3 个关键值）',
    constants.includes('KDF_PASSWORD_ITERATIONS = 600000')
      && constants.includes('RETENTION_PER_MACHINE = 20')
      && constants.includes('IV_BYTES = 12'),
    '关键常量与 03-parameters.md 不一致');

  // 源码里不应出现散落的魔法数字
  const strayMagic = [];
  for (const f of jsFiles.filter((x) => !x.endsWith('constants.js') && !x.includes('ui'))) {
    const src = await readFile(f, 'utf8');
    const rel = f.replace(ROOT, '.');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/\b600000\b/.test(line)) strayMagic.push(`${rel}:${i + 1} 出现 600000`);
    });
  }
  check('C3', '迭代次数等魔法数字只出现在 constants.js',
    strayMagic.length === 0, strayMagic.join('\n        '));

  // ---------------------------------------------------------- 构建产物
  // 两个浏览器都要求清单必须叫 manifest.json 且位于扩展根目录，
  // 所以「源码目录能不能直接加载」这件事必须单独校验，不能想当然。
  for (const target of ['firefox', 'chrome']) {
    const dir = join(ROOT, 'build', target);
    const mf = join(dir, 'manifest.json');
    if (!existsSync(mf)) {
      check(`B-${target}`, `build/${target} 可加载（根目录有 manifest.json）`, false,
        '缺少 build/' + target + '/manifest.json —— 先运行 node tools/build.mjs');
      continue;
    }
    let built = null;
    try {
      built = JSON.parse(await readFile(mf, 'utf8'));
    } catch (e) {
      check(`B-${target}`, `build/${target}/manifest.json 是合法 JSON`, false, e.message);
      continue;
    }
    const refs = [];
    if (built.background?.scripts) refs.push(...built.background.scripts);
    if (built.background?.service_worker) refs.push(built.background.service_worker);
    if (built.options_ui?.page) refs.push(built.options_ui.page);
    if (built.action?.default_popup) refs.push(built.action.default_popup);
    const missing = refs.filter((r) => !existsSync(join(dir, r)));
    check(`B-${target}`, `build/${target} 的清单有效且引用文件齐全`,
      missing.length === 0, `缺失=${missing.join(', ')}`);

    if (target === 'firefox') {
      check('B-firefox-bg', 'build/firefox 同时提供 scripts 与 service_worker（跨浏览器约定）',
        Array.isArray(built.background?.scripts) && typeof built.background?.service_worker === 'string',
        JSON.stringify(built.background));
    } else {
      check('B-chrome-perms', 'build/chrome 不声明 Firefox 专有权限',
        !(built.permissions ?? []).includes('browserSettings') && !(built.permissions ?? []).includes('privacy'),
        JSON.stringify(built.permissions));
      // Chromium 不接受这些字段：混进去会导致加载失败或行为异常
      check('B-chrome-clean', 'build/chrome 不含 Firefox 专有清单字段',
        !('browser_specific_settings' in built)
          && !Array.isArray(built.background?.scripts)
          && typeof built.background?.service_worker === 'string',
        JSON.stringify({ has_bss: 'browser_specific_settings' in built, bg: built.background }));
    }

    // 产物里不该混入清单模板本身
    const stray = ['firefox.json', 'chrome.json'].filter((f) => existsSync(join(dir, f)));
    check(`B-${target}-clean`, `build/${target} 未混入清单模板文件`,
      stray.length === 0, stray.join(', '));
  }

  // ---------------------------------------------------------- 小结
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(72));
  console.log(`小结: PASS=${results.length - failed.length}  FAIL=${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  未通过: ${f.id} ${f.title}`);
  console.log('='.repeat(72));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('校验脚本异常:', e); process.exitCode = 2; });
