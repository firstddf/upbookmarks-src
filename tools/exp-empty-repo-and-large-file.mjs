#!/usr/bin/env node
/**
 * 阶段三之前的收尾实验：消掉参数文档里最后两个"未验证"项
 *
 *   实验 A：往「全新空仓库」首次上传时，branch 参数该怎么传（空仓库 default_branch 为 null）
 *   实验 B：单文件超过 1 MiB 时，GET contents 是否还返回 content
 *
 * 用法（需要令牌，权限含 projects）：
 *   $env:GITEE_TOKEN = '<令牌>'
 *   node tools/exp-empty-repo-and-large-file.mjs
 *   node tools/exp-empty-repo-and-large-file.mjs --repo example-owner/example-repo     # 跳过实验 A，用已有仓库
 *
 * 脚本会自己创建/删除测试仓库，并在结束时清理。绝不触碰 upbookmarks 以外的内容。
 */

const API_BASE = 'https://gitee.com/api/v5';
const TIMEOUT_MS = 120_000;          // 8 MiB 上传/下载留足时间
const TOKEN = process.env.GITEE_TOKEN;
const TEST_REPO_NAME = 'upbookmarks-v9b-experiment';   // 实验 A 自建的空仓库

const argv = process.argv.slice(2);
const repoIdx = argv.indexOf('--repo');
const EXISTING_REPO = repoIdx >= 0 ? argv[repoIdx + 1] : null;

const findings = [];
function find(id, title, detail) {
  findings.push({ id, title, detail });
  console.log(`\n[发现] ${id} · ${title}`);
  for (const [k, v] of Object.entries(detail)) console.log(`        ${k}: ${v}`);
}
const sec = (t) => `\n${'─'.repeat(66)}\n${t}\n${'─'.repeat(66)}`;

async function req(method, path, { token, query, body } = {}) {
  const url = new URL(API_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  if (token) url.searchParams.set('access_token', token);
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
    return { http: res.status, body: text, json };
  } catch (e) {
    return { http: 0, body: '', json: undefined, error: e.message };
  }
}

const contentsPath = (repo, path = '') => `/repos/${repo}/contents${path ? `/${path}` : ''}`;

