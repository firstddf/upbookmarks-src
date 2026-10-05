#!/usr/bin/env node
/**
 * src/lib/collect.js 的单元测试
 *
 * 全部用假的浏览器 API：无网络、无浏览器。
 * 除了采集逻辑，还包含一个**针对「同机覆盖」设计的模型实验**（C-R1）：
 * 用内存书签模型验证「把采集结果原样放回去」是幂等的，
 * 以及「把一台机器的采集结果合并进一个全新 profile」会发生什么。
 *
 * 用法：
 *   node tests/collect.test.mjs
 */

import {
  collectBookmarks,
  collectSettings,
  collectAll,
  pruneBookmarkTree,
  countBookmarks,
  saveLocalBackup,
  readLocalBackup,
  LOCAL_BACKUP_KEY,
  CollectError,
  CollectErrorCode,
} from '../src/lib/collect.js';

const results = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} · ${title}${ok ? '' : `\n        ${detail ?? ''}`}`);
}
const asError = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------------------------------------------------------------- 假书签 API

/** 典型 Firefox 书签树 */
const firefoxTree = () => [{
  id: 'root________',
  title: '',
  children: [
    {
      id: 'menu________',
      title: '书签菜单',
      children: [
        {
          id: 'toolbar_____',
          title: '书签栏',
          children: [
            { id: 'b1', title: '示例站点', url: 'https://example.com/', dateAdded: 1739000000000, index: 0 },
            { id: 'b2', title: '中文 · 标题', url: 'https://example.org/中文', dateAdded: 1739000000001, index: 1 },
            {
              id: 'f1', title: '子文件夹', children: [
                { id: 'b3', title: '深层书签', url: 'https://deep.example/', dateAdded: 1739000000002, index: 0 },
              ],
            },
          ],
        },
        { id: 'b4', title: '', url: 'https://notitle.example/', dateAdded: 1739000000003, index: 1 },
      ],
    },
    { id: 'unfiled_____', title: '其他书签', children: [{ id: 'b5', title: '未分类', url: 'https://misc.example/', dateAdded: 1739000000004, index: 0 }] },
  ],
}];

const fakeBookmarks = (tree) => ({ getTree: async () => tree });

// ---------------------------------------------------------------- 假设置 API

/** setting(value) → BrowserSetting 形状；settingThrows(msg) → 抛错的 getter */
const setting = (value, levelOfControl = 'controlled_by_this_extension') => ({
  async get() { return { value, levelOfControl }; },
});
const settingThrows = (msg) => ({ async get() { throw new Error(msg); } });
const notControllable = () => ({ async get() { return { value: null, levelOfControl: 'not_controllable' }; } });

// ---------------------------------------------------------------- 内存书签模型

/**
 * 极简书签模型：用文件夹标题匹配。
 * 用于回答「还原会不会产生重复」这个设计问题。
 */
function makeModel(profile) {
  const folders = new Map();          // title -> array of bookmarks
  let seq = 0;
  for (const [title, items] of Object.entries(profile ?? {})) {
    folders.set(title, items.map((b) => ({ ...b, id: `x${seq++}` })));
  }
  return {
    /** 把一棵采集到的树放回模型：按文件夹标题匹配，**追加**（模拟真实浏览器的 add） */
    restoreByAppend(tree) {
      const walk = (node) => {
        if (node.url) return;                       // 只有文件夹需要先建/匹配
        if (!folders.has(node.title)) folders.set(node.title, []);
        for (const child of node.children ?? []) {
          if (child.url) folders.get(node.title).push({ title: child.title, url: child.url, id: `x${seq++}` });
          else walk(child);
        }
      };
      for (const child of tree.children ?? []) walk(child);
      return this;
    },
    dump() {
      const out = {};
      for (const [k, v] of folders) out[k] = v.map((b) => `${b.title}|${b.url}`);
      return out;
    },
    total() { let n = 0; for (const v of folders.values()) n += v.length; return n; },
  };
}

async function main() {
  console.log('='.repeat(70));
  console.log('src/lib/collect.js 单元测试（假浏览器 API）');
  console.log('='.repeat(70) + '\n');

  // ============================================================ 书签裁剪
  {
    const { bookmarks, stats } = await collectBookmarks(fakeBookmarks(firefoxTree()));
    check('C1', '采集书签后压成单一根节点，其下是各顶级文件夹',
      bookmarks.title === '' && bookmarks.children.length === 2
        && bookmarks.children[0].title === "\u4E66\u7B7E\u83DC\u5355"      // 书签菜单
        && bookmarks.children[1].title === "\u5176\u4ED6\u4E66\u7B7E",    // 其他书签
      `标题数=${bookmarks.children.length} codePoints=` +
        bookmarks.children.map((c) => [...c.title].map((x) => x.codePointAt(0).toString(16)).join('.')).join(' '));

    const json = JSON.stringify(bookmarks);
    check('C2', '省略 id / parentId / index（跨 profile 不稳定的字段）',
      !json.includes('"id"') && !json.includes('parentId') && !json.includes('"index"'), json.slice(0, 120));
    check('C3', '除 title/url/dateAdded/children 外没有其他字段', (() => {
      const allowed = new Set(['title', 'url', 'dateAdded', 'children']);
      let bad = null;
      const walk = (n) => {
        for (const k of Object.keys(n)) if (!allowed.has(k)) bad = k;
        for (const c of n.children ?? []) walk(c);
      };
      walk(bookmarks);
      return bad === null;
    })());

    check('C4', '书签保留 dateAdded，文件夹没有 dateAdded/url', (() => {
      const toolbar = bookmarks.children[0].children[0];
      const first = toolbar.children[0];
      return first.dateAdded === 1739000000000 && toolbar.url === undefined && toolbar.dateAdded === undefined;
    })());

    check('C5', '书签的空标题被填为「(无标题)」，但**文件夹的空标题被保留**', (() => {
      const menu = bookmarks.children[0];
      const noTitle = menu.children.find((c) => c.url === 'https://notitle.example/');
      const emptyFolderTitleKept = bookmarks.title === '' && menu.title !== '(无标题)';
      return noTitle?.title === '(无标题)' && emptyFolderTitleKept;
    })(), `root.title=${JSON.stringify(bookmarks.title)} menu.title=${JSON.stringify(bookmarks.children[0].title)}`);

    check('C6', '中文与特殊字符在 URL/标题中保真',
      JSON.stringify(bookmarks).includes('https://example.org/中文') && json.includes('中文 · 标题'));

    check('C7', 'countBookmarks 统计书签数与文件夹数（不含根节点）',
      stats.bookmarks === 5 && stats.folders === 4,
      `${JSON.stringify(stats)}（fixture 里书签 5 个；文件夹 4 个 = 书签菜单/书签栏/子文件夹/其他书签）`);

    const empty = await asError(() => collectBookmarks(fakeBookmarks([])));
    check('C8', '空书签树抛出 NO_BOOKMARKS',
      empty instanceof CollectError && empty.code === CollectErrorCode.NO_BOOKMARKS, empty?.message);

    const noApi = await asError(() => collectBookmarks(null));
    check('C9', '缺少书签接口时抛出明确错误', noApi?.code === CollectErrorCode.NO_BOOKMARKS, noApi?.message);

    const throwApi = await asError(() => collectBookmarks({ getTree: async () => { throw new Error('权限被拒'); } }));
    check('C10', 'getTree 抛错时携带原因', /权限被拒/.test(throwApi?.message ?? ''), throwApi?.message);
  }

  // ============================================================ 设置采集
  {
    const browserSettings = {
      homepageOverride: setting('https://home.example/'),
      newTabPageOverride: setting('https://newtab.example/'),
      javascriptEnabled: setting(false),
      cacheEnabled: settingThrows('该项不可写'),
      cookiesEnabled: setting(null, 'not_controllable'),
      webNotificationsDisabled: setting(true),
      // 其余白名单项故意不提供 → 应记为「该版本不提供此项」
    };
    const privacy = {
      network: { networkPredictionEnabled: setting(false), webRTCIPHandlingPolicy: setting('default') },
      websites: { referrersEnabled: settingThrows('权限不足') },
    };
    const extensionStorage = { get: async () => ({ machine_name: 'desktop', gitee_repo: 'upbookmarks', pat: 'secret' }) };

    const r = await collectSettings({ browserSettings, privacy, extensionStorage });

    check('C11', '只写入成功读到的设置项',
      r.settings['browserSettings.homepageOverride'] === 'https://home.example/'
        && r.settings['browserSettings.javascriptEnabled'] === false
        && r.settings['browserSettings.webNotificationsDisabled'] === true,
      JSON.stringify(r.settings));

    check('C12', '读不到 / 不可控 / 抛错的项进 settingsUnavailable 而不是伪造默认值',
      !('browserSettings.cacheEnabled' in r.settings)
        && !('browserSettings.cookiesEnabled' in r.settings)
        && !('privacy.websites.referrersEnabled' in r.settings)
        && r.settingsUnavailable.some((u) => u.key === 'browserSettings.cacheEnabled')
        && r.settingsUnavailable.some((u) => u.key === 'browserSettings.cookiesEnabled'),
      JSON.stringify(r.settingsUnavailable));

    check('C13', '未提供的白名单项也被记录（该版本不提供此项）',
      r.settingsUnavailable.some((u) => u.key === 'browserSettings.imageAnimation' && /不提供/.test(u.reason)),
      JSON.stringify(r.settingsUnavailable.filter((u) => /不提供/.test(u.reason)).map((u) => u.key)));

    check('C14', 'privacy 子项的键名带完整路径',
      r.settings['privacy.network.networkPredictionEnabled'] === false
        && r.settings['privacy.network.webRTCIPHandlingPolicy'] === 'default',
      JSON.stringify(Object.keys(r.settings)));

    check('C15', '扩展自身配置被采集进去', r.settings['extension.config']?.machine_name === 'desktop');

    // Chrome 场景：完全没有 browserSettings / privacy
    const chrome = await collectSettings({ browserSettings: null, privacy: null, extensionStorage });
    check('C16', 'Chrome 场景：settings 为空、给出平台说明、且不伪造数据',
      Object.keys(chrome.settings).length === 1                     // 只剩 extension.config
        && chrome.settingsPlatformNote === 'chrome:no-browserSettings'
        && !Object.keys(chrome.settings).some((k) => k.startsWith('browserSettings.')),
      `note=${chrome.settingsPlatformNote} keys=${Object.keys(chrome.settings).join(',')}`);

    const noStorage = await collectSettings({ browserSettings: null, privacy: null, extensionStorage: null });
    check('C17', '缺少本地存储时不报错，只是拿不到扩展配置',
      !('extension.config' in noStorage.settings), JSON.stringify(noStorage.settings));
  }

  // ============================================================ 汇总
  {
    const all = await collectAll({
      bookmarksApi: fakeBookmarks(firefoxTree()),
      browserSettings: { homepageOverride: setting('https://home.example/') },
      privacy: null,
      extensionStorage: { get: async () => ({ machine_name: 'desktop' }) },
    });
    check('C18', 'collectAll 汇总出可直接用于 buildSnapshot 的字段',
      all.bookmarks.children.length === 2 && all.stats.bookmarks === 5
        && typeof all.settings === 'object' && Array.isArray(all.settingsUnavailable)
        && 'settingsPlatformNote' in all,
      JSON.stringify({ stats: all.stats, settings: Object.keys(all.settings) }));
  }

  // ============================================================ 还原前本地备份
  {
    const store = {};
    const storageApi = {
      async set(obj) { Object.assign(store, obj); },
      async get(key) { return key === null ? store : { [key]: store[key] }; },
    };
    const { bookmarks } = await collectBookmarks(fakeBookmarks(firefoxTree()));
    const rec = await saveLocalBackup(storageApi, '20260214T103000Z', bookmarks);
    check('C19', '还原前备份写入本地，包含来源快照 id',
      rec.restored_from === '20260214T103000Z' && store[LOCAL_BACKUP_KEY]?.bookmarks?.children?.length === 2,
      JSON.stringify(Object.keys(store)));
    const read = await readLocalBackup(storageApi);
    check('C20', '能读回还原前备份', read?.restored_from === '20260214T103000Z');
    check('C21', '读回不存在的备份返回 null', (await readLocalBackup({ get: async () => ({}) })) === null);
  }

  // ============================================================ 模型实验：同机覆盖 vs 换机器
  {
    const { bookmarks } = await collectBookmarks(fakeBookmarks(firefoxTree()));

    // 场景一：同一台机器，把同一份采集结果放回去（幂等？）
    const same = makeModel({});
    same.restoreByAppend(bookmarks);
    const afterFirst = same.total();
    same.restoreByAppend(bookmarks);
    const afterSecond = same.total();

    check('C-R1', '模型实验：对空 profile **追加式**还原两次会翻倍 —— 说明「直接放回」不是幂等操作',
      afterFirst === 5 && afterSecond === 10,
      `第一次=${afterFirst} 第二次=${afterSecond}`);

    // 场景二：已有内容的 profile 被另一台机器的快照追加还原 → 混合而非替换
    const mixed = makeModel({ 书签栏: [{ title: '本机原有', url: 'https://local.example/' }] });
    mixed.restoreByAppend(bookmarks);
    const dump = mixed.dump();
    const toolbar = dump['书签栏'] ?? [];
    const hasLocal = toolbar.some((s) => s.includes('https://local.example/'));
    const hasRemote = toolbar.some((s) => s.includes('https://example.com/'));

    check('C-R2', '模型实验：把别机快照「追加」到已有 profile 会得到混合结果（本机与云端书签并存）',
      hasLocal && hasRemote,
      `书签栏=${JSON.stringify(toolbar)}`);

    // 场景三：整树替换策略下，结果应精确等于云端内容（本机原有内容消失）
    const findFolder = (node, title) => {
      if (!node.url && node.title === title) return node;
      for (const c of node.children ?? []) {
        const hit = findFolder(c, title);
        if (hit) return hit;
      }
      return null;
    };
    const toolbarNode = findFolder(bookmarks, '书签栏');
    const replaced = { 书签栏: (toolbarNode?.children ?? []).filter((c) => c.url).map((c) => `${c.title}|${c.url}`) };
    check('C-R3', '模型实验：整树替换策略下结果精确等于快照内容（本机原有内容消失）',
      replaced['书签栏'].length === 2
        && !replaced['书签栏'].some((s) => s.includes('local.example'))
        && replaced['书签栏'].some((s) => s.includes('example.com')),
      JSON.stringify(replaced));
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(70));
  console.log(`小结: PASS=${results.length - failed.length}  FAIL=${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  未通过: ${f.id} ${f.title}`);
  console.log('='.repeat(70));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('测试异常终止:', e); process.exitCode = 2; });
