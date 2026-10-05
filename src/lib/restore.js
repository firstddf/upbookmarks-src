/**
 * 还原 —— 对应 docs/02-design.md 的「下载流程」第 7 步
 *
 * WebExtension **没有「写入整棵树」的 API**，只有 create / removeTree / move 等逐节点操作。
 * 更麻烦的是：**扩展不允许改名或删除「书签菜单」这类默认文件夹**（会抛错）。
 * 因此还原必须建立在下面这套适配器之上，由适配器负责与具体浏览器打交道。
 *
 * 两种策略（模型实验 C-R1/C-R3 证明二者结果不同，必须显式选）：
 *   - `replace`（默认）：目标文件夹先清空再按快照重建 → 结果**精确等于**快照内容
 *   - `append`：只往目标文件夹里追加 → 本机原有内容与快照内容**并存**
 *
 * 关于 replace 的一个**刻意选择**：只清理并重建「快照里出现过的顶层文件夹」，
 * 不去动根节点下的其他自定义文件夹（例如用户在根目录自建的文件夹）。
 * 理由：根节点不可删除，而"清空根节点下的一切"对用户的破坏性过大。
 * 这个偏差必须在 UI 上向用户说明，不能悄悄做。
 */

import { CollectError, CollectErrorCode, countBookmarks } from './collect.js';

export const RestoreStrategy = {
  REPLACE: 'replace',
  APPEND: 'append',
};

/**
 * 各浏览器「默认文件夹」的可识别 id。
 * 这些 id 在各浏览器里是稳定常量，比按标题匹配可靠。
 */
export const DEFAULT_FOLDER_IDS = {
  toolbar: {
    firefox: ['toolbar_____'],
    chromium: ['1'],
  },
  menu: {
    firefox: ['menu________'],
    chromium: [],                       // Chromium 没有独立的「书签菜单」
  },
  unfiled: {
    firefox: ['unfiled_____'],
    chromium: ['2'],
  },
};

/**
 * 标题回退匹配表（当结构 id 找不到时使用）。
 *
 * **必须包含本地化标题**：中文版浏览器把工具栏叫「书签栏」、其他书签叫「其他书签」，
 * 只列英文名会让中文用户在标题回退路径上失败。中文 Chrome 的「书签栏」对应
 * Chromium 的 id `1`，但「其他书签」的标题在中文版里也是中文，所以两种都要有。
 */
export const DEFAULT_FOLDER_TITLES = {
  toolbar: ['书签栏', '书签工具栏', 'Bookmarks Toolbar', 'Bookmarks bar', 'Bookmarks Bar'],
  menu: ['书签菜单', 'Bookmarks Menu'],
  unfiled: ['其他书签', 'Other Bookmarks', 'Other bookmarks'],
};

/**
 * 跨浏览器还原：来源槽位 → 目标平台的候选槽位（按优先级）。
 *
 * 为什么需要这张表：Firefox 的书签**嵌在「书签菜单」之下**
 * （`书签菜单 > 书签栏 > 书签`），而 **Chromium 根本没有「书签菜单」**。
 * 若只做同名映射，Firefox 快照还原到 Chrome 时整棵子树会被跳过 —— 表现为"新增 0 条"。
 *
 * 因此 Firefox 的 `menu` 在 Chromium 上回退到 `toolbar`；
 * 若来源同时含 `menu` 与 `toolbar`（Firefox 快照通常如此），两者的内容会在
 * 同一目标文件夹里**按 URL 去重**后合并（见 restoreBookmarks 的 seenUrls）。
 */
export const SLOT_FALLBACKS = {
  toolbar: ['toolbar', 'menu', 'unfiled'],
  menu: ['menu', 'toolbar', 'unfiled'],
  unfiled: ['unfiled'],
};

// ---------------------------------------------------------------- 适配器契约

