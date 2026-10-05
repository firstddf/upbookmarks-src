/**
 * 采集本地书签与设置 —— 对应 docs/04-repo-layout.md 的「快照载荷格式」
 *
 * 设计原则同 gitee.js：**浏览器 API 全部作为参数注入**，本模块不直接引用
 * `browser` / `chrome` 全局。好处有两个：
 *   1. 核心逻辑（书签树裁剪、设置白名单映射、读不到时的如实记录）可在 Node 里单测；
 *   2. 真正调用浏览器 API 的那一层只剩一个很薄的适配器，便于人工核对。
 *
 * 一条硬规则：**读不到的设置绝不写猜测值或默认值**，而是记进
 * `settingsUnavailable` 并在 `settingsPlatformNote` 里说明原因。
 * 否则还原时会把用户的真实设置静默改成默认值。
 */

import { BROWSER_SETTINGS_WHITELIST, PRIVACY_WHITELIST } from './constants.js';

export class CollectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectError';
    this.code = code;
  }
}

export const CollectErrorCode = {
  NO_BOOKMARKS: 'NO_BOOKMARKS',
  NO_SETTINGS: 'NO_SETTINGS',
  PARENT_MISSING: 'PARENT_MISSING',
};

// ---------------------------------------------------------------- 书签

/**
 * 裁剪书签节点，只保留必要的可移植字段。
 *
 * - 省略 `id` / `parentId`：跨浏览器、跨 profile 的 id 不稳定，还原时由浏览器重新分配。
 * - 保留 `dateAdded`：便于还原后排序与差异比较。
 * - 不备份 favicon：体积大、可重新获取、会引入额外网络请求。
 */
function pruneNode(node) {
  const rawTitle = typeof node?.title === 'string' ? node.title.trim() : '';
  const url = typeof node?.url === 'string' ? node.url : null;

  if (url === null) {
    // 文件夹。**保留空标题**：Firefox 的根节点、书签菜单等本来就标题为空，
    // 强行改成占位符会篡改用户的书签结构。
    const children = (node?.children ?? []).map(pruneNode);
    return { title: rawTitle, children };
  }
  // 书签：空标题才填占位符（否则还原后会出现看不见名字的条目）
  const out = { title: rawTitle !== '' ? rawTitle : '(无标题)', url };
  if (typeof node?.dateAdded === 'number' && Number.isFinite(node.dateAdded)) out.dateAdded = node.dateAdded;
  return out;
}

/**
 * 把整棵书签树压平成一个根节点（bookmarks.getTree() 返回的是只含一个元素的数组）。
 * 返回 `{ title, children }`，与快照载荷里的 `bookmarks` 字段一致。
 */
export function pruneBookmarkTree(tree) {
  if (!Array.isArray(tree) || tree.length === 0) {
    throw new CollectError(CollectErrorCode.NO_BOOKMARKS, '书签树为空：拿不到任何根节点');
  }
  const roots = tree.map(pruneNode);
  if (roots.length === 1) return roots[0];
  return { title: '(全部书签)', children: roots };
}

/**
 * 统计树里的书签数与文件夹数。
 *
 * 语义：**只统计根节点以下的节点**。根节点是我们把 `getTree()` 压平后造的容器
 * （标题通常为空），把它算作"文件夹"没有意义，也会让数字随实现细节变化。
 */
export function countBookmarks(node) {
  let bookmarks = 0;
  let folders = 0;
  const walk = (n) => {
    if (n.url) { bookmarks++; return; }
    folders++;
    for (const c of n.children ?? []) walk(c);
  };
  for (const child of node?.children ?? []) walk(child);
  return { bookmarks, folders };
}

/**
 * 采集书签。
 * @param {object} bookmarksApi  形如 WebExtension 的 `browser.bookmarks`，只需 `getTree`
 */
export async function collectBookmarks(bookmarksApi) {
  if (!bookmarksApi || typeof bookmarksApi.getTree !== 'function') {
    throw new CollectError(CollectErrorCode.NO_BOOKMARKS, '没有可用的书签接口（需要 bookmarks 权限）');
  }
  let tree;
  try {
    tree = await bookmarksApi.getTree();
  } catch (e) {
    throw new CollectError(CollectErrorCode.NO_BOOKMARKS, `读取书签失败：${e.message}`);
  }
  const pruned = pruneBookmarkTree(tree);
  return { bookmarks: pruned, stats: countBookmarks(pruned) };
}

// ---------------------------------------------------------------- 设置

