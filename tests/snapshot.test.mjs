#!/usr/bin/env node
/**
 * src/lib/snapshot.js 的单元测试
 *
 * 覆盖验收清单里的 E6（保留策略）与 E7（索引可重建），
 * 以及上传/下载全流程、索引并发冲突、尺寸上限。
 *
 * 仍然用假 Gitee + 注入式 fetch：无网络、无令牌、竞态可确定性触发。
 *
 * 用法：
 *   node tests/snapshot.test.mjs
 */

import { createHash } from 'node:crypto';
import { createGiteeClient, GiteeError, GiteeErrorCode } from '../src/lib/gitee.js';
import { generateDek, createKeyfile, unlockDekFromKeyfile, generateRecoveryCode } from '../src/lib/crypto.js';
import {
  formatSnapshotId,
  parseSnapshotId,
  buildSnapshot,
  emptyIndex,
  reconcileIndex,
  planRetention,
  loadIndex,
  uploadSnapshot,
  downloadSnapshot,
  listMachines,
  pruneSnapshots,
  isInitialized,
  machineDir,
  indexPath,
  snapshotPath,
} from '../src/lib/snapshot.js';

const gitBlobSha = (text) =>
  createHash('sha1').update(`blob ${Buffer.byteLength(text, 'utf8')}\0${text}`, 'utf8').digest('hex');

// ---------------------------------------------------------------- 假 Gitee

function fakeGitee({ isPrivate = true, defaultBranch = 'master' } = {}) {
  const files = new Map();
  const requests = [];
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

  const json = (status, obj) => ({ status, text: async () => JSON.stringify(obj) });

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: u.pathname.replace(/^\/api\/v5/, '') });

    const seq = requests.length;
    if (hooks.has(seq)) { const h = hooks.get(seq); hooks.delete(seq); h({ files, put }); }

    if (!u.pathname.includes('/contents')) return json(200, { private: isPrivate, default_branch: defaultBranch });
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
      if (!cur) {
        const text = Buffer.from(body.content, 'base64').toString('utf8');
        put(rawPath, text);
        return json(200, { content: { path: rawPath, sha: gitBlobSha(text) }, commit: { sha: 'd'.repeat(40) } });
      }
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