/**
 * 期望的适配器（由薄薄的浏览器层实现）：
 *
 *   getTree(): Promise<node[]>                        书签树
 *   getSubTree(id): Promise<node>                     含 children 的子树
 *   get(id): Promise<node>
 *   create(details): Promise<node>                    { parentId, title, url? }
 *   removeTree(id): Promise<void>
 *   searchTitle(title): Promise<node[]>               可选，用于标题回退匹配
 *
 * 本模块只调用以上方法，不引用任何 `browser` / `chrome` 全局。
 */

// ---------------------------------------------------------------- 差异预览

/** 收集一棵树里所有书签（有 url 的节点），返回 { url, title } 列表 */
export function flattenBookmarks(node, out = []) {
  if (node?.url) {
    out.push({ url: node.url, title: node.title });
    return out;
  }
  for (const c of node?.children ?? []) flattenBookmarks(c, out);
  return out;
}

const keyOf = (b) => `${b.url}\u0000${b.title}`;

/**
 * 抽出「会被本次还原覆盖的那部分」书签 —— 供预览使用。
 *
 * 为什么需要它：`replace` **只清空快照里出现过的槽位**。例如快照含工具栏与
 * 其他书签、但不含「书签菜单」，那么菜单里的书签会被**原样保留**。
 * 若预览时拿**整机书签**去和快照比，"将被删除"会严重高估 —— 与实际执行结果不符。
 *
 * 实现上不判断目标平台：把来源槽位**及其全部回退槽位**的标题都纳入范围。
 * 宁可把范围算宽一点（多报几个"将被删除"），也不要漏报。
 */
export function flattenScoped(currentTree, snapshotBookmarks) {
  const sourceSlots = new Set();
  let hasUnmapped = false;
  for (const node of snapshotBookmarks?.children ?? []) {
    if (node.url) { hasUnmapped = true; continue; }
    const slot = sourceSlotFor(node.title);
    if (slot) sourceSlots.add(slot);
    else hasUnmapped = true;
  }

  const wantedTitles = new Set();
  for (const slot of sourceSlots) {
    for (const cand of [slot, ...(SLOT_FALLBACKS[slot] ?? [])]) {
      for (const t of DEFAULT_FOLDER_TITLES[cand]) wantedTitles.add(t);
    }
  }
  // 未映射内容与根层级书签一律落到「其他书签」，因此它也在覆盖范围内
  if (hasUnmapped) for (const t of DEFAULT_FOLDER_TITLES.unfiled) wantedTitles.add(t);

  const out = [];
  const walk = (node, inside) => {
    const here = inside || (!node.url && wantedTitles.has(String(node.title ?? '').trim()));
    if (node.url) {
      if (here) out.push({ url: node.url, title: node.title });
      return;
    }
    for (const c of node.children ?? []) walk(c, here);
  };
  walk(currentTree, false);
  return out;
}

/**
 * 计算「把 snapshot 还原到 current」会产生什么变化。
 * 用于还原前的预览：让用户看清要新增/删除多少，而不是盲点确认。
 *
 * 传 `scope`（`flattenScoped()` 的结果）时只比较**会被覆盖的槽位**，
 * 避免把刻意保留的「其他书签」也算进删除量。
 */
export function diffBookmarks(currentTree, snapshotBookmarks, { scope = null } = {}) {
  const current = scope ?? flattenBookmarks(currentTree);
  const target = flattenBookmarks(snapshotBookmarks);

  const curSet = new Map();
  for (const b of current) curSet.set(keyOf(b), (curSet.get(keyOf(b)) ?? 0) + 1);
  const tgtSet = new Map();
  for (const b of target) tgtSet.set(keyOf(b), (tgtSet.get(keyOf(b)) ?? 0) + 1);

  const added = [];
  for (const [k, n] of tgtSet) {
    const have = curSet.get(k) ?? 0;
    if (n > have) added.push({ key: k, count: n - have });
  }
  const removed = [];
  for (const [k, n] of curSet) {
    const want = tgtSet.get(k) ?? 0;
    if (n > want) removed.push({ key: k, count: n - want });
  }

  return {
    current: countBookmarks(currentTree),
    target: countBookmarks(snapshotBookmarks),
    addedCount: added.reduce((n, a) => n + a.count, 0),
    removedCount: removed.reduce((n, a) => n + a.count, 0),
    added,
    removed,
    unchanged: current.length === target.length && added.length === 0 && removed.length === 0,
  };
}