async function main() {
  console.log('='.repeat(66));
  console.log('阶段三收尾实验');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`令牌: ${TOKEN ? '已提供（不回显）' : '未提供'}`);
  console.log('='.repeat(66));

  if (!TOKEN) {
    console.log('\n缺少 GITEE_TOKEN，无法进行写入实验。');
    console.log('请在本窗口执行：$env:GITEE_TOKEN = \'<令牌>\'  然后再运行本脚本。');
    process.exitCode = 2;
    return;
  }

  // 先确认令牌与登录名
  const me = await req('GET', '/user', { token: TOKEN });
  if (me.http !== 200) {
    console.log(`\n令牌无效：GET /user → http=${me.http} ${me.body.slice(0, 160)}`);
    process.exitCode = 2;
    return;
  }
  const login = me.json.login;
  console.log(`\n令牌登录名: ${login}`);

  let experimentRepo = EXISTING_REPO;

  // ============================================================ 实验 A
  if (!EXISTING_REPO) {
    console.log(sec('实验 A：空仓库首次上传的 branch 行为'));

    // 若同名仓库已存在，先删掉，保证是全新空仓库
    const pre = await req('GET', `/repos/${login}/${TEST_REPO_NAME}`, { token: TOKEN });
    if (pre.http === 200) {
      console.log(`  同名仓库已存在，先删除以保证「全新空仓库」场景：${login}/${TEST_REPO_NAME}`);
      const del = await req('DELETE', `/repos/${login}/${TEST_REPO_NAME}`, { token: TOKEN });
      console.log(`  删除结果: http=${del.http}`);
      if (del.http >= 400) { console.log(`  删除失败: ${del.body.slice(0, 160)}`); process.exitCode = 1; return; }
    }

    // 创建空仓库：auto_init=false 保证零提交
    const created = await req('POST', '/user/repos', {
      token: TOKEN,
      body: {
        access_token: TOKEN,
        name: TEST_REPO_NAME,
        private: true,
        auto_init: false,
        description: 'V9b 收尾实验临时仓库，可随时删除',
      },
    });
    console.log(`  创建仓库: http=${created.http}`);
    if (created.http !== 201 && created.http !== 200) {
      console.log(`  创建失败: ${created.body.slice(0, 200)}`);
      process.exitCode = 1;
      return;
    }
    experimentRepo = `${login}/${TEST_REPO_NAME}`;
    console.log(`  新仓库: ${experimentRepo}  private=${created.json?.private}  default_branch=${JSON.stringify(created.json?.default_branch)}`);

    find('A0', '空仓库的元数据', {
      'private': created.json?.private,
      'default_branch': JSON.stringify(created.json?.default_branch),
      'empty_repo 字段': created.json?.empty_repo,
      '判读': created.json?.default_branch == null
        ? 'default_branch 为 null / 未定义 → 首次上传不能依赖它'
        : `default_branch 直接可用：${created.json?.default_branch}`,
    });

    // A1：省略 branch 创建文件
    const a1File = 'exp-a/no-branch.txt';
    const a1 = await req('POST', contentsPath(experimentRepo, a1File), {
      token: TOKEN,
      body: { access_token: TOKEN, content: Buffer.from('no branch param', 'utf8').toString('base64'), message: 'exp A1: omit branch' },
    });
    find('A1', '空仓库首次创建，**省略 branch 参数**', {
      http: a1.http,
      'content.sha': a1.json?.content?.sha,
      'commit.sha': a1.json?.commit?.sha,
      'body 首 160': a1.http >= 400 ? a1.body.slice(0, 160) : '(成功)',
      '判读': a1.http === 201 || a1.http === 200
        ? '✅ 可以不传 branch —— 实现里空仓库场景可直接省略'
        : '❌ 省略 branch 失败，需要显式传分支名',
    });

    // A2：传 branch: 'master'
    const a2File = 'exp-a/master-branch.txt';
    const a2 = await req('POST', contentsPath(experimentRepo, a2File), {
      token: TOKEN,
      body: { access_token: TOKEN, content: Buffer.from('master branch', 'utf8').toString('base64'), message: 'exp A2: branch=master', branch: 'master' },
    });
    find('A2', '同一空仓库，创建时传 `branch: "master"`', {
      http: a2.http,
      'content.sha': a2.json?.content?.sha,
      'body 首 160': a2.http >= 400 ? a2.body.slice(0, 160) : '(成功)',
      '判读': a2.http === 201 || a2.http === 200 ? 'master 可用' : 'master 不可用',
    });

    // A3：这时再读仓库元数据，default_branch 变成什么
    const after = await req('GET', `/repos/${experimentRepo}`, { token: TOKEN });
    find('A3', '有提交之后再读仓库元数据的 default_branch', {
      http: after.http,
      'default_branch': JSON.stringify(after.json?.default_branch),
      '判读': '实现应在首次上传后重新读取或直接固定使用 master',
    });

    // A4：确认两个分支是否同一个（若 A2 建了新分支，A1 的文件可能不在 master 下）
    const listMaster = await req('GET', contentsPath(experimentRepo, 'exp-a'), { token: TOKEN, query: { ref: 'master' } });
    find('A4', '列出 exp-a/ 目录（ref=master），确认 A1/A2 是否落在同一分支', {
      http: listMaster.http,
      '条目': Array.isArray(listMaster.json) ? listMaster.json.map((e) => e.name).join(', ') : listMaster.body.slice(0, 160),
    });
  } else {
    console.log(sec('实验 A 跳过（指定了 --repo，复用已有仓库）'));
    console.log(`  使用仓库: ${experimentRepo}`);
  }

  // ============================================================ 实验 B
  console.log(sec('实验 B：大文件的 content 行为（爬阶梯测量）'));

  // 目标 base64 体积。base64 会放大 4/3，所以明文字节数按此反推。
  // 8 MiB 与参数文档的 MAX_SNAPSHOT_BYTES 对齐，是必须验证的上界。
  const STEPS = [
    0.5 * 1024 * 1024,
    1 * 1024 * 1024,
    2 * 1024 * 1024,
    4 * 1024 * 1024,
    8 * 1024 * 1024,
  ];
  const magic = 'UPBOOKMARKS-EXP-B\n';

  const bResults = [];
  for (const targetB64 of STEPS) {
    const plainBytes = Math.floor(targetB64 * 3 / 4);
    const text = magic + 'X'.repeat(plainBytes - magic.length);
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const path = `exp-b/step-${Math.round(targetB64 / 1024)}k.bin`;

    const t0 = Date.now();
    const up = await req('POST', contentsPath(experimentRepo, path), {
      token: TOKEN,
      body: { access_token: TOKEN, content: b64, message: `exp B: ${Math.round(targetB64 / 1024)} KiB` },
    });
    const upMs = Date.now() - t0;

    let read = null;
    if (up.http < 400) {
      const t1 = Date.now();
      const rd = await req('GET', contentsPath(experimentRepo, path), { token: TOKEN });
      const j = rd.json ?? {};
      const hasContent = typeof j.content === 'string' && j.content.length > 0;
      read = {
        http: rd.http,
        ms: Date.now() - t1,
        encoding: j.encoding,
        size: j.size,
        hasContent,
        contentLen: typeof j.content === 'string' ? j.content.length : 0,
        hasDownloadUrl: 'download_url' in j,
      };
    }

    const row = {
      targetB64MiB: (targetB64 / 1024 / 1024).toFixed(2),
      plainMiB: (Buffer.byteLength(text) / 1024 / 1024).toFixed(2),
      b64MiB: (b64.length / 1024 / 1024).toFixed(2),
      postHttp: up.http,
      postMs: upMs,
      postErr: up.http >= 400 ? up.body.slice(0, 120) : '',
      read,
    };
    bResults.push(row);
    console.log(
      `  ${row.targetB64MiB} MiB: POST=${up.http} (${upMs}ms)` +
        (read ? `  GET=${read.http} (${read.ms}ms) encoding=${JSON.stringify(read.encoding)} content=${read.hasContent ? `${read.contentLen}字符` : '空'}` : `  错误=${row.postErr}`),
    );
  }

  console.log('\n  汇总表：');
  for (const r of bResults) {
    console.log(
      `    明文 ${r.plainMiB} MiB → POST ${r.postHttp}` +
        (r.read ? ` / GET ${r.read.http} / encoding=${JSON.stringify(r.read.encoding)} / content ${r.read.hasContent ? '有' : '无'} / download_url ${r.read.hasDownloadUrl ? '有' : '无'}` : ` / ${r.postErr}`),
    );
  }

  const firstNoContent = bResults.find((r) => r.read && !r.read.hasContent);
  const firstPostFail = bResults.find((r) => r.postHttp >= 400);
  find('B', '大文件行为汇总', {
    '实测档位': bResults.map((r) => `${r.plainMiB}MiB`).join(', '),
    'POST 第一次失败的档位': firstPostFail ? `${firstPostFail.plainMiB} MiB (http=${firstPostFail.postHttp})` : '全部成功（8 MiB 可上传）',
    'content 第一次变空的档位': firstNoContent ? `${firstNoContent.plainMiB} MiB` : '全部档位 content 均有内容',
    '判读': firstNoContent
      ? `⚠ 超过约 ${firstNoContent.plainMiB} MiB 后 content 不再内联 → 读取路径必须按大小分流或改用原始数据接口`
      : '✅ 直到 8 MiB 都可在同一次 GET 里拿到 base64 内容 → 可用统一读取路径',
  });

  // B-download：取一个「content 为空」的档位，验证 download_url 兜底
  const probeRead = (firstNoContent ?? bResults[bResults.length - 1])?.read;
  if (probeRead?.hasDownloadUrl) {
    const path = `exp-b/step-${Math.round((firstNoContent?.targetB64MiB ?? bResults[bResults.length - 1].targetB64MiB) * 1024)}k.bin`;
    const rd = await req('GET', contentsPath(experimentRepo, path), { token: TOKEN });
    const du = rd.json?.download_url;
    if (du) {
      let raw;
      try {
        const direct = await fetch(du, {
          headers: { Authorization: `Bearer ${TOKEN}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        raw = { http: direct.status, body: await direct.text() };
      } catch (e) {
        raw = { http: 0, body: '', error: e.message };
      }
      find('B-download', '兜底路径：用 download_url 取原始数据', {
        '路径': path,
        'download_url': String(du).slice(0, 110),
        http: raw.http,
        '返回字节数': raw.body?.length,
        '首 20 字符正确?': raw.body?.startsWith(magic.trim()),
        '错误': raw.error,
        '判读': raw.http === 200 && raw.body?.startsWith(magic.trim())
          ? '✅ download_url 可作为大文件的读取兜底'
          : '⚠ download_url 不可用，需要另找兜底（原始数据接口 / 分片）',
      });
    }
  }

  // ============================================================ 清理
  console.log(sec('清理'));
  if (!EXISTING_REPO) {
    const del = await req('DELETE', `/repos/${experimentRepo}`, { token: TOKEN });
    console.log(`  删除临时仓库 ${experimentRepo}: http=${del.http}`);
    if (del.http >= 400) console.log(`  ⚠ 请手动删除：${del.body.slice(0, 160)}`);
  } else {
    // 列出两个实验目录，逐个删除（文件名是动态生成的）
    for (const d of ['exp-a', 'exp-b']) {
      const list = await req('GET', contentsPath(experimentRepo, d), { token: TOKEN });
      if (!Array.isArray(list.json)) {
        console.log(`  ${d}/: 无内容（http=${list.http}）`);
        continue;
      }
      for (const entry of list.json) {
        const del = await req('DELETE', contentsPath(experimentRepo, `${d}/${entry.name}`), {
          token: TOKEN,
          body: { access_token: TOKEN, message: 'exp cleanup', sha: entry.sha },
        });
        console.log(`  删除 ${d}/${entry.name}: http=${del.http}`);
      }
    }
  }

  console.log(sec('小结'));
  console.log(`共 ${findings.length} 条发现`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('实验异常终止:', e);
  process.exitCode = 2;
});
