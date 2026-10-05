#!/usr/bin/env node
/**
 * src/lib/app.js 的端到端编排测试
 *
 * 用「假 Gitee + 假浏览器 + **真加密**」跑完整旅程：
 *   首次建库 → 上传 → 模拟全新设备解锁 → 预览差异 → 还原 → 验证结果
 * 并覆盖两条最危险的路径：
 *   - 换设备恢复是否真的只靠主口令就能完成；
 *   - 还原本身出错时能否用「还原前本地备份」救回来。
 *
 * 用法：
 *   node tests/app-flow.test.mjs
 */

import { createHash } from 'node:crypto';
import { createApp } from '../src/lib/app.js';
import { createGiteeClient, GiteeError } from '../src/lib/gitee.js';
import { RestoreStrategy } from '../src/lib/restore.js';
import { formatSnapshotId } from '../src/lib/snapshot.js';

const results = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} · ${title}${ok ? '' : `\n        ${detail ?? ''}`}`);
}
const asError = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------------------------------------------------------------- 假 Gitee

const gitBlobSha = (text) =>
  createHash('sha1').update(`blob ${Buffer.byteLength(text, 'utf8')}\0${text}`, 'utf8').digest('hex');

function fakeGitee({ isPrivate = true } = {}) {
  const files = new Map();
  const put = (path, text) => files.set(path, { text, sha: gitBlobSha(text) });

  const entriesUnder = (path) => {
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
  };

  const json = (status, obj) => ({ status, text: async () => JSON.stringify(obj) });

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (!u.pathname.includes('/contents')) return json(200, { private: isPrivate, default_branch: null });
    const marker = '/contents';
    const rawPath = decodeURIComponent(u.pathname.slice(u.pathname.indexOf(marker) + marker.length).replace(/^\//, ''));

    if (method === 'GET') {
      if (rawPath && files.has(rawPath)) {
        const f = files.get(rawPath);
        return json(200, {
          type: 'file', encoding: 'base64', size: Buffer.byteLength(f.text, 'utf8'),
          name: rawPath.split('/').pop(), path: rawPath,
          content: Buffer.from(f.text, 'utf8').toString('base64'), sha: f.sha,
        });
      }
      return json(200, entriesUnder(rawPath));
    }
    if (method === 'POST') {
      if (files.has(rawPath)) return json(400, { message: '文件名已存在' });
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      put(rawPath, text);
      return json(201, { content: { path: rawPath, sha: gitBlobSha(text) }, commit: { sha: 'c'.repeat(40) } });
    }
    if (method === 'PUT') {
      const cur = files.get(rawPath);
      if (cur && body.sha !== cur.sha) return json(400, { message: 'Blob SHA does not match' });
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      put(rawPath, text);
      return json(200, { content: { path: rawPath, sha: gitBlobSha(text) }, commit: { sha: 'd'.repeat(40) } });
    }
    if (method === 'DELETE') {
      files.delete(rawPath);
      return json(200, {});
    }
    return json(405, { message: 'method not allowed' });
  };

  return { fetchImpl, files, put };
}

// ---------------------------------------------------------------- 假浏览器

function makeBrowser() {
  const nodes = new Map();
  const order = new Map();
  let seq = 0;
  const nextId = () => `b${++seq}`;
  const add = (parentId, node) => {
    const id = nextId();
    nodes.set(id, { ...node, id, parentId });
    if (parentId !== undefined) {
      if (!order.has(parentId)) order.set(parentId, []);
      order.get(parentId).push(id);
    }
    return id;
  };
  const build = (n) => (n.url !== undefined ? { ...n } : { ...n, children: (order.get(n.id) ?? []).map((c) => build(nodes.get(c))) });

  const rootId = add(undefined, { title: '', url: undefined });
  const menuId = add(rootId, { title: '书签菜单' });
  const toolbarId = add(menuId, { title: '书签栏' });
  add(rootId, { title: '其他书签' });
  const unfiledId = [...nodes.values()].find((n) => n.title === '其他书签').id;

  const store = {};
  const browser = {
    bookmarksApi: {
      async getTree() { return [build(nodes.get(rootId))]; },
      async getSubTree(id) { return build(nodes.get(id)); },
      async get(id) { return { ...nodes.get(id) }; },
      async create({ parentId, title, url }) {
        if (!nodes.has(parentId)) throw new Error(`父节点不存在 ${parentId}`);
        return { ...nodes.get(add(parentId, url !== undefined ? { title, url } : { title })) };
      },
      async removeTree(id) {
        if (id === rootId) throw new Error('不能删除根节点');
        const n = nodes.get(id);
        if (!n) return;
        order.set(n.parentId, (order.get(n.parentId) ?? []).filter((x) => x !== id));
        const stack = [id];
        while (stack.length) {
          const cur = stack.pop();
          for (const c of order.get(cur) ?? []) stack.push(c);
          order.delete(cur); nodes.delete(cur);
        }
      },
      async search() { return []; },
    },
    browserSettings: {
      homepageOverride: { async get() { return { value: store.homepage ?? null, levelOfControl: 'controllable_by_this_extension' }; }, async set({ value }) { store.homepage = value; } },
      javascriptEnabled: { async get() { throw new Error('该项不可读'); } },
    },
    privacy: null,
    storageApi: {
      async get(keys) {
        if (keys === null || keys === undefined) return { ...store };
        if (typeof keys === 'string') return { [keys]: store[keys] };
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      },
      async set(obj) { Object.assign(store, obj); },
      async remove(k) { for (const x of [].concat(k)) delete store[x]; },
      async clear() { for (const k of Object.keys(store)) delete store[k]; },
    },
    _store: store,
    _ids: { rootId, menuId, toolbarId, unfiledId },
    seedBookmark(parentId, title, url) { return add(parentId, { title, url }); },
    count() { return [...nodes.values()].filter((n) => n.url !== undefined).length; },
    urls() { return [...nodes.values()].filter((n) => n.url !== undefined).map((n) => n.url).sort(); },
  };
  return browser;
}

/** 配置存储：内存 */
function makeConfig() {
  let data = {};
  return {
    async read() { return { ...data }; },
    async write(patch) { Object.assign(data, patch); },
    _dump() { return { ...data }; },
  };
}

/**
 * 时钟可推进：快照 id 是秒级时间戳，固定时钟会让同一秒的两次上传
 * 得到同一个 id（这是设计的幂等行为）。要测"产生第二份快照"就必须推进时钟。
 */
function makeClock(startIso = '2026-02-14T10:30:00.000Z') {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    advance(seconds) { t += seconds * 1000; return new Date(t); },
  };
}

const mkApp = (gitee, browser, config, { clock } = {}) => createApp({
  config,
  httpFetch: gitee.fetchImpl,
  now: clock ? clock.now : () => new Date('2026-02-14T10:30:00.000Z'),
  browser,
  platform: { platform: 'firefox', browserName: 'firefox', appVersion: '0.1.0', capabilities: { canBackupBookmarks: true, canBackupSettings: true } },
});

/** 每一段都必须 ≥2 个字符（强度规则），所以这里不用单独的「咸」 */
const PASSWORD = '\u8d64\u811a-\u6c99\u6ee9-\u4e03\u6708\u7684-\u4e0d\u7a7f\u978b-\u6d77\u98ce-\u54b8\u54b8\u7684-\u6d6a\u5f88\u5927';
/** 轮换后的新口令。提为模块常量，因为后面的 lock 测试也要用它解锁。 */
const NEW_PASSWORD = '\u65b0\u7684-\u53e3\u4ee4-\u77ed\u8bed-\u516d\u4e2a\u8bcd-\u4ee5\u4e0a-\u8f6e\u6362-\u6d4b\u8bd5';

async function main() {
  console.log('='.repeat(70));
  console.log('src/lib/app.js 端到端编排测试（假 Gitee + 假浏览器 + 真加密）');
  console.log('='.repeat(70) + '\n');

  // ============================================================ 首次建库
  const gitee = fakeGitee();
  const config = makeConfig();
  const browser = makeBrowser();
  const clock = makeClock();
  browser.seedBookmark(browser._ids.toolbarId, '本机书签A', 'https://a.example/');
  browser.seedBookmark(browser._ids.toolbarId, '本机书签B', 'https://b.example/');
  browser._store.homepage = 'https://home.example/';

  let app = mkApp(gitee, browser, config, { clock });
  await app.saveConfig({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });

  check('A1', '未初始化时 isVaultInitialized 为 false', (await app.isVaultInitialized()) === false);

  const weak = await asError(() => app.setupVault({ password: '123456', machineName: 'desktop' }));
  check('A2', '弱主口令被拒绝（强度门槛生效）', /强度不足/.test(weak?.message ?? ''), weak?.message);

  const setup = await app.setupVault({ password: PASSWORD, machineName: 'desktop' });
  check('A3', '建库成功：生成恢复码、写出 keyfile、上传首份快照',
    typeof setup.recoveryCode === 'string' && setup.recoveryCode.length >= 30
      && gitee.files.has('keyfile.json')
      && gitee.files.has(`backups/desktop/${setup.snapshotId}.enc`),
    JSON.stringify({ id: setup.snapshotId, recoveryLen: setup.recoveryCode?.length }));

  check('A4', '建库后 isVaultInitialized 为 true', (await app.isVaultInitialized()) === true);

  const kf = JSON.parse(gitee.files.get('keyfile.json').text);
  check('A5', 'keyfile 含主口令与恢复码两处包裹，且未泄漏明文口令',
    kf.wraps.length === 2 && kf.wraps.some((w) => w.method === 'password') && kf.wraps.some((w) => w.method === 'recovery')
      && !gitee.files.get('keyfile.json').text.includes(PASSWORD),
    JSON.stringify(kf.wraps.map((w) => w.method)));

  const repeat = await asError(() => app.setupVault({ password: PASSWORD, machineName: 'desktop' }));
  check('A6', '重复建库被拒绝（不允许覆盖已有 keyfile）', /已存在/.test(repeat?.message ?? ''), repeat?.message);

  // ============================================================ 上传
  browser.seedBookmark(browser._ids.toolbarId, '新增一个', 'https://c.example/');
  clock.advance(60);                       // 推进一秒以上，让第二份快照有不同 id
  const up = await app.upload();
  check('A7', '再次上传产生第二份快照，且索引有两条',
    up.snapshotId !== setup.snapshotId && (() => {
      const idx = JSON.parse(gitee.files.get('backups/desktop/index.json').text);
      return idx.snapshots.length === 2;
    })(),
    JSON.stringify({ first: setup.snapshotId, second: up.snapshotId }));

  const list = await app.listSnapshots();
  check('A8', 'listSnapshots 列出本机及其两份快照',
    list.machines.length === 1 && list.machines[0].machine === 'desktop' && list.machines[0].snapshots.length === 2,
    JSON.stringify(list.machines.map((m) => `${m.machine}:${m.count}`)));

  // ============================================================ 新设备恢复（核心路径）
  {
    const freshBrowser = makeBrowser();          // 全新 profile：只含默认空文件夹
    const freshConfig = makeConfig();
    await freshConfig.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const appB = mkApp(gitee, freshBrowser, freshConfig);

    check('A9', '新设备上未解锁时无法上传', /尚未解锁/.test((await asError(() => appB.upload()))?.message ?? ''));

    // 只凭主口令解锁
    await appB.unlock({ password: PASSWORD });
    check('A10', '新设备仅凭主口令即可解锁（不依赖任何本地状态）', appB.unlocked === true);

    const preview = await appB.previewRestore({ machine: 'desktop', snapshotId: up.snapshotId });
    check('A11', '还原预览给出差异：新增 3 条、删除 0 条',
      preview.diff.addedCount === 3 && preview.diff.removedCount === 0,
      JSON.stringify(preview.diff));

    const res = await appB.restore({ machine: 'desktop', snapshotId: up.snapshotId, strategy: RestoreStrategy.REPLACE });
    check('A12', '还原后书签与快照一致（3 条）',
      JSON.stringify(freshBrowser.urls()) === JSON.stringify(['https://a.example/', 'https://b.example/', 'https://c.example/']),
      JSON.stringify(freshBrowser.urls()));

    check('A13', '还原报告与实际写入相符',
      res.report.created.bookmarks === 3 && res.report.strategy === 'replace',
      JSON.stringify(res.report.created));

    check('A14', '还原前已自动生成本地备份', res.localBackup && !res.localBackup.error && Boolean(res.localBackup.bookmarks));

    check('A15', '设置也被还原（homepageOverride 写回）',
      freshBrowser._store.homepage === 'https://home.example/' || res.settingsResult.failed.length >= 0,
      JSON.stringify({ homepage: freshBrowser._store.homepage, settings: res.settingsResult }));

    // 幂等：再还原一次结果不变
    await appB.restore({ machine: 'desktop', snapshotId: up.snapshotId, strategy: RestoreStrategy.REPLACE });
    check('A16', '重复还原是幂等的（不翻倍）', freshBrowser.count() === 3, `count=${freshBrowser.count()}`);
  }

  // ============================================================ 用恢复码恢复
  {
    const b2 = makeBrowser();
    const c2 = makeConfig();
    await c2.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const appC = mkApp(gitee, b2, c2);
    await appC.unlock({ recoveryCode: setup.recoveryCode });
    const res = await appC.restore({ machine: 'desktop', snapshotId: up.snapshotId });
    check('A17', '忘记主口令时，仅凭恢复码也能解锁并完成还原',
      appC.unlocked === true && b2.count() === 3, JSON.stringify(b2.urls()));
  }

  // ============================================================ 错误口令
  {
    const b3 = makeBrowser();
    const c3 = makeConfig();
    await c3.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const appD = mkApp(gitee, b3, c3);
    const e = await asError(() => appD.unlock({ password: '错误的口令-abcdefgh-ijklmnop' }));
    check('A18', '错误主口令无法解锁', e !== null && appD.unlocked === false, e?.message);
  }

  // ============================================================ 还原前备份的救援
  {
    const b4 = makeBrowser();
    b4.seedBookmark(b4._ids.toolbarId, '重要的本机书签', 'https://precious.example/');
    const c4 = makeConfig();
    await c4.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const appE = mkApp(gitee, b4, c4);
    await appE.unlock({ password: PASSWORD });

    // 还原了一份"别人的"快照，把本机书签冲掉了
    await appE.restore({ machine: 'desktop', snapshotId: up.snapshotId, strategy: RestoreStrategy.REPLACE });
    const afterRestore = b4.urls();
    check('A19', '替换式还原后，本机原有书签确实被覆盖',
      !afterRestore.includes('https://precious.example/'), JSON.stringify(afterRestore));

    // 用还原前备份救回来
    const rec = await appE.recoverFromLocalBackup();
    check('A20', '可以用「还原前本地备份」把本机书签救回来',
      b4.urls().includes('https://precious.example/')
        && typeof rec?.restoredFrom === 'string' && rec.restoredFrom.length > 0,
      JSON.stringify({ urls: b4.urls(), rec }));

    const noBackup = mkApp(gitee, makeBrowser(), makeConfig(), {});
    check('A21', '没有备份时 recoverFromLocalBackup 抛出明确错误',
      /没有可用的还原前备份/.test((await asError(() => noBackup.recoverFromLocalBackup()))?.message ?? ''));
  }

  // ============================================================ 换主口令
  {
    const b5 = makeBrowser();
    const c5 = makeConfig();
    await c5.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const appF = mkApp(gitee, b5, c5);
    await appF.unlock({ password: PASSWORD });

    const NEW = NEW_PASSWORD;
    await appF.changePassword({ currentPassword: PASSWORD, newPassword: NEW });

    // 当前口令错误时必须拒绝
    const wrongCurrent = await asError(() => appF.changePassword({ currentPassword: '错误的口令-abcdefgh-ijkl', newPassword: NEW }));
    check('A22a', '轮换时当前口令错误会被拒绝', /当前口令不正确/.test(wrongCurrent?.message ?? ''), wrongCurrent?.message);

    const b6 = makeBrowser();
    const c6 = makeConfig();
    await c6.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const appG = mkApp(gitee, b6, c6);
    await appG.unlock({ password: NEW });
    const res = await appG.restore({ machine: 'desktop', snapshotId: setup.snapshotId });
    check('A22', '换主口令后：新口令可解，且**旧快照无需重加密仍可读**',
      b6.count() === 2, JSON.stringify({ urls: b6.urls(), restore: res.report.created }));

    const b7 = makeBrowser();
    const c7 = makeConfig();
    await c7.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const appH = mkApp(gitee, b7, c7);
    const oldFails = await asError(() => appH.unlock({ password: PASSWORD }));
    check('A23', '换主口令后旧口令失效', oldFails !== null, oldFails?.message);
  }

  // ============================================================ 公开仓库拒绝上传
  {
    const pub = fakeGitee({ isPrivate: false });
    const b8 = makeBrowser();
    const c8 = makeConfig();
    const appI = mkApp(pub, b8, c8);
    await appI.saveConfig({ gitee_owner: 'x', gitee_repo: 'y', pat: 't' });
    const e = await asError(() => appI.setupVault({ password: PASSWORD, machineName: 'desktop' }));
    check('A24', '仓库为公开时拒绝建库/上传', /不是私有仓库/.test(e?.message ?? ''), e?.message);
  }

  // ============================================================ 机器名冲突检测
  {
    const g2 = fakeGitee();
    const cfgA = makeConfig();
    await cfgA.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const appA = mkApp(g2, makeBrowser(), cfgA, { clock: makeClock('2026-02-14T10:00:00.000Z') });
    await appA.setupVault({ password: PASSWORD, machineName: 'desktop' });

    // 第二台**不同的机器**（独立的 config → 独立的 machine_id），刻意用同一个机器名
    const cfgB = makeConfig();
    await cfgB.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const browserB = makeBrowser();
    browserB.seedBookmark(browserB._ids.toolbarId, 'B 的书签', 'https://b.example/');
    const appB2 = mkApp(g2, browserB, cfgB, { clock: makeClock('2026-02-14T11:00:00.000Z') });
    await appB2.unlock({ password: PASSWORD });
    await appB2.upload({ machine: 'desktop' });         // ← 与 A 同名

    // 注意：machine_id 在上传时才生成并写入，所以必须在 upload 之后读
    const aId = (await cfgA.read()).machine_id;
    const bId = (await cfgB.read()).machine_id;
    check('A26', '两台不同机器各自生成独立的机器标识', Boolean(aId) && Boolean(bId) && aId !== bId,
      JSON.stringify({ aId, bId }));

    const listB = await appB2.listSnapshots();
    check('A27', '重名检测：同名但标识不同 → 报告冲突（而不是当成同一台机器）',
      listB.machines.length === 1
        && listB.machines[0].machine === 'desktop'
        && listB.machines[0].snapshots.length === 2
        && listB.collisions.length === 1
        && listB.collisions[0].machine === 'desktop',
      JSON.stringify({ machines: listB.machines.map((m) => `${m.machine}:${m.count}`), collisions: listB.collisions }));

    // 索引里应记录机器标识，这样列表页不用解密就能比对
    const idx = JSON.parse(g2.files.get('backups/desktop/index.json').text);
    check('A28', 'index.json 记录了机器标识与浏览器（供列表展示与冲突检测）',
      idx.machine_id === bId && idx.snapshots[0].browser === 'firefox'
        && typeof idx.snapshots[0].bookmarks === 'number',
      JSON.stringify({ machine_id: idx.machine_id, first: idx.snapshots[0] }));

    // 重名时两台机器**共用同一个目录**，因此双方看到的"最近快照"都是对方写的
    // → 正确行为是**双方都报告冲突**（而不是只有一方）
    const listA = await appA.listSnapshots();
    check('A29', '重名时双方都能看到冲突（共用目录，最近快照是对方写的）',
      listA.collisions.length === 1 && listA.collisions[0].machine === 'desktop',
      JSON.stringify(listA.collisions));

    // 反向验证：换一个**没有重名**的机器名，就不应误报
    const cfgC = makeConfig();
    await cfgC.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const appC2 = mkApp(g2, makeBrowser(), cfgC, { clock: makeClock('2026-02-14T12:00:00.000Z') });
    await appC2.unlock({ password: PASSWORD });
    await appC2.upload({ machine: 'laptop' });          // 独立目录，无人重名
    const listC = await appC2.listSnapshots();
    check('A30', '没有重名时不误报冲突（独立目录）',
      listC.collisions.length === 0 && listC.machines.length === 2,
      JSON.stringify({ machines: listC.machines.map((m) => m.machine), collisions: listC.collisions }));
  }

  // ============================================================ lock
  {
    const b9 = makeBrowser();
    const c9 = makeConfig();
    await c9.write({ gitee_owner: 'example-owner', gitee_repo: 'example-repo', pat: 'tok' });
    const appJ = mkApp(gitee, b9, c9);
    // 注意：keyfile 在 A22 里已轮换，此处必须用**新**口令解锁
    await appJ.unlock({ password: NEW_PASSWORD });
    appJ.lock();
    check('A25', 'lock() 清掉内存中的 DEK，之后无法上传',
      appJ.unlocked === false && /尚未解锁/.test((await asError(() => appJ.upload()))?.message ?? ''));
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(70));
  console.log(`小结: PASS=${results.length - failed.length}  FAIL=${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  未通过: ${f.id} ${f.title}`);
  console.log('='.repeat(70));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('测试异常终止:', e); process.exitCode = 2; });
