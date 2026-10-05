/**
 * 快照与索引 —— 对应 docs/02-design.md 的「上传流程」「下载流程」
 *
 * 职责边界：
 *   - 本模块负责**组装、命名、索引、保留**，以及把加解密串起来；
 *   - 密钥的解锁（拿主口令换 DEK）由调用方负责，只把 dek 传进来；
 *   - 所有网络操作经由 src/lib/gitee.js，本模块不认识 HTTP。
 *
 * 两条设计约束（来自实测，勿凭直觉改）：
 *   1. **索引是可重建的纯派生数据**。所有写入冲突都以「以文件系统为准重建」解决，
 *      因此不需要锁，重试即可收敛。
 *   2. **快照文件名含时间戳，天然唯一**。所以快照本身不会冲突，只有 index.json 会。
 */

import {
  SNAPSHOT_FORMAT,
  INDEX_FORMAT,
  FORMAT_VERSION,
  BACKUPS_DIR,
  KEYFILE_PATH,
  RETENTION_PER_MACHINE,
  MAX_SNAPSHOT_BYTES,
} from './constants.js';
import { encryptSnapshot, decryptSnapshot } from './crypto.js';

// ---------------------------------------------------------------- 快照 id

/**
 * Date 或 ISO 字符串 → `20260214T103000Z`（UTC，秒级精度）
 *
 * 同时接受两种输入，因为快照里的 `created_at` 是 ISO 字符串，
 * 而调用方也可能直接传 Date。混用会导致 `toISOString` 抛
 * `Invalid time value`，属于很容易漏掉的类型不一致。
 */
export function formatSnapshotId(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`formatSnapshotId 收到无法解析的时间：${JSON.stringify(input)}`);
  }
  const iso = date.toISOString();          // 2026-02-14T10:30:00.000Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** `20260214T103000Z` → Date；非法输入返回 null */
export function parseSnapshotId(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(id));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? null : date;
}

export const SNAPSHOT_ID_RE = /^\d{8}T\d{6}Z$/;

// ---------------------------------------------------------------- 路径

export const machineDir = (machine) => `${BACKUPS_DIR}/${machine}`;
export const indexPath = (machine) => `${machineDir(machine)}/index.json`;
export const snapshotPath = (machine, id) => `${machineDir(machine)}/${id}.enc`;
export const snapshotBasename = (id) => `${id}.enc`;

// ---------------------------------------------------------------- 组装

/**
 * 组装待加密的快照对象。
 * 注意载荷里的字段名是 `_unavailable` / `_note`，与 docs/04-repo-layout.md 的示例
 * 对应（文档里写的是 `settings_unavailable` / `settings_platform_note`，此处保持一致）。
 */
export function buildSnapshot({
  machine, browser, appVersion, bookmarks, settings,
  settingsUnavailable, settingsPlatformNote, machineId = null, date = new Date(),
}) {
  if (!machine) throw new Error('缺少 machine');
  return {
    format: SNAPSHOT_FORMAT,
    format_version: FORMAT_VERSION,
    created_at: date.toISOString(),
    machine,
    /**
     * 机器唯一标识（本机生成一次、永不变）。
     *
     * 为什么需要它：`machine` 是**用户自己起的名**，两台机器可能重名
     * （例如都叫 `desktop`）。重名会让两台机器的快照落进同一个目录，
     * 表现为"来源机器看起来是同一台"、保留策略也会把两份历史混在一起删。
     *
     * 有了它就能识别出"同一个名字其实是两台不同的机器"并提示改名。
     */
    machine_id: machineId,
    browser: browser ?? 'unknown',
    app_version: appVersion ?? '0.0.0',
    payload: {
      bookmarks: bookmarks ?? { children: [] },
      settings: settings ?? {},
      settings_unavailable: settingsUnavailable ?? [],
      settings_platform_note: settingsPlatformNote ?? null,
    },
  };
}

/** 空索引骨架 */
export function emptyIndex(machine) {
  return { format: INDEX_FORMAT, format_version: FORMAT_VERSION, machine, snapshots: [] };
}

