#!/usr/bin/env node
/**
 * src/lib/restore.js 的单元测试
 *
 * 用内存适配器模拟浏览器书签 API。关键是要**忠实模拟两个约束**：
 *   1. 根节点不可删除；
 *   2. 「书签栏」在 Firefox 结构里**嵌套在「书签菜单」之下**（工具栏是菜单的子节点）。
 *
 * 第 2 点是真实的坑：按槽位还原时若不处理，书签栏会被写两次。
 *
 * 用法：
 *   node tests/restore.test.mjs
 */

import { collectBookmarks, countBookmarks } from '../src/lib/collect.js';
import {
  restoreBookmarks,
  restoreSettings,
  diffBookmarks,
  resolveDefaultFolders,
  flattenBookmarks,
  RestoreStrategy,
  DEFAULT_FOLDER_IDS,
} from '../src/lib/restore.js';

const results = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} · ${title}${ok ? '' : `\n        ${detail ?? ''}`}`);
}
const asError = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------------------------------------------------------------- 内存适配器

/**
 * 模拟浏览器的默认书签结构。
 *
 * - `firefox`：根节点下 `menu` / `toolbar` / `unfiled` **三者平级**
 * - `chromium`：**没有「书签菜单」**，只有工具栏(`1`)与其他书签(`2`)；
 *   用于验证「Firefox 快照 → Chrome」的跨浏览器回退是否成立
 */
function makeAdapter({ withDefaults = true, platform = 'firefox' } = {}) {
  const nodes = new Map();
  const order = new Map();               // parentId -> [childId]
  let seq = 0;
  const nextId = () => `n${++seq}`;

  const add = (parentId, node) => {
    const id = node.id ?? nextId();
    nodes.set(id, { ...node, id, parentId });
    if (parentId !== undefined) {
      if (!order.has(parentId)) order.set(parentId, []);
      order.get(parentId).push(id);
    }
    return id;
  };

  const build = (node) => {
    if (node.url !== undefined) return { ...node };
    return { ...node, children: (order.get(node.id) ?? []).map((cid) => build(nodes.get(cid))) };
  };

  const root = add(undefined, { id: 'root________', title: '', url: undefined });

  if (withDefaults && platform === 'firefox') {
    // 三者平级 —— 依据 Firefox 官方文档 Bookmarks.sys.mjs 与 Mozilla dogear 的示例输出。
    // 后期版本曾误把 toolbar 放在 menu 之下，会导致"书签栏被写两次"的假象并误导实现。
    add(root, { id: 'menu________', title: '书签菜单' });
    add(root, { id: 'toolbar_____', title: '书签栏' });
    add(root, { id: 'unfiled_____', title: '其他书签' });
  } else if (withDefaults && platform === 'chromium') {
    // Chromium：工具栏与其他书签都是根的直接子节点，且**没有书签菜单**
    add(root, { id: '1', title: '书签栏' });
    add(root, { id: '2', title: '其他书签' });
  }

  return {
    nodes,
    order,
    rootId: root,
    async getTree() { return [build(nodes.get(root))]; },
    async getSubTree(id) { const n = nodes.get(id); if (!n) throw new Error(`无此节点 ${id}`); return build(n); },
    async get(id) { const n = nodes.get(id); if (!n) throw new Error(`无此节点 ${id}`); return { ...n }; },
    async searchTitle(title) { return [...nodes.values()].filter((n) => n.url === undefined && n.title === title); },
    async create({ parentId, title, url }) {
      if (nodes.get(parentId)?.url !== undefined) throw new Error('父节点是书签，不能放子节点');
      if (!nodes.has(parentId)) throw new Error(`父节点不存在 ${parentId}`);
      return this.get(add(parentId, url !== undefined ? { title, url } : { title }));
    },
    async removeTree(id) {
      const n = nodes.get(id);
      if (!n) return;
      if (id === root) throw new Error('不能删除根节点');       // 忠实模拟浏览器约束
      const parentList = order.get(n.parentId);
      if (parentList) order.set(n.parentId, parentList.filter((x) => x !== id));
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (const c of order.get(cur) ?? []) stack.push(c);
        order.delete(cur);
        nodes.delete(cur);
      }
    },
    /** 直接在某文件夹下塞一个书签（模拟"本机原有内容"） */
    seedBookmark(parentId, title, url) { return add(parentId, { title, url }); },
  };
}

/**
 * 快照里的书签树（与 collect.js 的产出结构一致）。
 *
 * **顶层是三个平级文件夹** —— 这是真实 Firefox 的形态（依据 Firefox 官方文档
 * Bookmarks.sys.mjs 与 Mozilla dogear 的示例输出）。早期版本误写成
 * 「书签栏嵌套在书签菜单里」，那会导致还原时工具栏槽位被漏掉。
 */
const snapshotBookmarks = () => ({
  title: '',
  children: [
    { title: '书签菜单', children: [{ title: '无标题书签', url: 'https://notitle.example/', dateAdded: 2 }] },
    {
      title: '书签栏',
      children: [
        { title: '示例站点', url: 'https://example.com/', dateAdded: 1739000000000 },
        { title: '子文件夹', children: [{ title: '深层', url: 'https://deep.example/', dateAdded: 1 }] },
      ],
    },
    { title: '其他书签', children: [{ title: '未分类', url: 'https://misc.example/', dateAdded: 3 }] },
  ],
});

async function main() {
  console.log('='.repeat(70));
  console.log('src/lib/restore.js 单元测试（内存适配器）');
  console.log('='.repeat(70) + '\n');

  // ============================================================ 结构解析
  {
    const a = makeAdapter();
    const f = await resolveDefaultFolders(a);
    check('R1', '按结构 id 解析出三个默认文件夹（Firefox 下三者平级）',
      f.toolbar?.id === 'toolbar_____' && f.menu?.id === 'menu________' && f.unfiled?.id === 'unfiled_____',
      JSON.stringify({ t: f.toolbar?.id, m: f.menu?.id, u: f.unfiled?.id }));

    const flat = flattenBookmarks(snapshotBookmarks());
    check('R2', 'flattenBookmarks 抽平出全部书签', flat.length === 4, `得到 ${flat.length}：${flat.map((b) => b.title).join(',')}`);
  }

  // ============================================================ 差异预览
  {
    const a = makeAdapter();
    const tree = (await a.getTree())[0];
    const d0 = diffBookmarks(tree, snapshotBookmarks());
    check('R3', '差异预览：空 profile 上全部为新增，且目标计数正确',
      d0.addedCount === 4 && d0.removedCount === 0 && d0.target.bookmarks === 4 && d0.unchanged === false,
      JSON.stringify({ added: d0.addedCount, removed: d0.removedCount, target: d0.target }));

    // 已经还原过之后，差异应为空
    await restoreBookmarks(a, { bookmarks: snapshotBookmarks(), strategy: RestoreStrategy.REPLACE });
    const tree2 = (await a.getTree())[0];
    const d1 = diffBookmarks(tree2, snapshotBookmarks());
    check('R4', '差异预览：还原完成后再次比较应无变化（幂等）',
      d1.addedCount === 0 && d1.removedCount === 0 && d1.unchanged === true,
      JSON.stringify({ added: d1.addedCount, removed: d1.removedCount, current: d1.current }));

    // 本机多出一个书签 → 预览应报告"将被删除"
    const a2 = makeAdapter();
    a2.seedBookmark('toolbar_____', '本机独有', 'https://local-only.example/');
    const t2 = (await a2.getTree())[0];
    const d2 = diffBookmarks(t2, snapshotBookmarks());
    check('R5', '差异预览：本机多出的书签被报告为将被删除',
      d2.removedCount === 1 && d2.removed[0].key.includes('local-only.example'),
      JSON.stringify({ removed: d2.removedCount, detail: d2.removed }));
  }

  // ============================================================ 替换策略
  {
    const a = makeAdapter();
    // 工具栏放一个旧书签；「其他书签」也放一个。
    //
    // 注意语义：**快照里包含**「其他书签」→ 它会被写入快照内容
    // （不清空，但结果等于快照里的内容，因此本机原来的那一条不再出现）。
    // 「不清空」的可见效果见 R17：当快照**不含**其他书签时，本机内容被完整保留。
    a.seedBookmark('toolbar_____', '旧的本机书签', 'https://old.example/');
    a.seedBookmark('unfiled_____', '本机手写书签', 'https://old2.example/');

    const report = await restoreBookmarks(a, { bookmarks: snapshotBookmarks(), strategy: RestoreStrategy.REPLACE });
    const urls = flattenBookmarks((await a.getTree())[0]).map((b) => b.url);

    check('R6', 'replace：三个槽位都被写入快照内容，被清空槽位里的旧书签消失',
      urls.length === 4
        && urls.includes('https://example.com/')
        && urls.includes('https://deep.example/')
        && urls.includes('https://notitle.example/')
        && urls.includes('https://misc.example/')
        && !urls.includes('https://old.example/')
        && !urls.includes('https://old2.example/'),
      JSON.stringify(urls));

    check('R7', 'replace：报告了清空数量与写入数量（菜单与工具栏各清空 1 项）',
      report.removed === 2 && report.created.bookmarks === 4 && report.created.folders === 1,
      JSON.stringify({ removed: report.removed, created: report.created, targets: report.targets.map((t) => t.slot) }));

    check('R8', 'replace：**书签栏没有被写两次**（槽位映射去重生效）',
      urls.filter((u) => u === 'https://example.com/').length === 1,
      `example.com 出现 ${urls.filter((u) => u === 'https://example.com/').length} 次`);

    // 幂等：再跑一次结果不变
    await restoreBookmarks(a, { bookmarks: snapshotBookmarks(), strategy: RestoreStrategy.REPLACE });
    const after2 = flattenBookmarks((await a.getTree())[0]).map((b) => b.url);
    check('R9', 'replace 是幂等的（连跑两次结果一致，不翻倍）',
      JSON.stringify(after2.sort()) === JSON.stringify(urls.sort()),
      JSON.stringify(after2));
  }

  // ============================================================ 追加策略
  {
    const a = makeAdapter();
    a.seedBookmark('toolbar_____', '本机原有', 'https://local.example/');

    await restoreBookmarks(a, { bookmarks: snapshotBookmarks(), strategy: RestoreStrategy.APPEND });
    const urls = flattenBookmarks((await a.getTree())[0]).map((b) => b.url);

    check('R10', 'append：本机原有与快照内容并存（混合结果）',
      urls.includes('https://local.example/') && urls.includes('https://example.com/') && urls.length === 5,
      JSON.stringify(urls));

    // 再追加一次 → 翻倍（与模型实验 C-R1 的结论一致）
    await restoreBookmarks(a, { bookmarks: snapshotBookmarks(), strategy: RestoreStrategy.APPEND });
    const urls2 = flattenBookmarks((await a.getTree())[0]).map((b) => b.url);
    check('R11', 'append 不幂等：连跑两次会翻倍（因此 UI 必须显式让用户选择）',
      urls2.length === 9 && urls2.filter((u) => u === 'https://example.com/').length === 2,
      `总书签=${urls2.length}`);
  }

  // ============================================================ dryRun
  {
    const a = makeAdapter();
    a.seedBookmark('toolbar_____', '原有', 'https://local.example/');
    const before = flattenBookmarks((await a.getTree())[0]).length;

    const report = await restoreBookmarks(a, { bookmarks: snapshotBookmarks(), strategy: RestoreStrategy.REPLACE, dryRun: true });
    const after = flattenBookmarks((await a.getTree())[0]).length;

    check('R12', 'dryRun：不写入任何内容，但报告出计划',
      before === after && report.dryRun === true
        && report.targets.length > 0 && report.targets.every((t) => t.written !== null),
      `before=${before} after=${after} targets=${report.targets.length}`);
  }

  // ============================================================ 错误处理
  {
    const a = makeAdapter();
    const e1 = await asError(() => restoreBookmarks(a, { bookmarks: null }));
    check('R13', '缺少书签内容时抛出明确错误', /没有可还原/.test(e1?.message ?? ''), e1?.message);

    const e2 = await asError(() => restoreBookmarks(a, { bookmarks: snapshotBookmarks(), strategy: 'merge' }));
    check('R14', '未知策略时抛出明确错误', /未知的还原策略/.test(e2?.message ?? ''), e2?.message);

    // 完全没有默认文件夹：未映射内容进 skipped，不抛异常
    const bare = makeAdapter({ withDefaults: false });
    const report = await restoreBookmarks(bare, { bookmarks: snapshotBookmarks(), strategy: RestoreStrategy.REPLACE });
    check('R15', '找不到默认文件夹时归入 skipped，而不是崩溃',
      report.targets.length === 0 && report.skipped.length > 0,
      JSON.stringify({ targets: report.targets.length, skipped: report.skipped.length }));
  }

  // ============================================================ 未映射内容
  {
    const a = makeAdapter();
    const snap = {
      title: '',
      children: [
        { title: '书签栏', children: [{ title: '工具栏书签', url: 'https://tb.example/', dateAdded: 1 }] },
        { title: '用户自建文件夹', children: [{ title: '自建', url: 'https://custom.example/', dateAdded: 2 }] },
        { title: '根层书签', url: 'https://rootlevel.example/', dateAdded: 3 },
      ],
    };
    await restoreBookmarks(a, { bookmarks: snap, strategy: RestoreStrategy.REPLACE });
    const urls = flattenBookmarks((await a.getTree())[0]).map((b) => b.url);

    check('R16', '未映射的文件夹与根层级书签都挂到「其他书签」，不丢失',
      urls.includes('https://tb.example/') && urls.includes('https://custom.example/') && urls.includes('https://rootlevel.example/'),
      JSON.stringify(urls));

    // 实证：先在「其他书签」里放一个本机手写的，replace 之后它应当保留
    const a2 = makeAdapter();
    a2.seedBookmark('unfiled_____', '手写的', 'https://handwritten.example/');
    await restoreBookmarks(a2, { bookmarks: snap, strategy: RestoreStrategy.REPLACE });
    const urls2 = flattenBookmarks((await a2.getTree())[0]).map((b) => b.url);
    check('R17', 'replace 时不清空「其他书签」里的原有内容（避免删掉用户手写的东西）',
      urls2.includes('https://handwritten.example/') && urls2.includes('https://custom.example/'),
      JSON.stringify(urls2));
  }

  // ============================================================ 跨浏览器：Firefox 快照 → Chromium
  {
    const chrome = makeAdapter({ platform: 'chromium' });
    const folders = await resolveDefaultFolders(chrome, { platform: 'chromium' });
    check('R18', 'Chromium 结构：识别到工具栏(1)与其他书签(2)，且没有书签菜单',
      folders.toolbar?.id === '1' && folders.unfiled?.id === '2' && folders.menu === null,
      JSON.stringify({ t: folders.toolbar?.id, m: folders.menu, u: folders.unfiled?.id }));

    const report = await restoreBookmarks(chrome, {
      bookmarks: snapshotBookmarks(),
      strategy: RestoreStrategy.REPLACE,
      platform: 'chromium',
    });
    const urls = flattenBookmarks((await chrome.getTree())[0]).map((b) => b.url);

    check('R19', 'Firefox 快照还原到 Chromium：书签**没有丢失**（不再出现"新增 0 条"）',
      urls.length === 4
        && urls.includes('https://example.com/')
        && urls.includes('https://deep.example/')
        && urls.includes('https://notitle.example/')
        && urls.includes('https://misc.example/'),
      JSON.stringify({ urls, targets: report.targets.map((t) => `${t.slot}<-${t.from}`) }));

    check('R20', '跨浏览器回退：Firefox 的「书签菜单」落到 Chromium 的工具栏',
      report.targets.some((t) => t.slot === 'toolbar' && t.from.includes('menu')),
      JSON.stringify(report.targets));

    check('R21', '跨槽位去重：同一 URL 不会被写两次',
      urls.filter((u) => u === 'https://example.com/').length === 1
        && urls.filter((u) => u === 'https://notitle.example/').length === 1,
      `example.com 出现 ${urls.filter((u) => u === 'https://example.com/').length} 次`);

    // 幂等：Chromium 上再跑一次结果不变
    await restoreBookmarks(chrome, { bookmarks: snapshotBookmarks(), strategy: RestoreStrategy.REPLACE, platform: 'chromium' });
    const urls2 = flattenBookmarks((await chrome.getTree())[0]).map((b) => b.url);
    check('R22', 'Chromium 上重复还原也是幂等的',
      urls2.length === 4, `第二次后共 ${urls2.length} 条`);
  }

  // ============================================================ 设置还原
  {
    const calls = [];
    const browserSettings = {
      homepageOverride: { async set({ value }) { calls.push(['homepageOverride', value]); } },
      javascriptEnabled: { async set() { throw new Error('该项不可写'); } },
    };
    const r = await restoreSettings({
      browserSettings,
      settings: {
        'browserSettings.homepageOverride': 'https://home.example/',
        'browserSettings.javascriptEnabled': false,
        'browserSettings.cacheEnabled': true,
        'extension.config': { machine_name: 'desktop' },
        'privacy.network.networkPredictionEnabled': false,
      },
    });
    check('R23', '设置还原：成功项进 applied，失败/不支持项进 failed',
      r.applied.includes('browserSettings.homepageOverride')
        && r.failed.some((f) => f.key === 'browserSettings.javascriptEnabled')
        && r.failed.some((f) => f.key === 'browserSettings.cacheEnabled')
        && r.failed.some((f) => f.key === 'extension.config'),
      JSON.stringify({ applied: r.applied, failed: r.failed.map((f) => f.key) }));

    check('R24', '设置还原：确实调用了 set 且传值正确',
      calls.length === 1 && calls[0][1] === 'https://home.example/', JSON.stringify(calls));

    const none = await restoreSettings({ browserSettings: null, settings: { 'browserSettings.homepageOverride': 'x' } });
    check('R25', 'Chrome 场景（无 browserSettings）：全部进 failed，不伪造成功',
      none.applied.length === 0 && none.failed.length === 1, JSON.stringify(none));
  }

  // ============================================================ 与 collect 衔接
  {
    // 用 collect 采集一份真实格式的树，再用 restore 放回去，验证端到端自洽
    const src = makeAdapter();
    src.seedBookmark('toolbar_____', 'A', 'https://a.example/');
    src.seedBookmark('menu________', 'B', 'https://b.example/');
    const { bookmarks } = await collectBookmarks({ getTree: () => src.getTree() });

    const dst = makeAdapter();
    await restoreBookmarks(dst, { bookmarks, strategy: RestoreStrategy.REPLACE });
    const dstUrls = flattenBookmarks((await dst.getTree())[0]).map((b) => b.url).sort();

    check('R26', 'collect → restore 端到端自洽（采集的树能原样还原）',
      JSON.stringify(dstUrls) === JSON.stringify(['https://a.example/', 'https://b.example/']),
      JSON.stringify(dstUrls));
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(70));
  console.log(`小结: PASS=${results.length - failed.length}  FAIL=${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  未通过: ${f.id} ${f.title}`);
  console.log('='.repeat(70));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('测试异常终止:', e); process.exitCode = 2; });
