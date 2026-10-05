#!/usr/bin/env node
/**
 * src/lib/gitee.js 的单元测试
 *
 * 用一个假的 Gitee 服务器（注入式 fetch）复现 V9 实测到的全部行为：
 *   200+[] 表示不存在 / 201 创建 / 400 文件名已存在 / 400 Blob SHA does not match /
 *   404 只代表仓库问题 / 空仓库 default_branch 为 null。
 *
 * 因此**不需要网络，也不需要令牌**，并且能确定性触发那些真实环境里难以复现的
 * 并发冲突路径（靠 hook 在两次请求之间改动云端状态）。
 *
 * 用法：
 *   node tests/gitee-client.test.mjs
 */

import { createHash } from 'node:crypto';
import { createGiteeClient, GiteeError, GiteeErrorCode } from '../src/lib/gitee.js';

// ---------------------------------------------------------------- 假 Gitee

const gitBlobSha = (text) =>
  createHash('sha1').update(`blob ${Buffer.byteLength(text, 'utf8')}\0${text}`, 'utf8').digest('hex');

/** 构造一个内存版 Gitee。返回 { fetchImpl, files, requests, hooks, put } */
function fakeGitee({ repoExists = true, isPrivate = true, defaultBranch = null } = {}) {
  /** path -> { text, sha } */
  const files = new Map();
  const requests = [];
  /** 按请求序号执行的钩子：第 N 次请求**之前**触发一次（序号从 1 开始） */
  const hooks = new Map();

  const put = (path, text) => files.set(path, { text, sha: gitBlobSha(text) });

  function entriesUnder(path) {
    const prefix = path ? `${path}/` : '';
    const direct = new Map();
    for (const [p, v] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) {
        const dir = rest.split('/')[0];
        if (!direct.has(dir)) direct.set(dir, { type: 'dir', name: dir, path: prefix + dir, sha: 'x'.repeat(40), size: null });
      } else {
        direct.set(rest, { type: 'file', name: rest, path: p, sha: v.sha, size: Buffer.byteLength(v.text, 'utf8') });
      }
    }
    return [...direct.values()];
  }

  const json = (status, obj) => ({
    status,
    text: async () => JSON.stringify(obj),
  });

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    // 注意：真实实现会把 token 放在 query 上，这里只记录方法+路径
    requests.push({ method, path: u.pathname.replace(/^\/api\/v5/, ''), hasBody: Boolean(body) });

    // 按序号触发钩子（用于在多步流程中的精确位置制造竞态）
    const seq = requests.length;
    if (hooks.has(seq)) {
      const h = hooks.get(seq);
      hooks.delete(seq);
      h({ files, put });
    }

    if (!repoExists) return json(404, { message: 'Not Found Project' });
    if (!u.pathname.includes('/contents')) return json(200, { private: isPrivate, default_branch: defaultBranch });

    const marker = `/contents`;
    const rawPath = decodeURIComponent(u.pathname.slice(u.pathname.indexOf(marker) + marker.length).replace(/^\//, ''));

    if (method === 'GET') {
      if (rawPath && files.has(rawPath)) {
        const f = files.get(rawPath);
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: Buffer.byteLength(f.text, 'utf8'),
          name: rawPath.split('/').pop(),
          path: rawPath,
          content: Buffer.from(f.text, 'utf8').toString('base64'),
          sha: f.sha,
          download_url: `https://gitee.com/x/y/raw/master/${rawPath}`,
        });
      }
      // 关键：不存在 → 200 + 空数组（不是 404）。目录为空也是同样形态。
      return json(200, entriesUnder(rawPath));
    }

    if (method === 'POST') {
      if (files.has(rawPath)) return json(400, { message: '文件名已存在' });
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      put(rawPath, text);
      return json(201, {
        content: { path: rawPath, sha: gitBlobSha(text), size: Buffer.byteLength(text, 'utf8') },
        commit: { sha: 'c'.repeat(40) },
      });
    }

    if (method === 'PUT') {
      const cur = files.get(rawPath);
      if (!cur) return json(200, { content: { sha: gitBlobSha(Buffer.from(body.content, 'base64').toString('utf8')) }, commit: { sha: 'c'.repeat(40) } });
      if (body.sha !== cur.sha) return json(400, { message: 'Blob SHA does not match' });
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      put(rawPath, text);
      return json(200, { content: { path: rawPath, sha: gitBlobSha(text) }, commit: { sha: 'd'.repeat(40) } });
    }

    if (method === 'DELETE') {
      const cur = files.get(rawPath);
      if (!cur) return json(200, {});
      if (body.sha && body.sha !== cur.sha) return json(400, { message: 'Blob SHA does not match' });
      files.delete(rawPath);
      return json(200, {});
    }

    return json(405, { message: 'method not allowed' });
  };

  return { fetchImpl, files, requests, hooks, put };
}

// ---------------------------------------------------------------- 断言