/**
 * 把索引里的条目与目录实际内容对齐。
 *
 * 索引是**纯派生数据**：目录才是事实来源。因此这里做两件事：
 *   - 丢弃索引里指向已不存在文件的条目（幽灵条目）；
 *   - 保留目录列表给出的 sha（删除时需要它，且它总是最新的）。
 *
 * 返回 { index, repaired }。repaired=true 表示索引与实际不符，曾需要修正。
 */
export function reconcileIndex(index, dirEntries, machine, { now = new Date() } = {}) {
  const base = index && index.format === INDEX_FORMAT && Array.isArray(index.snapshots)
    ? index
    : emptyIndex(machine);

  const seen = new Map();
  let repaired = Boolean(index) && !(index.format === INDEX_FORMAT && Array.isArray(index.snapshots));

  for (const entry of dirEntries) {
    if (entry.type !== 'file') continue;
    const m = /^(\d{8}T\d{6}Z)\.enc$/.exec(entry.name ?? '');
    if (!m) continue;                       // 忽略 index.json 及任何非快照文件
    const id = m[1];
    const known = base.snapshots.find((s) => s.id === id);
    if (!known) repaired = true;            // 目录里有索引不认识的快照
    seen.set(id, {
      id,
      file: entry.name,
      created_at: parseSnapshotId(id)?.toISOString() ?? null,
      bytes: entry.size ?? known?.bytes ?? null,
      sha: entry.sha ?? known?.sha ?? null,
      // **这些元数据只存在于索引里**（目录列表拿不到），因此必须从已知条目带过来。
      // 早期实现漏了它们，导致每台机器的第二份快照之后，历史条目的
      // machine_id / browser / bookmarks 全部丢失 —— 重名检测因此失效。
      machine_id: known?.machine_id ?? null,
      browser: known?.browser ?? null,
      bookmarks: known?.bookmarks ?? null,
    });
  }

  // 索引里有、目录里没有 → 幽灵条目
  for (const s of base.snapshots) if (!seen.has(s.id)) repaired = true;

  const snapshots = [...seen.values()].sort((a, b) => (a.id < b.id ? 1 : -1));  // 新的在前
  return {
    index: {
      format: INDEX_FORMAT,
      format_version: FORMAT_VERSION,
      machine,
      updated_at: now.toISOString(),
      snapshots,
    },
    repaired,
  };
}

/** 读取该机器的目录条目（快照 + index.json） */
export async function listMachineDir(client, machine) {
  const entries = await client.list(machineDir(machine));
  return Array.isArray(entries) ? entries : [];
}

/**
 * 读取并修正索引。索引不存在（或目录不存在）时，从目录列表重建。
 * 返回 { index, rebuilt, entries }。
 */
export async function loadIndex(client, machine, { now = new Date() } = {}) {
  const entries = await listMachineDir(client, machine);
  const file = entries.find((e) => e.name === 'index.json' && e.type === 'file');

  let stored = null;
  if (file) {
    try {
      const read = await client.read(indexPath(machine));
      stored = read ? JSON.parse(read.text) : null;
    } catch {
      stored = null;                        // 索引损坏 → 当作没有，从目录重建
    }
  }

  const { index, repaired } = reconcileIndex(stored, entries, machine, { now });
  const rebuilt = !file || !stored;
  return { index, rebuilt, repaired, entries };
}

/**
 * 依据保留策略，算出该删除哪些快照。
 * 返回按「最旧优先」排序的待删除条目。
 */
export function planRetention(index, limit = RETENTION_PER_MACHINE) {
  const list = [...(index?.snapshots ?? [])].sort((a, b) => (a.id < b.id ? 1 : -1));  // 新 → 旧
  return list.slice(limit).sort((a, b) => (a.id < b.id ? -1 : 1));                     // 返回时旧 → 新
}

// ---------------------------------------------------------------- 上传

/**
 * 上传一份快照：加密 → 写快照文件 → 更新索引 → 应用保留策略。
 *
 * @param {object} client   src/lib/gitee.js 的客户端
 * @param {object} opts
 * @param {CryptoKey} opts.dek
 * @param {string} opts.machine
 * @param {object} opts.snapshot   buildSnapshot() 的产物
 * @param {string} [opts.snapshotId]  默认取 snapshot.created_at 对应的时间戳
 * @param {string} [opts.branch]
 * @param {boolean} [opts.prune]  是否应用保留策略，默认 true
 */
