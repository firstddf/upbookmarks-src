#!/usr/bin/env node
/**
 * V9 探针 —— 实测 Gitee OpenAPI v5 的真实行为
 *
 * 目的：验证 docs/03-parameters.md 中标记为「待验证」的假设，
 *       并记录所有会影响实现的行为差异。**不改动任何生产仓库**。
 *
 * 用法：
 *   node tools/v9-probe-gitee.mjs                      # 只跑匿名只读探测
 *   node tools/v9-probe-gitee.mjs --write              # 追加写入类探测（需 PAT）
 *   node tools/v9-probe-gitee.mjs --write --repo owner/name
 *
 * 凭据（只从环境变量读取，绝不写入文件）：
 *   GITEE_TOKEN    个人访问令牌，权限需含 projects
 *   GITEE_TEST_REPO  形如 owner/name，默认使用 --repo 参数
 *
 * 输出：stdout + tools/out/v9-report.json
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://gitee.com/api/v5';
const PUBLIC_REPO = 'oschina/git-osc';
const TIMEOUT_MS = 30_000;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

const argv = process.argv.slice(2);
const DO_WRITE = argv.includes('--write');
const repoArgIdx = argv.indexOf('--repo');
const TEST_REPO = repoArgIdx >= 0 ? argv[repoArgIdx + 1] : process.env.GITEE_TEST_REPO;
const TOKEN = process.env.GITEE_TOKEN;

/** 探测记录 */
const records = [];
function rec(id, title, ok, detail) {
  records.push({ id, title, ok, detail });
  const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO';
  console.log(`\n[${mark}] ${id} · ${title}`);
  for (const [k, v] of Object.entries(detail)) {
    console.log(`        ${k}: ${fmt(v)}`);
  }
}
function fmt(v) {
  if (v === undefined) return '(undefined)';
  if (v === null) return '(null)';
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…(${v.length})` : v;
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 发请求。返回 { http, body, json, error }。绝不回显 token。 */
async function req(method, path, { token, query = {}, body } = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  if (token) url.searchParams.set('access_token', token);

  const shown = API_BASE + path + (Object.keys(query).length ? `?${new URLSearchParams(query)}` : '');
  const init = { method, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { http: res.status, body: text, json, url: shown };
  } catch (e) {
    return { http: 0, body: '', json: undefined, url: shown, error: e.message };
  }
}

const contentsPath = (repo, path = '') =>
  `/repos/${repo}/contents${path ? `/${path}` : ''}`;

const topKeys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(', ') : '(非对象)');

// ---------------------------------------------------------------- 只读探测

async function probeReadShapes() {
  const repo = PUBLIC_REPO;

  // R1 目录列表
  const r1 = await req('GET', contentsPath(repo));
  rec('R1', 'GET contents/（根目录）→ 期望数组', Array.isArray(r1.json) && r1.json.length > 0, {
    url: r1.url,
    http: r1.http,
    'isArray': Array.isArray(r1.json),
    '条目数': Array.isArray(r1.json) ? r1.json.length : '(非数组)',
    '条目字段': Array.isArray(r1.json) && r1.json[0] ? topKeys(r1.json[0]) : '(空)',
    '第一条 name/type/size': Array.isArray(r1.json) && r1.json[0]
      ? `${r1.json[0].name} / ${r1.json[0].type} / ${r1.json[0].size}`
      : '(空)',
    '第一条有 sha?': Array.isArray(r1.json) && r1.json[0] ? 'sha' in r1.json[0] : '(空)',
  });

  // R2 子目录列表
  const subdir = Array.isArray(r1.json) ? r1.json.find((e) => e.type === 'dir')?.name : undefined;
  if (subdir) {
    const r2 = await req('GET', contentsPath(repo, subdir));
    rec('R2', `GET contents/${subdir}（子目录）→ 期望数组`, Array.isArray(r2.json), {
      url: r2.url,
      http: r2.http,
      'isArray': Array.isArray(r2.json),
      '条目数': Array.isArray(r2.json) ? r2.json.length : '(非数组)',
    });
  }

  // R3 单文件
  const fileEntry = Array.isArray(r1.json) ? r1.json.find((e) => e.type === 'file') : undefined;
  if (fileEntry) {
    const r3 = await req('GET', contentsPath(repo, fileEntry.name));
    const j = r3.json;
    rec('R3', `GET contents/${fileEntry.name}（单文件）→ 期望单对象`, !Array.isArray(j) && !!j && typeof j === 'object', {
      url: r3.url,
      http: r3.http,
      'isArray': Array.isArray(j),
      '字段': topKeys(j),
      'type': j?.type,
      'encoding': j?.encoding,
      'content 非空?': typeof j?.content === 'string' && j.content.length > 0,
      'content 长度': j?.content?.length,
      'size 字段': j?.size,
      'sha 长度': j?.sha?.length,
      '有 download_url?': 'download_url' in (j ?? {}),
    });
    // 目录条目上的 sha 与文件条目的 sha 是否同源
    rec('R3b', '目录条目 sha 与文件条目 sha 是否一致', undefined, {
      '目录条目 sha': fileEntry.sha,
      '文件条目 sha': j?.sha,
      '相同?': fileEntry.sha === j?.sha,
    });
  }

  // R4 不存在的路径
  const r4 = await req('GET', contentsPath(repo, '__v9_not_here__'));
  rec('R4', 'GET 不存在的路径 → 关键：用什么区分「无此文件」', undefined, {
    url: r4.url,
    http: r4.http,
    '原始 body': JSON.stringify(r4.body),
    'isArray': Array.isArray(r4.json),
    '数组长度': Array.isArray(r4.json) ? r4.json.length : '(非数组)',
    '判读': r4.http === 200 && Array.isArray(r4.json) && r4.json.length === 0
      ? '⚠ HTTP 200 + 空数组 = 路径不存在（不是 404）→ 必须靠 body 判断'
      : `需要人工判读：http=${r4.http} body=${JSON.stringify(r4.body).slice(0, 80)}`,
  });

  // R5 不存在的仓库
  const r5 = await req('GET', `/repos/oschina/__v9_no_such_repo__`);
  rec('R5', 'GET 不存在的仓库 → 期望 404', r5.http === 404, {
    url: r5.url,
    http: r5.http,
    'body 首 120 字符': r5.body.slice(0, 120),
  });

  // R6 匿名访问私有仓库
  if (TEST_REPO) {
    const r6 = await req('GET', `/repos/${TEST_REPO}`);
    const isPrivate = r6.json?.private === true;
    rec('R6', `匿名 GET /repos/${TEST_REPO} → 私有仓库应不可读`, undefined, {
      url: r6.url,
      http: r6.http,
      'private 字段': r6.json?.private,
      '完整名': r6.json?.full_name,
      '判读': isPrivate
        ? '⚠ 匿名竟然读到了 private=true 的仓库信息 → 说明仓库元数据对匿名可见，密文安全性更依赖加密本身'
        : (r6.http === 404 ? '✅ 匿名返回 404，仓库对匿名不可见' : `需人工判读 http=${r6.http}`),
    });
  }

  // R7 contents 是否支持 ref 参数
  const branch = 'master';
  const r7 = await req('GET', contentsPath(repo), { query: { ref: branch } });
  rec('R7', `GET contents/?ref=${branch} → 是否支持指定分支`, r7.http === 200, {
    url: r7.url,
    http: r7.http,
    '条目数': Array.isArray(r7.json) ? r7.json.length : '(非数组)',
  });
}

// ---------------------------------------------------------------- 写入探测

async function probeWrite() {
  if (!TOKEN) {
    rec('W0', '写入类探测', undefined, {
      '状态': '跳过 —— 未设置 GITEE_TOKEN',
      '原因': 'V9 的 W1–W9 需要真实令牌才能验证「创建/更新/冲突/删除」的行为',
      '如何补跑': '设置 GITEE_TOKEN（权限含 projects）与 GITEE_TEST_REPO 后加 --write 重跑',
    });
    return;
  }
  if (!TEST_REPO) {
    rec('W0', '写入类探测', undefined, {
      '状态': '跳过 —— 未指定测试仓库',
      '如何补跑': 'node tools/v9-probe-gitee.mjs --write --repo <owner>/<name>',
    });
    return;
  }
  const dir = 'v9-probe';
  const file = `${dir}/hello.json`;
  const auth = { token: TOKEN };

  // 安全检查：只允许写入「你自己的私有仓库」，绝不写别人的公开仓库
  const ANON_PUBLIC_ALLOWLIST = new Set([PUBLIC_REPO]);
  const owner = TEST_REPO.split('/')[0];
  const currentLogin = await req('GET', '/user', auth);
  if (currentLogin.http !== 200) {
    rec('W0', '写入类探测', undefined, {
      '状态': '中止 —— 令牌无效',
      'GET /user': `http=${currentLogin.http}`,
      'body': currentLogin.body.slice(0, 200),
      '下一步': '运行 node tools/diagnose-gitee-auth.mjs --repo <owner>/<name> 定位原因',
    });
    return;
  }
  const meta = await req('GET', `/repos/${TEST_REPO}`, auth);
  const isPublic = meta.json?.private === false;
  if (isPublic || ANON_PUBLIC_ALLOWLIST.has(TEST_REPO)) {
    rec('W0', '写入类探测', false, {
      '状态': '拒绝 —— 目标是公开仓库，不允许写入',
      'TEST_REPO': TEST_REPO,
      'private': meta.json?.private,
      '原因': '防止误伤他人的公开仓库；请改用你自己的私有仓库',
    });
    return;
  }
  if (owner.toLowerCase() !== String(currentLogin.json?.login ?? '').toLowerCase()) {
    rec('W0', '写入类探测', false, {
      '状态': '拒绝 —— 令牌所有者与仓库所有者不一致',
      '令牌登录名': currentLogin.json?.login,
      '仓库所有者': owner,
    });
    return;
  }

  // W1 报告仓库元数据（复用上面已取到的响应，不重复请求）
  const w1 = meta;
  rec('W1', `鉴权 GET /repos/${TEST_REPO} → 验证 PAT 与可见性`, w1.http === 200, {
    '令牌登录名': currentLogin.json?.login,
    http: w1.http,
    private: w1.json?.private,
    default_branch: w1.json?.default_branch,
    permission: w1.json?.permission ? JSON.stringify(w1.json.permission) : undefined,
    '判读': w1.json?.private === true
      ? '✅ 仓库为私有'
      : (w1.json?.private === false ? '❌ 仓库为公开 —— 本工具必须拒绝上传' : '需人工判读'),
  });
  if (w1.http !== 200) {
    rec('W1b', '无法读取仓库，中止写入探测', false, { http: w1.http, body: w1.body.slice(0, 200) });
    return;
  }
  const branch = w1.json?.default_branch || 'master';

  // W2 创建文件（不带 sha）
  const payload = JSON.stringify({ probe: 'v9', at: new Date().toISOString() });
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  const w2 = await req('POST', contentsPath(TEST_REPO, file), {
    ...auth,
    body: {
      access_token: TOKEN,
      content: b64,
      message: 'v9 probe: create',
      branch,
    },
  });
  rec('W2', 'POST contents → 创建文件（不带 sha）', w2.http === 201 || w2.http === 200, {
    http: w2.http,
    '返回字段': topKeys(w2.json),
    'content.sha': w2.json?.content?.sha,
    'commit.sha': w2.json?.commit?.sha,
    'body 首 200 字符': w2.http >= 400 ? w2.body.slice(0, 200) : '(成功)',
  });
  const shaAfterCreate = w2.json?.content?.sha;

  // W3 再次不带 sha 创建同名文件 → 期望报错
  const w3 = await req('POST', contentsPath(TEST_REPO, file), {
    ...auth,
    body: { access_token: TOKEN, content: b64, message: 'v9 probe: duplicate create', branch },
  });
  rec('W3', 'POST 重复创建同名文件 → 期望被拒（否则会静默覆盖）', w3.http >= 400, {
    http: w3.http,
    'body 首 200 字符': w3.body.slice(0, 200),
    '判读': w3.http >= 400 ? '✅ 被拒 → 可据此判断「文件已存在」' : '⚠ 未报错，创建/更新难以区分',
  });

  // W4 读取文件
  const w4 = await req('GET', contentsPath(TEST_REPO, file), { ...auth, query: { ref: branch } });
  rec('W4', 'GET 读取刚创建的文件 → 校验内容与 sha', w4.http === 200 && typeof w4.json?.content === 'string', {
    http: w4.http,
    sha: w4.json?.sha,
    'sha 与创建时一致?': w4.json?.sha === shaAfterCreate,
    'content 解码后与原文一致?': (() => {
      try { return Buffer.from(w4.json.content, 'base64').toString('utf8') === payload; } catch { return false; }
    })(),
    encoding: w4.json?.encoding,
  });

  // W5 用过期 sha 更新 → 期望冲突
  const w5 = await req('PUT', contentsPath(TEST_REPO, file), {
    ...auth,
    body: {
      access_token: TOKEN,
      content: Buffer.from('{"probe":"stale"}', 'utf8').toString('base64'),
      message: 'v9 probe: stale update',
      sha: '0000000000000000000000000000000000000000',
      branch,
    },
  });
  rec('W5', 'PUT 用错误 sha 更新 → 期望冲突（乐观锁是否可靠）', w5.http >= 400, {
    http: w5.http,
    'body 首 200 字符': w5.body.slice(0, 200),
    '判读': w5.http >= 400 ? '✅ 乐观锁生效' : '⚠ 未拦截，并发写会静默覆盖',
  });

  // W6 用正确 sha 更新
  const w6 = await req('PUT', contentsPath(TEST_REPO, file), {
    ...auth,
    body: {
      access_token: TOKEN,
      content: Buffer.from('{"probe":"updated"}', 'utf8').toString('base64'),
      message: 'v9 probe: update',
      sha: shaAfterCreate,
      branch,
    },
  });
  rec('W6', 'PUT 用正确 sha 更新 → 期望成功且 sha 变化', w6.http === 200 || w6.http === 201, {
    http: w6.http,
    '新 sha': w6.json?.content?.sha,
    '与旧 sha 不同?': w6.json?.content?.sha !== shaAfterCreate,
    'body 首 200 字符': w6.http >= 400 ? w6.body.slice(0, 200) : '(成功)',
  });
  const shaAfterUpdate = w6.json?.content?.sha;

  // W7 删除（带 sha）
  const w7 = await req('DELETE', contentsPath(TEST_REPO, file), {
    ...auth,
    body: {
      access_token: TOKEN,
      message: 'v9 probe: delete',
      sha: shaAfterUpdate,
      branch,
    },
  });
  rec('W7', 'DELETE 带 sha 删除 → 期望成功', w7.http === 200 || w7.http === 204, {
    http: w7.http,
    'body 首 200 字符': w7.http >= 400 ? w7.body.slice(0, 200) : '(成功)',
  });

  // W8 删除后读取 → 校验「不存在」的返回形态
  const w8 = await req('GET', contentsPath(TEST_REPO, file), { ...auth, query: { ref: branch } });
  rec('W8', '删除后 GET → 确认「不存在」的返回形态', undefined, {
    http: w8.http,
    '原始 body': JSON.stringify(w8.body),
    '与 R4（公开仓库不存在路径）形态一致?':
      w8.http === 200 && Array.isArray(w8.json) && w8.json.length === 0
        ? '✅ 一致：200 + 空数组'
        : `⚠ 不一致：http=${w8.http} body=${JSON.stringify(w8.body).slice(0, 80)}`,
  });

  // W9 清理临时目录（可能因目录内文件已删而无需操作）
  const w9 = await req('GET', contentsPath(TEST_REPO, dir), { ...auth, query: { ref: branch } });
  if (Array.isArray(w9.json) && w9.json.length === 0) {
    rec('W9', '清理临时目录', true, { '状态': '临时目录已为空，无需删除', 'note': 'Gitee 不会保留空目录' });
  } else {
    rec('W9', '清理临时目录', undefined, {
      '状态': '目录仍有内容，请手动清理',
      '内容': Array.isArray(w9.json) ? w9.json.map((e) => e.name).join(', ') : w9.body.slice(0, 120),
    });
  }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log('='.repeat(72));
  console.log('V9 探针 · Gitee OpenAPI v5 真实行为');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`模式: ${DO_WRITE ? '只读 + 写入探测' : '仅只读探测'}`);
  console.log(`公开只读仓库: ${PUBLIC_REPO}`);
  console.log(`测试写入仓库: ${TEST_REPO ?? '(未指定)'}`);
  console.log(`令牌: ${TOKEN ? '已提供（不回显）' : '未提供'}`);
  console.log('='.repeat(72));

  await probeReadShapes();
  if (DO_WRITE) await probeWrite();

  const fails = records.filter((r) => r.ok === false);
  const passes = records.filter((r) => r.ok === true);
  const infos = records.filter((r) => r.ok === undefined);

  console.log('\n' + '='.repeat(72));
  console.log(`小结: PASS=${passes.length}  FAIL=${fails.length}  INFO=${infos.length}`);
  if (fails.length) {
    console.log('未通过:');
    for (const f of fails) console.log(`  - ${f.id} ${f.title}`);
  }
  console.log('='.repeat(72));

  await mkdir(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, 'v9-report.json');
  await writeFile(
    outFile,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        mode: DO_WRITE ? 'read+write' : 'read-only',
        publicRepo: PUBLIC_REPO,
        testRepo: TEST_REPO ?? null,
        tokenProvided: Boolean(TOKEN),
        summary: { pass: passes.length, fail: fails.length, info: infos.length },
        records,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`报告已写入: ${outFile}`);
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((e) => {
  console.error('探针异常终止:', e);
  process.exitCode = 2;
});