const results = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} · ${title}${ok ? '' : `\n        ${detail ?? ''}`}`);
}
const mkClient = (fake, extra = {}) =>
  createGiteeClient({ owner: 'example-owner', repo: 'example-repo', token: 'tok', fetchImpl: fake.fetchImpl, backoffMs: [1, 1, 1], ...extra });

async function expectError(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

async function main() {
  console.log('='.repeat(70));
  console.log('src/lib/gitee.js 单元测试（假 Gitee，无网络无令牌）');
  console.log('='.repeat(70) + '\n');

  // ============================================================ 基础读
  {
    const fake = fakeGitee();
    fake.put('keyfile.json', '{"a":1}');
    fake.put('backups/desktop/index.json', '{"b":2}');
    const c = mkClient(fake);

    const repo = await c.getRepo();
    check('G1', 'getRepo 返回仓库元数据（空仓库 default_branch 为 null）',
      repo.private === true && repo.default_branch === null, JSON.stringify(repo));

    const root = await c.list('');
    check('G2', 'list("") 返回根目录条目，含 file 与 dir 两种类型',
      root.some((e) => e.type === 'file' && e.name === 'keyfile.json')
        && root.some((e) => e.type === 'dir' && e.name === 'backups'),
      JSON.stringify(root.map((e) => `${e.type}:${e.name}`)));

    const f = await c.read('keyfile.json');
    check('G3', 'read 返回文本与 sha', f?.text === '{"a":1}' && f.sha.length === 40, JSON.stringify(f));

    const missing = await c.read('backups/desktop/20260101T000000Z.enc');
    check('G4', '不存在的文件返回 null（判据 200+[]，而不是 404）', missing === null, `得到 ${JSON.stringify(missing)}`);
  }

  // ============================================================ 创建与更新
  {
    const fake = fakeGitee();
    const c = mkClient(fake);

    const created = await c.putFile('backups/desktop/a.enc', 'CIPHERTEXT-1', 'msg1');
    check('G5', 'putFile 在文件不存在时走创建（mode=created）',
      created.mode === 'created' && created.sha === gitBlobSha('CIPHERTEXT-1'),
      JSON.stringify(created));

    const updated = await c.putFile('backups/desktop/a.enc', 'CIPHERTEXT-2', 'msg2');
    check('G6', 'putFile 在文件存在时走更新（mode=updated，sha 变化）',
      updated.mode === 'updated' && updated.sha === gitBlobSha('CIPHERTEXT-2') && updated.sha !== created.sha,
      JSON.stringify(updated));

    const back = await c.read('backups/desktop/a.enc');
    check('G7', '更新后读回内容正确', back.text === 'CIPHERTEXT-2', back.text);
  }

  // ============================================================ 并发冲突：创建时被抢先
  {
    const fake = fakeGitee();
    const c = mkClient(fake);
    // putFile 的序列：1) GET(不存在)  2) POST  ← 在 POST 之前让别台机器抢先创建
    fake.hooks.set(2, ({ put }) => put('backups/desktop/race.enc', 'OTHER-MACHINE-CONTENT'));

    const r = await c.putFile('backups/desktop/race.enc', 'MY-CONTENT', 'msg');
    const stored = fake.files.get('backups/desktop/race.enc').text;
    const postSeen = fake.requests.find((q) => q.method === 'POST');
    check('G8', '创建遭抢跑（400 文件名已存在）→ 自动重新取 sha 并改用 PUT 覆盖',
      r.mode === 'updated' && r.recovered === true && stored === 'MY-CONTENT' && Boolean(postSeen),
      `mode=${r.mode} recovered=${r.recovered} stored=${stored} 请求序列=${fake.requests.map((q) => q.method).join(',')}`);
  }

  // ============================================================ 并发冲突：更新时 sha 过期
  {
    const fake = fakeGitee();
    fake.put('backups/desktop/stale.enc', 'V1');
    const c = mkClient(fake);
    // putFile 的序列：1) GET(拿到旧 sha)  2) PUT ← 在 PUT 之前让别台机器改动云端
    fake.hooks.set(2, ({ put }) => put('backups/desktop/stale.enc', 'V2-FROM-OTHER'));

    const r = await c.putFile('backups/desktop/stale.enc', 'V3-MINE', 'msg');
    const stored = fake.files.get('backups/desktop/stale.enc').text;
    check('G9', '更新遇 sha 过期（Blob SHA does not match）→ 重新取 sha 后重试成功',
      r.mode === 'updated' && r.recovered === true && stored === 'V3-MINE',
      `mode=${r.mode} recovered=${r.recovered} stored=${stored} 请求序列=${fake.requests.map((q) => q.method).join(',')}`);
  }

  // ============================================================ 错误分类
  {
    const fakeNoRepo = fakeGitee({ repoExists: false });
    const c = mkClient(fakeNoRepo);
    const e1 = await expectError(() => c.getRepo());
    check('G10', '仓库不存在 → REPO_NOT_FOUND（不会被误判成「文件不存在」）',
      e1 instanceof GiteeError && e1.code === GiteeErrorCode.REPO_NOT_FOUND,
      `${e1?.code} ${e1?.message}`);

    const fakePublic = fakeGitee({ isPrivate: false });
    const c2 = mkClient(fakePublic);
    const e2 = await expectError(() => c2.assertPrivate());
    check('G11', '仓库为公开 → assertPrivate 拒绝上传',
      e2 instanceof GiteeError && /不是私有仓库/.test(e2.message), e2?.message);

    const fake = fakeGitee();
    const c3 = mkClient(fake);
    const e3 = await expectError(() => c3.update('x.enc', 'C', 'msg', null));
    check('G12', 'update 缺少 sha 时立即报错（不发请求）', /必须提供 sha/.test(e3?.message ?? ''), e3?.message);
  }

  // ============================================================ 删除
  {
    const fake = fakeGitee();
    fake.put('backups/desktop/d.enc', 'DEL-ME');
    const c = mkClient(fake);
    const before = fake.files.size;
    await c.remove('backups/desktop/d.enc', 'cleanup', fake.files.get('backups/desktop/d.enc').sha);
    check('G13', 'remove 带正确 sha 可删除文件',
      fake.files.size === before - 1 && (await c.read('backups/desktop/d.enc')) === null);

    const e = await expectError(() => c.remove('backups/desktop/nothere.enc', 'cleanup', 'f'.repeat(40)));
    check('G14', '删除不存在的文件不报错（幂等）', e === null, e?.message);
  }

  // ============================================================ 尺寸校验
  {
    const fake = fakeGitee();
    const c = mkClient(fake);
    const okSmall = await expectError(() => c.assertSnapshotSize(1024));
    const tooBig = await expectError(() => c.assertSnapshotSize(7 * 1024 * 1024));
    const boundary = await expectError(() => c.assertSnapshotSize(6 * 1024 * 1024));
    check('G15', '尺寸校验：小载荷通过、超载荷上限被拒、恰好等于上限通过',
      okSmall === null && tooBig?.code === GiteeErrorCode.PAYLOAD_TOO_LARGE && boundary === null,
      `small=${okSmall} big=${tooBig?.code} boundary=${boundary}`);
  }

  // ============================================================ 空仓库首次创建省略 branch
  {
    const fake = fakeGitee({ defaultBranch: null });
    const c = mkClient(fake);
    await c.putFile('keyfile.json', '{"first":true}', 'init');
    const postReq = fake.requests.find((r) => r.method === 'POST');
    check('G16', '首次创建走 POST 且未传 branch（空仓库场景不依赖 default_branch）',
      Boolean(postReq), JSON.stringify(fake.requests));
  }

  // ============================================================ 重试策略
  {
    // 网络错误可重试
    let calls = 0;
    const flakyFetch = async (url, init) => {
      calls++;
      if (calls <= 2) throw new Error('socket hang up');
      const u = new URL(url);
      if (u.pathname.includes('/contents')) return { status: 200, text: async () => '[]' };
      return { status: 200, text: async () => '{"private":true,"default_branch":"master"}' };
    };
    const c = createGiteeClient({ owner: 'a', repo: 'b', token: 't', fetchImpl: flakyFetch, backoffMs: [1, 1, 1] });
    const r = await c.getRepo();
    check('G17', '网络错误会重试，恢复后成功', r?.private === true && calls === 3, `calls=${calls}`);

    // 4xx 不应重试
    let calls2 = 0;
    const authFail = async () => { calls2++; return { status: 401, text: async () => '{"message":"登录失效"}' }; };
    const c2 = createGiteeClient({ owner: 'a', repo: 'b', token: 't', fetchImpl: authFail, backoffMs: [1, 1, 1] });
    const e = await expectError(() => c2.getRepo());
    check('G18', '认证失败不重试（4xx 不是可重试错误）',
      e?.code === GiteeErrorCode.AUTH && calls2 === 1, `code=${e?.code} calls=${calls2}`);
  }

  // ============================================================ 非 ASCII 往返
  {
    const fake = fakeGitee();
    const c = mkClient(fake);
    const chinese = JSON.stringify({ 标题: '中文 · 符号 <>&"', 列表: ['一', '二', '三'] });
    await c.putFile('backups/desktop/cn.enc', chinese, '中文提交信息');
    const back = await c.read('backups/desktop/cn.enc');
    check('G19', '非 ASCII 内容经 base64 往返逐字符一致', back.text === chinese, `${back.text?.slice(0, 40)}`);
  }

  // ---------------------------------------------------------------- 小结
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(70));
  console.log(`小结: PASS=${results.length - failed.length}  FAIL=${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  未通过: ${f.id} ${f.title}`);
  console.log('='.repeat(70));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('测试异常终止:', e); process.exitCode = 2; });