export async function uploadSnapshot(client, {
  dek, machine, snapshot, snapshotId, branch, prune = true, limit = RETENTION_PER_MACHINE,
}) {
  const id = snapshotId ?? formatSnapshotId(new Date(snapshot.created_at));
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
  client.assertSnapshotSize(plaintextBytes);

  const ciphertext = await encryptSnapshot(dek, snapshot, { machine, snapshotId: id });
  const cipherBytes = ciphertext.length;
  if (cipherBytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`密文 ${cipherBytes} 字节超过载荷上限 ${MAX_SNAPSHOT_BYTES}`);
  }

  const path = snapshotPath(machine, id);
  const written = await client.putFile(path, ciphertext, `backup: ${machine} ${id}`, { branch });

  // 索引：先读（并重建/修正），再合并本次条目
  const { index, rebuilt } = await loadIndex(client, machine);
  const without = index.snapshots.filter((s) => s.id !== id);
  const all = [
    {
      id,
      file: snapshotBasename(id),
      created_at: snapshot.created_at,
      bytes: cipherBytes,
      sha: written.sha,
      // 以下三项便于列表展示与冲突检测，无需解密即可读取
      machine_id: snapshot.machine_id ?? null,
      browser: snapshot.browser ?? null,
      bookmarks: countPayloadBookmarks(snapshot.payload?.bookmarks),
    },
    ...without,
  ].sort((a, b) => (a.id < b.id ? 1 : -1));

  // 保留策略必须在**写索引之前**应用，否则索引会留下指向已删除文件的幽灵条目
  const doomed = prune ? planRetention({ snapshots: all }, limit) : [];
  const doomedIds = new Set(doomed.map((s) => s.id));
  const retained = all.filter((s) => !doomedIds.has(s.id));

  const merged = { ...index, machine_id: snapshot.machine_id ?? index.machine_id ?? null, snapshots: retained };
  const idxWrite = await client.putFile(
    indexPath(machine),
    JSON.stringify(merged, null, 2),
    `index: ${machine} +${id}`,
    { branch },
  );

  // 索引写成功后再删文件。万一删除失败，下一轮 loadIndex 的 reconcile 会把幽灵条目清掉。
  const pruned = [];
  if (prune) {
    for (const s of doomed) {
      if (!s.sha) continue;                  // 没有 sha 无法删除，跳过而不是猜
      try {
        await client.remove(snapshotPath(machine, s.id), `prune: ${machine} ${s.id}`, s.sha, { branch });
        pruned.push(s.id);
      } catch (e) {
        pruned.push({ id: s.id, error: e.message });   // 保留策略失败不应让整次备份失败
      }
    }
  }

  return {
    snapshotId: id,
    path,
    ciphertextBytes: cipherBytes,
    plaintextBytes,
    snapshotSha: written.sha,
    writeMode: written.mode,
    recovered: written.recovered,
    indexRebuilt: rebuilt,
    indexSha: idxWrite.sha,
    retained: retained.length,
    pruned,
  };
}

/**
 * 独立应用保留策略：删除超出 limit 的最旧快照文件，返回被删列表。
 *
 * **注意：本函数只删文件，不改索引。** 如果单独调用它，索引会留下幽灵条目
 * （不过下次 `loadIndex` 的 reconcile 会自动清掉）。
 * `uploadSnapshot` 不使用本函数 —— 它在写索引之前就规划好保留结果，
 * 因此索引与磁盘始终一致。
 */
export async function pruneSnapshots(client, machine, index, { branch, limit = RETENTION_PER_MACHINE } = {}) {
  const doomed = planRetention(index, limit);
  const removed = [];
  for (const s of doomed) {
    if (!s.sha) continue;                    // 没有 sha 无法删除，跳过而不是猜
    try {
      await client.remove(snapshotPath(machine, s.id), `prune: ${machine} ${s.id}`, s.sha, { branch });
      removed.push(s.id);
    } catch (e) {
      // 保留策略失败不应让整次备份失败：记录并继续
      removed.push({ id: s.id, error: e.message });
    }
  }
  return removed;
}