// ---------------------------------------------------------------- 定位默认文件夹

/** 在整棵树里按 id 找节点 */
function findById(node, ids) {
  if (ids.includes(node?.id)) return node;
  for (const c of node?.children ?? []) {
    const hit = findById(c, ids);
    if (hit) return hit;
  }
  return null;
}

/** 在整棵树里按标题找节点（可多个） */
function findByTitle(node, titles, out = []) {
  if (!node?.url && titles.includes(node?.title)) out.push(node);
  for (const c of node?.children ?? []) findByTitle(c, titles, out);
  return out;
}

/**
 * 解析出各默认文件夹。
 * 优先用结构 id（可靠），失败再按标题回退。
 * 返回 { toolbar, menu, unfiled }，找不到的为 null。
 */
export async function resolveDefaultFolders(adapter, { platform = 'firefox' } = {}) {
  const tree = await adapter.getTree();
  const root = Array.isArray(tree) ? tree[0] : tree;

  const out = { toolbar: null, menu: null, unfiled: null, platform };
  for (const key of ['toolbar', 'menu', 'unfiled']) {
    const byId = findById(root, DEFAULT_FOLDER_IDS[key][platform] ?? []);
    if (byId) { out[key] = byId; continue; }
    const candidates = findByTitle(root, DEFAULT_FOLDER_TITLES[key]);
    out[key] = candidates[0] ?? null;
  }
  return out;
}

// ---------------------------------------------------------------- 写入

/**
 * 递归把一个快照节点写进 parentId 下；返回新建的书签/文件夹数量。
 *
 * `skipTitles` 里的子节点**不在这里写** —— 它们各自对应一个浏览器默认文件夹，
 * 由自己的槽位处理。没有这一步，「书签栏」会被写两次
 * （一次作为「书签菜单」的子节点，一次作为工具栏）。
 *
 * `seenUrls` 用于**跨槽位去重**：跨浏览器时 Firefox 的「书签菜单」与「书签栏」
 * 会落到同一个目标文件夹（Chromium 没有书签菜单），同一个 URL 只应写一次。
 */
async function writeNode(adapter, parentId, node, skipTitles, seenUrls) {
  if (node?.url) {
    if (seenUrls?.has(node.url)) return { bookmarks: 0, folders: 0, skipped: 1 };
    seenUrls?.add(node.url);
    await adapter.create({ parentId, title: node.title ?? '', url: node.url });
    return { bookmarks: 1, folders: 0, skipped: 0 };
  }
  const folder = await adapter.create({ parentId, title: node.title ?? '' });
  let bookmarks = 0;
  let folders = 1;
  for (const child of node.children ?? []) {
    if (!child.url && skipTitles.has(String(child.title ?? '').trim())) continue;
    const r = await writeNode(adapter, folder.id, child, skipTitles, seenUrls);
    bookmarks += r.bookmarks;
    folders += r.folders;
  }
  return { bookmarks, folders, skipped: 0 };
}

/** 清空一个文件夹下的全部内容（逐个 removeTree） */
async function emptyFolder(adapter, folderId) {
  const sub = await adapter.getSubTree(folderId);
  const children = sub?.children ?? [];
  let removed = 0;
  for (const c of children) {
    await adapter.removeTree(c.id);
    removed++;
  }
  return removed;
}

// ---------------------------------------------------------------- 主流程

