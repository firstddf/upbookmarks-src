#!/usr/bin/env node
/**
 * V9 写入探测的前置诊断
 *
 * 目的：当 --write 的 W1 返回 404 时，区分三种互不相同的原因：
 *   (a) 令牌根本没传进 Node 进程
 *   (b) 令牌传进来了但无效 / 权限不含 projects
 *   (c) 令牌有效，但仓库不存在，或令牌无权访问该私有仓库
 *
 * 用法：
 *   node tools/diagnose-gitee-auth.mjs --repo <owner>/<name>
 */

const API_BASE = 'https://gitee.com/api/v5';
const TIMEOUT_MS = 30_000;

const argv = process.argv.slice(2);
const idx = argv.indexOf('--repo');
const REPO = idx >= 0 ? argv[idx + 1] : process.env.GITEE_TEST_REPO;
const TOKEN = process.env.GITEE_TOKEN;

async function req(method, path, { token, query } = {}) {
  const url = new URL(API_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  if (token) url.searchParams.set('access_token', token);
  const shown = API_BASE + path + (query ? `?${new URLSearchParams(query)}` : '') + (token ? '&access_token=<hidden>' : '');
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { http: res.status, body: text, json, shown };
  } catch (e) {
    return { http: 0, body: '', json: undefined, shown, error: e.message };
  }
}

const line = (k, v) => console.log(`    ${k}: ${v}`);

async function main() {
  console.log('='.repeat(70));
  console.log('Gitee 鉴权诊断');
  console.log('='.repeat(70));

  // ---- 检查 0：令牌到底有没有进到 Node 进程
  console.log('\n[0] 令牌是否传入 Node 进程');
  line('process.env.GITEE_TOKEN 存在?', TOKEN ? '是' : '否');
  if (TOKEN) {
    line('长度', TOKEN.length);
    line('首尾字符', `"${TOKEN[0]}…${TOKEN[TOKEN.length - 1]}"`);
    line('含空白字符?', /\s/.test(TOKEN) ? '⚠ 是（可能粘贴时带了换行/空格）' : '否');
    line('看起来像十六进制?', /^[0-9a-f]+$/i.test(TOKEN) ? '是（Gitee 令牌通常如此）' : '否（Gitee 也有非十六进制令牌，不一定是问题）');
  }
  line('GITEE_TEST_REPO / --repo', REPO ?? '(未指定)');

  // ---- 检查 1：令牌有效性（不依赖任何仓库）
  console.log('\n[1] 令牌有效性：GET /user （与仓库无关的端点）');
  const u = await req('GET', '/user', { token: TOKEN });
  line('http', u.http);
  if (u.http === 200) {
    line('login', u.json?.login);
    line('name', u.json?.name);
    line('判读', '✅ 令牌有效 —— 问题在仓库（不存在或令牌无权访问）');
  } else if (u.http === 401) {
    line('body', u.body.slice(0, 200));
    line('判读', TOKEN
      ? '❌ 令牌无效 / 已过期 / 已被吊销 → 请重新生成'
      : '❌ 未传令牌 → 你在 PowerShell 里设置的 $env:GITEE_TOKEN 没有传给 node');
  } else {
    line('body', u.body.slice(0, 200));
    line('判读', `需人工判读 http=${u.http}`);
  }

  // ---- 检查 2：仓库是否存在且可访问
  if (REPO) {
    console.log(`\n[2] 仓库可见性：GET /repos/${REPO}`);
    const anon = await req('GET', `/repos/${REPO}`);
    line('匿名 http', anon.http);
    const auth = await req('GET', `/repos/${REPO}`, { token: TOKEN });
    line('带令牌 http', auth.http);
    line('private', auth.json?.private);
    line('default_branch', auth.json?.default_branch);
    line('permission', auth.json?.permission ? JSON.stringify(auth.json.permission) : '(无)');

    console.log('\n[2b] 该仓库是否出现在「令牌可见的仓库列表」里：GET /user/repos');
    const mine = await req('GET', '/user/repos', { token: TOKEN, query: { per_page: '100', sort: 'updated' } });
    line('http', mine.http);
    if (Array.isArray(mine.json)) {
      line('可见仓库总数', mine.json.length);
      const hit = mine.json.find((r) => r.full_name?.toLowerCase() === REPO.toLowerCase());
      line('目标仓库在列表里?', hit ? `是（private=${hit.private}）` : '否');
      if (!hit) {
        console.log('    同名或相近的仓库：');
        const near = mine.json.filter((r) => /upbookmarks|test/i.test(r.full_name ?? ''));
        if (near.length) for (const r of near) console.log(`      - ${r.full_name}  private=${r.private}`);
        else console.log('      （没有名字含 upbookmarks 或 test 的仓库）');
      }
    } else {
      line('body', mine.body.slice(0, 200));
    }
  }

  // ---- 结论
  console.log('\n' + '='.repeat(70));
  console.log('结论');
  console.log('='.repeat(70));
  if (!TOKEN) {
    console.log('令牌没有进入 Node 进程。PowerShell 里的 $env:GITEE_TOKEN 只在当前窗口有效；');
    console.log('如果你在另一个窗口设置、或设置后新开了窗口，它不会生效。');
  } else if (u.http === 401) {
    console.log('令牌存在但被拒绝 → 请到 https://gitee.com/profile/personal_access_tokens 重新生成，');
    console.log('并确认勾选了 projects 权限。');
  } else if (u.http === 200 && REPO) {
    console.log('令牌有效。若上面 [2] 的「带令牌 http」仍是 404，则仓库名不对或该令牌看不到这个仓库。');
  } else {
    console.log('请把以上输出完整贴回，以便进一步判读。');
  }
  console.log('='.repeat(70));
}

main().catch((e) => {
  console.error('诊断异常终止:', e);
  process.exitCode = 2;
});