// ---------------------------------------------------------------- 下载

/** 列出所有机器（backups/ 下的目录），并给出每台的最新快照 */
export async function listMachines(client) {
  const root = await client.list(BACKUPS_DIR);
  if (!Array.isArray(root)) return [];
  const machines = root.filter((e) => e.type === 'dir').map((e) => e.name);

  const out = [];
  for (const machine of machines) {
    let index = emptyIndex(machine);
    let rebuilt = false;
    try {
      const r = await loadIndex(client, machine);
      index = r.index;
      rebuilt = r.rebuilt;
    } catch (e) {
      out.push({ machine, error: e.message, latest: null, count: 0 });
      continue;
    }
    out.push({
      machine,
      rebuilt,
      count: index.snapshots.length,
      latest: index.snapshots[0] ?? null,          // 新 → 旧，取第一个
      snapshots: index.snapshots,
      machineId: index.machine_id ?? null,
      browser: index.snapshots[0]?.browser ?? null,
    });
  }
  return out;
}

/** 取回并解密一份快照。返回 { snapshot, ciphertext, entry } */
export async function downloadSnapshot(client, { dek, machine, snapshotId }) {
  const path = snapshotPath(machine, snapshotId);
  const file = await client.read(path);
  if (!file) throw new Error(`快照不存在：${path}`);
  const snapshot = await decryptSnapshot(dek, file.text, { machine, snapshotId });
  return { snapshot, ciphertext: file.text, entry: { path, sha: file.sha, size: file.size } };
}

/**
 * 读取每台机器的"最近快照元信息"，用于识别**重名机器**。
 *
 * 只解密最近一份快照即可（快照很小），避免为了检测而解密全部历史。
 * 无 machine_id 的旧快照返回 null，视为"无法判断"，不误报。
 */
export async function inspectMachines(client, dek, machines) {
  const out = [];
  for (const m of machines) {
    const latest = m.latest;
    if (!latest) { out.push({ machine: m.machine, machineId: null, browser: null, latest: null }); continue; }
    try {
      const dl = await downloadSnapshot(client, { dek, machine: m.machine, snapshotId: latest.id });
      out.push({
        machine: m.machine,
        machineId: dl.snapshot.machine_id ?? null,
        browser: dl.snapshot.browser ?? null,
        latest: latest.id,
        createdAt: dl.snapshot.created_at ?? null,
        bookmarks: countPayloadBookmarks(dl.snapshot.payload?.bookmarks),
        settingsCount: Object.keys(dl.snapshot.payload?.settings ?? {}).length,
      });
    } catch (e) {
      out.push({ machine: m.machine, machineId: null, browser: null, latest: latest.id, error: e.message });
    }
  }
  return out;
}

/** 统计载荷里的书签条数（用于列表展示"这里面有多少东西"） */
export function countPayloadBookmarks(node) {
  let n = 0;
  const walk = (x) => {
    if (!x) return;
    if (x.url) { n++; return; }
    for (const c of x.children ?? []) walk(c);
  };
  walk(node);
  return n;
}

/** 找出重名的机器：不同 machine_id 却用了同一个 machine 名 */
export function findNameCollisions(inspected) {
  const byName = new Map();
  for (const m of inspected) {
    if (!byName.has(m.machine)) byName.set(m.machine, []);
    byName.get(m.machine).push(m);
  }
  const collisions = [];
  for (const [name, list] of byName) {
    const ids = new Set(list.map((x) => x.machineId).filter(Boolean));
    if (ids.size > 1) collisions.push({ machine: name, machineIds: [...ids], count: ids.size });
  }
  return collisions;
}

// ---------------------------------------------------------------- 首次建库

/** 仓库里是否已经有 keyfile.json（判定「首次使用」） */
export async function isInitialized(client) {
  const f = await client.read(KEYFILE_PATH);
  return Boolean(f);
}