/**
 * 还原书签。
 *
 * @param {object} adapter   见上方适配器契约
 * @param {object} opts
 * @param {object} opts.bookmarks   快照里的书签树（根节点）
 * @param {string} opts.strategy    RestoreStrategy.REPLACE（默认）| APPEND
 * @param {string} [opts.platform]  'firefox' | 'chromium'
 * @param {boolean} [opts.dryRun]   true 时只计算不写入
 */
export async function restoreBookmarks(adapter, {
  bookmarks,
  strategy = RestoreStrategy.REPLACE,
  platform = 'firefox',
  dryRun = false,
} = {}) {
  if (!bookmarks || typeof bookmarks !== 'object') {
    throw new CollectError(CollectErrorCode.NO_BOOKMARKS, '没有可还原的书签内容');
  }
  if (![RestoreStrategy.REPLACE, RestoreStrategy.APPEND].includes(strategy)) {
    throw new Error(`未知的还原策略：${strategy}`);
  }

  const folders = await resolveDefaultFolders(adapter, { platform });
  const report = {
    strategy,
    platform,
    dryRun,
    targets: [],
    skipped: [],
    created: { bookmarks: 0, folders: 0 },
    removed: 0,
  };

  // 1) 把快照里的顶层文件夹映射到**目标平台上真实存在的**槽位。
  //    跨浏览器时来源槽位会回退（Firefox 的「书签菜单」→ Chromium 的工具栏），
  //    因此可能有两个来源文件夹落到同一目标上，稍后按 URL 去重。
  const mapped = [];
  const unmapped = [];
  for (const node of bookmarks.children ?? []) {
    if (node.url) {
      unmapped.push(node);
      continue;
    }
    const source = sourceSlotFor(node.title);
    const target = source ? resolveTargetSlot(source, folders) : null;
    if (target) mapped.push({ sourceSlot: source, slot: target, node });
    else unmapped.push(node);
  }

  // 同一目标槽位可能被多个来源文件夹命中（跨浏览器回退），合并去重
  const groups = new Map();          // targetSlot -> [ {sourceSlot, node} ]
  for (const m of mapped) {
    if (!groups.has(m.slot)) groups.set(m.slot, []);
    groups.get(m.slot).push(m);
  }

  // 任何"来源槽位标题"的子文件夹都不应在别的槽位里被重复写入
  const slotTitles = new Set();
  for (const node of bookmarks.children ?? []) {
    if (!node.url && sourceSlotFor(node.title)) slotTitles.add(String(node.title).trim());
  }

  // 2) 命中的槽位：replace 先清空（或 append 直接写），再按其内容重建
  for (const [slot, members] of groups) {
    const target = folders[slot];

    // **只在跨浏览器回退把多个来源合并到同一目标时才去重**。
    // 同浏览器还原时（Firefox 的 menu/toolbar/unfiled 各自独立）保留原样：
    // 书签"既在书签栏也在书签菜单"是合法结构，不该被合并掉。
    const seenUrls = members.length > 1 ? new Set() : null;

    const entry = {
      slot,
      title: members.map((m) => m.node.title).join(' + '),
      folderId: target.id,
      cleared: 0,
      written: null,
      from: members.map((m) => m.sourceSlot),
      deduped: Boolean(seenUrls),
    };

    if (strategy === RestoreStrategy.REPLACE) {
      if (dryRun) {
        const sub = await adapter.getSubTree(target.id);
        entry.cleared = (sub?.children ?? []).length;
      } else {
        entry.cleared = await emptyFolder(adapter, target.id);
      }
      report.removed += entry.cleared;
    }

    if (dryRun) {
      entry.written = countBookmarks({ children: members.map((m) => m.node) });
    } else {
      let b = 0;
      let f = 0;
      for (const m of members) {
        for (const child of m.node.children ?? []) {
          if (!child.url && slotTitles.has(String(child.title ?? '').trim())) continue;
          const r = await writeNode(adapter, target.id, child, slotTitles, seenUrls);
          b += r.bookmarks;
          f += r.folders;
        }
      }
      entry.written = { bookmarks: b, folders: f };
      report.created.bookmarks += b;
      report.created.folders += f;
    }
    report.targets.push(entry);
  }

  // 3) 未命中的部分：挂到「其他书签」，不丢弃。
  //    注意：replace 时**不清空**其他书签里的原有内容 —— 那会删掉用户手写的东西。
  if (unmapped.length) {
    const unfiled = folders.unfiled;
    if (!unfiled) {
      for (const n of unmapped) {
        report.skipped.push({ reason: '找不到「其他书签」文件夹，已跳过', title: n.title, url: n.url });
      }
    } else {
      const entry = { slot: 'unfiled', title: '(未映射内容)', folderId: unfiled.id, cleared: 0, written: null };
      let b = 0;
      let f = 0;
      if (dryRun) {
        b = unmapped.filter((n) => n.url).length;
        f = unmapped.filter((n) => !n.url).length;
      } else {
        for (const n of unmapped) {
          if (n.url) {
            await adapter.create({ parentId: unfiled.id, title: n.title ?? '', url: n.url });
            b++;
          } else {
            // 未映射内容不做跨槽位去重（它们本来就只有一个去处）
            const r = await writeNode(adapter, unfiled.id, n, slotTitles, null);
            b += r.bookmarks;
            f += r.folders;
          }
        }
      }
      entry.written = { bookmarks: b, folders: f };
      report.created.bookmarks += b;
      report.created.folders += f;
      report.targets.push(entry);
    }
  }

  return report;
}