/** 逐项安全求值；返回 { value } 或抛出带原因的 Error */
async function readSetting(getter) {
  const raw = await getter();
  // WebExtension 的 BrowserSetting 形如 { value, levelOfControl }
  if (raw && typeof raw === 'object' && 'value' in raw) {
    if (raw.levelOfControl === 'not_controllable') {
      throw new Error('该项不可读（not_controllable）');
    }
    return raw.value;
  }
  return raw;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 采集设置。
 *
 * @param {object} opts
 * @param {object|null} [opts.browserSettings]  `browser.browserSettings`（Firefox 有，Chrome 没有）
 * @param {object|null} [opts.privacy]          `browser.privacy`
 * @param {object|null} [opts.extensionStorage] 形如 `browser.storage.local`，只需 `get`
 */
export async function collectSettings({ browserSettings = null, privacy = null, extensionStorage = null } = {}) {
  const settings = {};
  const unavailable = [];
  const notes = [];

  if (!browserSettings) {
    notes.push('chrome:no-browserSettings');
  } else {
    for (const key of BROWSER_SETTINGS_WHITELIST) {
      const api = browserSettings[key];
      if (!api || typeof api.get !== 'function') {
        unavailable.push({ key: `browserSettings.${key}`, reason: '该版本不提供此项' });
        continue;
      }
      try {
        const value = await readSetting(() => api.get({}));
        if (value === undefined) {
          unavailable.push({ key: `browserSettings.${key}`, reason: '返回 undefined' });
        } else {
          settings[`browserSettings.${key}`] = value;
        }
      } catch (e) {
        unavailable.push({ key: `browserSettings.${key}`, reason: e.message });
      }
    }
  }

  if (!privacy) {
    if (browserSettings) notes.push('privacy:unavailable');
  } else {
    for (const path of PRIVACY_WHITELIST) {
      const [group, name] = path.split('.');
      const api = privacy?.[group]?.[name];
      if (!api || typeof api.get !== 'function') {
        unavailable.push({ key: `privacy.${path}`, reason: '该版本不提供此项' });
        continue;
      }
      try {
        const value = await readSetting(() => api.get({}));
        if (value === undefined) {
          unavailable.push({ key: `privacy.${path}`, reason: '返回 undefined' });
        } else {
          settings[`privacy.${path}`] = value;
        }
      } catch (e) {
        unavailable.push({ key: `privacy.${path}`, reason: e.message });
      }
    }
  }

  // 扩展自身配置：这些一定能读到（否则扩展自己坏了）
  if (extensionStorage && typeof extensionStorage.get === 'function') {
    try {
      // 优先用稳健的"读取全部"（某些 Firefox 版本 get(null) 返回空，见 platform.js）
      const own = typeof extensionStorage.getAll === 'function'
        ? await extensionStorage.getAll()
        : await extensionStorage.get(null);
      if (isPlainObject(own)) settings['extension.config'] = own;
    } catch (e) {
      unavailable.push({ key: 'extension.config', reason: e.message });
    }
  }

  return {
    settings,
    settingsUnavailable: unavailable,
    settingsPlatformNote: notes.length ? notes.join('; ') : null,
  };
}

// ---------------------------------------------------------------- 汇总

/**
 * 采集全部内容，产出可直接交给 buildSnapshot() 的载荷字段。
 * @param {object} opts  见 collectBookmarks 与 collectSettings
 */
export async function collectAll({ bookmarksApi, browserSettings, privacy, extensionStorage } = {}) {
  const { bookmarks, stats } = await collectBookmarks(bookmarksApi);
  const { settings, settingsUnavailable, settingsPlatformNote } = await collectSettings({
    browserSettings,
    privacy,
    extensionStorage,
  });
  return { bookmarks, settings, settingsUnavailable, settingsPlatformNote, stats };
}

// ---------------------------------------------------------------- 本地还原前备份

/**
 * 还原前把**当前本地状态**先存一份，避免还原本身把数据搞坏。
 * 用注入的 storage 适配器（形如 `browser.storage.local`），只写一个新键，不删除任何已有数据。
 */
export const LOCAL_BACKUP_KEY = 'pre_restore_backup';

export async function saveLocalBackup(storageApi, sourceSnapshotId, bookmarks) {
  if (!storageApi || typeof storageApi.set !== 'function') {
    throw new CollectError(CollectErrorCode.NO_SETTINGS, '没有可用的本地存储接口');
  }
  const record = {
    saved_at: new Date().toISOString(),
    restored_from: sourceSnapshotId,
    bookmarks,
  };
  await storageApi.set({ [LOCAL_BACKUP_KEY]: record });
  return record;
}

export async function readLocalBackup(storageApi) {
  if (!storageApi || typeof storageApi.get !== 'function') return null;
  const r = await storageApi.get(LOCAL_BACKUP_KEY);
  return r?.[LOCAL_BACKUP_KEY] ?? null;
}