const results = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} · ${title}${ok ? '' : `\n        ${detail ?? ''}`}`);
}
const mkClient = (fake, extra = {}) =>
  createGiteeClient({ owner: 'example-owner', repo: 'example-repo', token: 'tok', fetchImpl: fake.fetchImpl, backoffMs: [1, 1, 1], ...extra });
const mkSnapshot = (machine, isoDate, marker = 'x') =>
  buildSnapshot({ machine, browser: 'firefox', appVersion: '0.1.0', date: new Date(isoDate), bookmarks: { children: [{ title: marker }] }, settings: { a: marker } });
const asError = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

async function main() {
  console.log('='.repeat(70));
  console.log('src/lib/snapshot.js 单元测试（假 Gitee）');
  console.log('='.repeat(70) + '\n');

  // ============================================================ id 格式
  {
    const d = new Date('2026-02-14T10:30:00.000Z');
    const id = formatSnapshotId(d);
    check('S1', 'formatSnapshotId 产出 `YYYYMMDDTHHMMSSZ` 且为 UTC',
      id === '20260214T103000Z', id);
    check('S2', 'parseSnapshotId 与 formatSnapshotId 往返一致',
      parseSnapshotId(id)?.toISOString() === d.toISOString(), parseSnapshotId(id)?.toISOString());
    check('S3', 'parseSnapshotId 对非法输入返回 null',
      parseSnapshotId('2026-02-14') === null && parseSnapshotId('garbage') === null);
  }

  // ============================================================ 保留策略（E6）
  {
    const idx = emptyIndex('desktop');
    idx.snapshots = Array.from({ length: 25 }, (_, i) => {
      const id = formatSnapshotId(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
      return { id, file: `${id}.enc`, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), bytes: 10, sha: 'a'.repeat(40) };
    });
    const doomed = planRetention(idx, 20);
    const doomedIds = doomed.map((s) => s.id).sort();
    const existingIds = idx.snapshots.map((s) => s.id).sort();
    const expected = existingIds.slice(0, 5);            // 25 份里最旧的 5 份
    check('S4', 'E6 保留策略：25 份时计划删除最旧的 5 份，且按最旧优先',
      doomed.length === 5
        && JSON.stringify(doomedIds) === JSON.stringify(expected)
        && doomed[0].id === expected[0],
      `删除 ${doomed.length} 份，首个=${doomed[0]?.id}，期望集=${expected.join(',')}`);
  }

  // ============================================================ 索引重建（E7）
  {
    const fake = fakeGitee();
    fake.put(`${machineDir('desktop')}/20260201T000000Z.enc`, 'C1');
    fake.put(`${machineDir('desktop')}/20260202T000000Z.enc`, 'C2');
    fake.put(`${machineDir('desktop')}/20260203T000000Z.enc`, 'C3');
    const c = mkClient(fake);

    const r = await loadIndex(c, 'desktop');
    check('S5', 'E7 索引不存在时从目录完全重建（3 份，倒序）',
      r.rebuilt === true && r.index.snapshots.length === 3
        && r.index.snapshots[0].id === '20260203T000000Z'
        && r.index.snapshots[0].sha === gitBlobSha('C3'),
      `rebuilt=${r.rebuilt} 条目=${r.index.snapshots.map((s) => s.id).join(',')}`);

    // 目录列表里的 sha 必须是删除时可用的那个
    check('S6', '重建时从目录条目取得 sha（删除时需要）',
      r.index.snapshots.every((s) => typeof s.sha === 'string' && s.sha.length === 40));

    // 损坏的索引 → 重建并标记
    fake.put(indexPath('desktop'), 'not json at all');
    const r2 = await loadIndex(c, 'desktop');
    check('S7', '索引内容损坏时回退到从目录重建（不抛异常）',
      r2.index.snapshots.length === 3 && r2.rebuilt === true, `条目=${r2.index.snapshots.length}`);

    // 索引含幽灵条目 + 目录含索引不认识的快照
    const ghost = emptyIndex('desktop');
    ghost.snapshots = [
      { id: '20260203T000000Z', file: '20260203T000000Z.enc', created_at: null, bytes: 2, sha: gitBlobSha('C3') },
      { id: '19990101T000000Z', file: '19990101T000000Z.enc', created_at: null, bytes: 2, sha: 'b'.repeat(40) },
    ];
    fake.put(indexPath('desktop'), JSON.stringify(ghost));
    const r3 = await loadIndex(c, 'desktop');
    check('S8', '索引里的幽灵条目被剔除，目录里的新快照被补入（repaired 标记）',
      r3.index.snapshots.length === 3
        && !r3.index.snapshots.some((s) => s.id === '19990101T000000Z')
        && r3.repaired === true,
      `条目=${r3.index.snapshots.map((s) => s.id).join(',')} repaired=${r3.repaired}`);

    // index.json 本身不应被当成快照
    check('S9', 'reconcileIndex 忽略 index.json 与任何非快照文件',
      !r3.index.snapshots.some((s) => s.file === 'index.json'));
  }

  // ============================================================ 上传全流程
  {
    const fake = fakeGitee();
    const c = mkClient(fake);
    const dek = await generateDek();
    const snap = mkSnapshot('desktop', '2026-02-14T10:30:00.000Z', 'hello');

    const r = await uploadSnapshot(c, { dek, machine: 'desktop', snapshot: snap, branch: 'master' });
    check('S10', '上传写出快照文件与索引，返回 sha 与统计',
      r.snapshotId === '20260214T103000Z' && r.writeMode === 'created'
        && fake.files.has(snapshotPath('desktop', r.snapshotId))
        && fake.files.has(indexPath('desktop')),
      JSON.stringify({ id: r.snapshotId, mode: r.writeMode, cipher: r.ciphertextBytes }));

    const idx = JSON.parse(fake.files.get(indexPath('desktop')).text);
    check('S11', '索引内容与本次上传一致（含 bytes 与 sha）',
      idx.snapshots.length === 1 && idx.snapshots[0].id === r.snapshotId
        && idx.snapshots[0].bytes === r.ciphertextBytes,
      JSON.stringify(idx.snapshots[0]));

    // 下载还原
    const dl = await downloadSnapshot(c, { dek, machine: 'desktop', snapshotId: r.snapshotId });
    check('S12', '下载并解密还原，内容与上传的载荷一致',
      JSON.stringify(dl.snapshot.payload) === JSON.stringify(snap.payload),
      JSON.stringify(dl.snapshot.payload).slice(0, 80));

    // 错误密钥必须失败
    const otherDek = await generateDek();
    const bad = await asError(() => downloadSnapshot(c, { dek: otherDek, machine: 'desktop', snapshotId: r.snapshotId }));
    check('S13', '用错误的 DEK 下载会解密失败', bad !== null, bad?.message);

    // 不存在的快照给出明确错误
    const missing = await asError(() => downloadSnapshot(c, { dek, machine: 'desktop', snapshotId: '19990101T000000Z' }));
    check('S14', '下载不存在的快照抛出明确错误', /快照不存在/.test(missing?.message ?? ''), missing?.message);
  }

  // ============================================================ 保留策略端到端（E6）
  {
    const fake = fakeGitee();
    const c = mkClient(fake);
    const dek = await generateDek();
    const total = 24;
    const limit = 20;
    for (let i = 0; i < total; i++) {
      const snap = mkSnapshot('desktop', new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), `m${i}`);
      await uploadSnapshot(c, { dek, machine: 'desktop', snapshot: snap, branch: 'master', limit });
    }
    const idx = JSON.parse(fake.files.get(indexPath('desktop')).text);
    const onDisk = [...fake.files.keys()].filter((p) => p.startsWith(`${machineDir('desktop')}/`) && p.endsWith('.enc'));
    check('S15', `E6 连续上传 ${total} 份、上限 ${limit} → 索引与磁盘都恰好保留 ${limit} 份`,
      idx.snapshots.length === limit && onDisk.length === limit,
      `索引=${idx.snapshots.length} 磁盘=${onDisk.length}`);

    const keptNewest = idx.snapshots[0].id === formatSnapshotId(new Date(Date.UTC(2026, 0, 1, 0, 0, total - 1)));
    const droppedOldest = onDisk.every((p) => !p.includes('20260101T000000Z.enc'));
    check('S16', '保留的是最新若干份，最旧的被删除',
      keptNewest && droppedOldest, `最新=${keptNewest} 最旧已删=${droppedOldest}`);

    // 核心不变式：索引里每一条都必须指向磁盘上真实存在的文件（不能有幽灵条目）
    const phantom = idx.snapshots.filter((s) => !fake.files.has(snapshotPath('desktop', s.id)));
    check('S17', '核心不变式：索引条目与磁盘文件一一对应（无幽灵条目）',
      phantom.length === 0, `幽灵条目=${phantom.map((s) => s.id).join(',') || '无'}`);
  }

  // ============================================================ 索引并发冲突
  {
    const fake = fakeGitee();
    const c = mkClient(fake);
    const dek = await generateDek();
    const snap = mkSnapshot('desktop', '2026-02-14T10:30:00.000Z');

    // 上传序列：1..N。让别台机器在索引 PUT 之前改动 index.json。
    // 先算一下大概位置：GET(list) → GET(index 不存在) → GET(快照不存在) → POST(快照)
    //                → GET(list) → GET(index) → PUT(index)
    // 直接在 PUT(index) 之前注入：找出第一次 PUT 的序号不好预知，改为用钩子在指定序号插入。
    fake.hooks.set(7, ({ files, put }) => {
      const cur = JSON.parse(files.get(indexPath('desktop')).text);
      cur.snapshots.unshift({ id: '20260101T000000Z', file: '20260101T000000Z.enc', created_at: null, bytes: 1, sha: 'f'.repeat(40) });
      put(indexPath('desktop'), JSON.stringify(cur));
    });

    const r = await uploadSnapshot(c, { dek, machine: 'desktop', snapshot: snap, branch: 'master' });
    const idx = JSON.parse(fake.files.get(indexPath('desktop')).text);
    check('S22', '索引写入遇并发改动 → 不静默失败（recovered 或最终内容正确）',
      idx.snapshots.some((s) => s.id === r.snapshotId),
      `recovered=${r.recovered} 条目=${idx.snapshots.map((s) => s.id).join(',')}`);
  }

  // ============================================================ 载荷上限
  {
    const fake = fakeGitee();
    const c = mkClient(fake);
    const dek = await generateDek();
    const huge = buildSnapshot({
      machine: 'desktop', browser: 'firefox', appVersion: '0.1.0',
      date: new Date('2026-02-14T10:30:00.000Z'),
      bookmarks: { children: [] },
      settings: { blob: 'x'.repeat(7 * 1024 * 1024) },
    });
    const e = await asError(() => uploadSnapshot(c, { dek, machine: 'desktop', snapshot: huge, branch: 'master' }));
    const noWrite = ![...fake.files.keys()].some((p) => p.endsWith('.enc'));
    check('S18', '超过载荷上限时拒绝上传，且不产生任何写入',
      e instanceof GiteeError && e.code === GiteeErrorCode.PAYLOAD_TOO_LARGE && noWrite,
      `错误=${e?.code} 有写入=${!noWrite}`);
  }

  // ============================================================ 机器列举
  {
    const fake = fakeGitee();
    const c = mkClient(fake);
    const dek = await generateDek();
    for (const [machine, iso] of [['desktop', '2026-02-14T10:30:00.000Z'], ['laptop', '2026-02-13T20:11:00.000Z']]) {
      await uploadSnapshot(c, { dek, machine, snapshot: mkSnapshot(machine, iso), branch: 'master' });
    }
    const machines = await listMachines(c);
    check('S19', 'listMachines 列出各机器及其最新快照',
      machines.length === 2
        && machines.find((m) => m.machine === 'desktop')?.latest?.id === '20260214T103000Z'
        && machines.find((m) => m.machine === 'laptop')?.latest?.id === '20260213T201100Z',
      JSON.stringify(machines.map((m) => `${m.machine}:${m.latest?.id}`)));
  }

  // ============================================================ 首次建库判定
  {
    const fake = fakeGitee();
    const c = mkClient(fake);
    const before = await isInitialized(c);
    const { keyfile } = await createKeyfile({ password: '口令-短语-六个词-以上-测试', recoveryCode: generateRecoveryCode() });
    await c.putFile('keyfile.json', JSON.stringify(keyfile, null, 2), 'init');
    const after = await isInitialized(c);
    check('S20', 'isInitialized 依据 keyfile.json 是否存在判定', before === false && after === true,
      `before=${before} after=${after}`);

    // 顺带验证：keyfile 上传后仍能被解锁（跨模块衔接）
    const read = await c.read('keyfile.json');
    const dek = await unlockDekFromKeyfile(JSON.parse(read.text), { password: '口令-短语-六个词-以上-测试' });
    check('S21', 'keyfile 经 Gitee 往返后仍可用主口令解锁', Boolean(dek));
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(70));
  console.log(`小结: PASS=${results.length - failed.length}  FAIL=${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  未通过: ${f.id} ${f.title}`);
  console.log('='.repeat(70));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('测试异常终止:', e); process.exitCode = 2; });