/** 把一个来源槽位标题映射到来源槽位名（不关心目标平台是否存在） */
function sourceSlotFor(title) {
  const t = String(title ?? '').trim();
  for (const slot of ['toolbar', 'menu', 'unfiled']) {
    if (DEFAULT_FOLDER_TITLES[slot].includes(t)) return slot;
  }
  return null;
}

/**
 * 把来源槽位解析成目标平台上真实存在的槽位。
 *
 * 先按 SLOT_FALLBACKS 的优先级找存在的槽位；都不存在（没有任何默认文件夹）返回 null。
 * 这条回退链是「Firefox 快照 → Chrome」能还原的关键。
 */
function resolveTargetSlot(sourceSlot, folders) {
  for (const cand of SLOT_FALLBACKS[sourceSlot] ?? [sourceSlot]) {
    if (folders[cand]) return cand;
  }
  return null;
}

// ---------------------------------------------------------------- 设置还原

/**
 * 还原设置。只写回白名单里成功读到的项，逐项 try/catch。
 * 返回 { applied, failed, skipped }。
 */
export async function restoreSettings({ browserSettings = null, settings = {} } = {}) {
  const applied = [];
  const failed = [];

  for (const [fullKey, value] of Object.entries(settings ?? {})) {
    if (fullKey === 'extension.config') {
      // 不静默跳过：如实报告未还原，并说明原因。
      // 它含本机专属项（机器名、令牌等），盲目写回会破坏当前设备的状态。
      failed.push({ key: fullKey, reason: '扩展自身配置不由还原流程处理（含本机专属项，如机器名与令牌）' });
      continue;
    }
    if (!fullKey.startsWith('browserSettings.')) {
      failed.push({ key: fullKey, reason: 'v1 只还原 browserSettings.* 项' });
      continue;
    }
    const name = fullKey.slice('browserSettings.'.length);
    const api = browserSettings?.[name];
    if (!api || typeof api.set !== 'function') {
      failed.push({ key: fullKey, reason: '该版本不支持写入此项' });
      continue;
    }
    try {
      await api.set({ value });
      applied.push(fullKey);
    } catch (e) {
      failed.push({ key: fullKey, reason: e.message });
    }
  }
  return { applied, failed };
}
