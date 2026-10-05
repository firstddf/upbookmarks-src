/**
 * 应用编排 —— 把各 lib 模块串成完整旅程
 *
 * 关键设计：**本模块不认识 `browser` / `chrome`**，所有外部能力都通过 `deps` 注入。
 * 因此它可以在 Node 里用「假 Gitee + 假浏览器 + 真加密」端到端测试
 * （见 tests/app-flow.test.mjs），这正是"首次建库"与"新设备恢复"这两条
 * 最危险路径能被验证的原因。
 *
 * 关于 DEK：它只在 `createApp()` 返回的实例内存里，**绝不写入任何存储**。
 * 关掉选项页就没了，符合 docs/03-parameters.md 的约定。
 */

import {
  createKeyfile,
  unlockDekFromKeyfile,
  unlockDekForRewrap,
  rewrapWithNewPassword,
  generateRecoveryCode,
  assessPasswordStrength,
} from './crypto.js';
import { createGiteeClient } from './gitee.js';
import {
  buildSnapshot,
  uploadSnapshot,
  listMachines,
  downloadSnapshot,
  isInitialized,
  formatSnapshotId,
  snapshotPath,
  machineDir,
  indexPath,
  countPayloadBookmarks,
} from './snapshot.js';import { collectAll, collectBookmarks, saveLocalBackup, readLocalBackup, CollectError } from './collect.js';
import {
  restoreBookmarks, restoreSettings, diffBookmarks, flattenScoped, RestoreStrategy,
} from './restore.js';

const KEYFILE = 'keyfile.json';

/**
 * @param {object} deps
 * @param {object} deps.config       { read(): Promise<object>, write(patch): Promise<void> }
 * @param {Function} deps.httpFetch  fetch 实现
 * @param {Function} deps.now        () => Date，测试可注入固定时间
 * @param {object} deps.browser      { bookmarksApi, browserSettings, privacy, storageApi }
 * @param {object} deps.platform     { platform, appVersion, browserName }
 * @param {Function} [deps.onLog]
 */
export function createApp(deps) {
  const {
    config, httpFetch, now = () => new Date(), browser = {}, platform = {}, onLog = () => {},
    session = null, persistent = null,
  } = deps;
  if (!config) throw new Error('createApp 需要 config 适配器');
  if (typeof httpFetch !== 'function') throw new Error('createApp 需要 httpFetch');

  /** 会话内缓存用的键 */
  const SESSION_KEY = 'session_password';

  /** 会话内状态：DEK 只在内存 */
  let dek = null;
  let machineName = null;

  const log = (msg, extra) => onLog(msg, extra);

  async function loadConfig() {
    const c = await config.read();
    return {
      owner: c.gitee_owner ?? null,
      repo: c.gitee_repo ?? null,
      pat: c.pat ?? null,
      machineName: c.machine_name ?? null,
      machineId: c.machine_id ?? null,
      lastSnapshotId: c.last_snapshot_id ?? null,
      currentSource: c.current_source ?? null,
    };
  }

  /**
   * 取本机唯一标识；没有就生成一个并存下来。
   *
   * 它是**永久**的（不随机器名变化），只用来判断"同一个机器名下面是不是两台机器"。
   * 重命名机器不会改变它——重命名本来就是同一台机器的正常操作。
   */
  async function ensureMachineId() {
    const c = await config.read();
    if (c.machine_id) return c.machine_id;
    const id = (globalThis.crypto?.randomUUID?.()
      ?? `m-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
    await config.write({ machine_id: id });
    return id;
  }

  function requireClient(cfg) {
    if (!cfg.owner || !cfg.repo) throw new Error('尚未配置 Gitee 仓库（owner/repo）');
    if (!cfg.pat) throw new Error('尚未配置访问令牌');
    return createGiteeClient({ owner: cfg.owner, repo: cfg.repo, token: cfg.pat, fetchImpl: httpFetch });
  }

  /** 从 storage 读回 keyfile（走 Gitee，不落本地） */
  async function fetchKeyfile(client) {
    const f = await client.read(KEYFILE);
    if (!f) return null;
    return JSON.parse(f.text);
  }

  const app = {
    /** 是否已解锁（仅表示内存里有 DEK） */
    get unlocked() { return dek !== null; },
    get machine() { return machineName; },

    /** 读取配置 + 能力自述，供 UI 渲染 */
    async getStatus() {
      const cfg = await loadConfig();
      return {
        configured: Boolean(cfg.owner && cfg.repo && cfg.pat),
        owner: cfg.owner,
        repo: cfg.repo,
        hasToken: Boolean(cfg.pat),
        machineName: cfg.machineName,
        unlocked: dek !== null,
        capabilities: platform.capabilities ?? null,
        platform: platform.platform ?? 'unknown',
      };
    },

    /** 保存配置（不动令牌以外的既有字段） */
    async saveConfig(patch) {
      await config.write(patch);
      if (patch.machine_name) machineName = patch.machine_name;
      return app.getStatus();
    },

    /** 仓库里是否已有 keyfile（首次使用判定） */
    async isVaultInitialized() {
      const cfg = await loadConfig();
      const client = requireClient(cfg);
      return isInitialized(client);
    },

    /**
     * 首次建立仓库：生成 DEK、写 keyfile、把本机状态传成第一份快照。
     * 返回 { recoveryCode, snapshotId }。**恢复码只在这里返回一次。**
     */
    async setupVault({ password, machineName: name }) {
      const strength = assessPasswordStrength(password);
      if (!strength.ok) {
        throw new Error(`主口令强度不足：${strength.reasons.join('；')}`);
      }
      const cfg = await loadConfig();
      const client = requireClient(cfg);

      const already = await fetchKeyfile(client);
      if (already) throw new Error('仓库里已存在 keyfile.json，不能重复初始化（请改用解锁）');

      const recoveryCode = generateRecoveryCode();
      const { keyfile, dek: newDek } = await createKeyfile({ password, recoveryCode });

      await client.assertPrivate();
      await client.putFile(KEYFILE, JSON.stringify(keyfile, null, 2), 'init: keyfile');
      dek = newDek;

      const machine = name || cfg.machineName || 'desktop';
      machineName = machine;
      await config.write({ machine_name: machine });

      const built = await app._buildLocalSnapshot(machine);
      const up = await uploadSnapshot(client, { dek, machine, snapshot: built.snapshot });
      await config.write({
        last_snapshot_id: up.snapshotId,
        current_source: machine,
      });

      log('仓库初始化完成', { snapshotId: up.snapshotId });
      return { recoveryCode, snapshotId: up.snapshotId, keyfile, upload: up };
    },

    /**
     * 新设备首次使用：从仓库取 keyfile 并用主口令解锁。
     * 这一步**只依赖 network + 主口令**，不依赖任何本地状态。
     */
    async unlock({ password, recoveryCode }) {
      const cfg = await loadConfig();
      const client = requireClient(cfg);
      const keyfile = await fetchKeyfile(client);
      if (!keyfile) throw new Error('仓库里没有 keyfile.json（请先用「首次建立」）');
      dek = await unlockDekFromKeyfile(keyfile, { password, recoveryCode });

      // 记住本机名与标识：换机器时配置是空的，必须让「解锁 → 上传/列表」
      // 这条路径也拿得到机器名，否则本机名会丢，重名检测也会失效。
      machineName = machineName || cfg.machineName || null;
      await ensureMachineId();
      if (!cfg.machineName && machineName) await config.write({ machine_name: machineName });

      // 会话内免输：口令放**内存**会话存储（不落磁盘），关浏览器即失效
      if (password && session) {
        try { await session.set({ [SESSION_KEY]: password }); } catch { /* 不可用时忽略 */ }
      }
      // 「信任此设备」：口令用**不可导出的设备密钥**加密后落盘，按不活动天数过期
      if (password && persistent && (await app.rememberEnabled())) {
        try { await persistent.set({ [SESSION_KEY]: password }); } catch { /* 忽略 */ }
      }

      log('解锁成功', { machine: machineName ?? '(未设置)' });
      return true;
    },

    /** 「信任此设备」是否启用（有效期 > 0 且适配器可用） */
    async rememberEnabled() {
      if (!persistent) return false;
      const c = await config.read();
      return Number(c.remember_days ?? 0) > 0;
    },

    /** 设置/关闭「信任此设备」的有效期（天）。关闭时立即清除已记住的口令。 */
    async setRememberDays(days) {
      const n = Math.max(0, Number(days) || 0);
      await config.write({ remember_days: n });
      if (n === 0) {
        await app.clearRememberedPassword();
        log('已关闭「信任此设备」，记住的口令已清除');
      } else {
        log(`已启用「信任此设备」：不活动超过 ${n} 天需重新输入口令`);
      }
      return n;
    },

    async clearRememberedPassword() {
      if (session) { try { await session.remove(SESSION_KEY); } catch { /* 忽略 */ } }
      if (persistent) { try { await persistent.remove(SESSION_KEY); } catch { /* 忽略 */ } }
    },

    /** 刷新「最后使用时间」——不活动才过期，活跃使用不会把用户踢出去 */
    async touchRemembered() {
      if (session) { try { await session.touch?.(SESSION_KEY); } catch { /* 忽略 */ } }
      if (persistent) { try { await persistent.touch?.(SESSION_KEY); } catch { /* 忽略 */ } }
    },

    /**
     * 尝试用会话内缓存的口令自动解锁。
     *
     * 仅当浏览器支持 `storage.session`（内容只在内存）且用户上次勾选了
     * 「本次会话免输」时生效。页面重载会重新派生一次（约 1 秒），
     * 但**整场浏览器会话只需输一次**。
     *
     * 返回 true 表示已自动解锁。
     */
    async tryRestoreSession() {
      if (dek) return true;

      // 1) 先试会话存储（内存，最安全）
      if (session) {
        let cached = null;
        try {
          const r = await session.get(SESSION_KEY);
          cached = r?.[SESSION_KEY] ?? null;
        } catch { cached = null; }
        if (cached) {
          try {
            await app.unlock({ password: cached });
            log('已使用本次会话缓存的口令自动解锁');
            return true;
          } catch { try { await session.remove(SESSION_KEY); } catch { /* 忽略 */ } }
        }
      }

      // 2) 再试「信任此设备」（落盘但被设备密钥加密，按不活动天数过期）
      if (persistent && (await app.rememberEnabled())) {
        let cached = null;
        try {
          const r = await persistent.get(SESSION_KEY);
          cached = r?.[SESSION_KEY] ?? null;
        } catch { cached = null; }
        if (cached) {
          try {
            await app.unlock({ password: cached });
            log('已使用「信任此设备」记住的口令自动解锁');
            return true;
          } catch {
            // 口令失效（例如仓库换过主口令）→ 清掉，要求手动输入
            try { await persistent.remove(SESSION_KEY); } catch { /* 忽略 */ }
          }
        }
      }
      return false;
    },

    /** 是否启用了会话内缓存 */
    async hasSessionCache() {
      if (!session) return false;
      try {
        const r = await session.get(SESSION_KEY);
        return Boolean(r?.[SESSION_KEY]);
      } catch { return false; }
    },

    /** 清掉会话缓存（用户取消勾选「本次会话免输」时调用） */
    async clearSessionCache() {
      if (!session) return;
      try { await session.remove(SESSION_KEY); } catch { /* 忽略 */ }
    },

    /**
     * 换主口令。
     *
     * **要求重新输入当前口令**，原因是一个 WebCrypto 的硬约束：
     * `wrapKey` 只能包裹**可导出**的密钥，而运行态 DEK 是刻意不可导出的
     * （见 docs/02-design.md 与 crypto.js）。
     * 因此这里用当前口令现场解出一把可导出的 DEK 用于重新包裹，
     * 内存里继续保存不可导出的那把 —— 约束不放松，且轮换本身也要求证明身份。
     *
     * 因为只用 DEK 重新包裹、不触碰历史快照，**旧快照无需重加密**。
     */
    async changePassword({ currentPassword, newPassword }) {
      if (!dek) throw new Error('尚未解锁');
      if (!currentPassword) throw new Error('轮换主口令需要重新输入当前口令');
      const strength = assessPasswordStrength(newPassword);
      if (!strength.ok) throw new Error(`新主口令强度不足：${strength.reasons.join('；')}`);

      const cfg = await loadConfig();
      const client = requireClient(cfg);
      const keyfile = await fetchKeyfile(client);
      if (!keyfile) throw new Error('仓库里没有 keyfile.json');

      // 用当前口令解出一把**可导出**的 DEK，仅供本次重新包裹使用
      let extractable;
      try {
        extractable = await unlockDekForRewrap(keyfile, { password: currentPassword });
      } catch {
        throw new Error('当前口令不正确');
      }

      const updated = await rewrapWithNewPassword(keyfile, extractable, newPassword);
      await client.putFile(KEYFILE, JSON.stringify(updated, null, 2), 'rotate: password');
      log('主口令已轮换');
      return true;
    },

    /** 内部：采集本机状态并组装快照对象 */
    async _buildLocalSnapshot(machine) {
      const collected = await collectAll({
        bookmarksApi: browser.bookmarksApi,
        browserSettings: browser.browserSettings,
        privacy: browser.privacy,
        extensionStorage: browser.storageApi,
      });
      const machineId = await ensureMachineId();
      return {
        snapshot: buildSnapshot({
          machine,
          machineId,
          browser: platform.browserName ?? 'unknown',
          appVersion: platform.appVersion ?? '0.0.0',
          bookmarks: collected.bookmarks,
          settings: collected.settings,
          settingsUnavailable: collected.settingsUnavailable,
          settingsPlatformNote: collected.settingsPlatformNote,
          date: now(),
        }),
        stats: collected.stats,
      };
    },

    /** 上传一份快照（本机当前状态） */
    async upload({ machine } = {}) {
      if (!dek) throw new Error('尚未解锁');
      const cfg = await loadConfig();
      const client = requireClient(cfg);
      await client.assertPrivate();
      const m = machine || machineName || cfg.machineName;
      if (!m) throw new Error('尚未设置机器名');

      const { snapshot, stats } = await app._buildLocalSnapshot(m);
      const up = await uploadSnapshot(client, { dek, machine: m, snapshot });
      // 上传用的机器名要落盘：否则下次打开选项页就"忘了自己叫什么"，
      // 列表里的「本机」标记与重名检测都会失效。
      await config.write({ last_snapshot_id: up.snapshotId, current_source: m, machine_name: m });
      machineName = m;
      // 有"活动"就刷新「信任此设备」的时间戳 —— 用户要求的是"不活动才过期"
      await app.touchRemembered();
      log('上传完成', { snapshotId: up.snapshotId });
      return { ...up, stats };    },

    /**
     * 列出所有机器及其快照，并顺带做**重名检测**。
     *
     * 为什么需要重名检测：`machine` 是用户自己起的名字，两台机器可能都叫 `desktop`。
     * 重名会让两份不同的备份历史落进同一个目录，表现为"看起来是同一台机器"、
     * 保留策略也会把两份历史混在一起按时间删。因此这里比对 index.json 里记录的
     * `machine_id`，不一致就提示改名。
     */
    async listSnapshots() {
      const cfg = await loadConfig();
      const client = requireClient(cfg);
      const machines = await listMachines(client);

      const localId = cfg.machineId ?? null;
      const localName = machineName || cfg.machineName || null;
      const collisions = [];
      // **只看与本机同名的那个目录**：本机只可能和"用了同一个名字的机器"冲突。
      // 检查所有目录会把无关机器也算进来（第三台机器看到别人重名也会告警）。
      if (localId && localName) {
        const mine = machines.find((m) => m.machine === localName);
        // 扫描该目录下**所有**快照的机器标识，而不是只看最新一条：
        // 重名时两台机器轮流上传，各自看到的"最新一条"往往是自己写的，
        // 只看最新就会双方都检测不到冲突。
        const foreign = (mine?.snapshots ?? [])
          .map((s) => s.machine_id)
          .filter((id) => id && id !== localId);
        if (foreign.length > 0) {
          collisions.push({
            machine: localName,
            remoteId: foreign[0],
            localId,
            foreignSnapshots: foreign.length,
          });
        }
      }

      return {
        machines,
        thisMachine: machineName || cfg.machineName,
        thisMachineId: localId,
        collisions,
      };
    },

    /**
     * 还原前预览：取回指定快照、解密、与当前本地状态做差异。
     * 不写入任何东西。
     *
     * 差异只比较**会被覆盖的槽位**（`flattenScoped`），
     * 否则会把刻意保留的「其他书签」也算成"将被删除"。
     */
    async previewRestore({ machine, snapshotId, strategy = RestoreStrategy.REPLACE }) {
      if (!dek) throw new Error('尚未解锁');
      const cfg = await loadConfig();
      const client = requireClient(cfg);
      const dl = await downloadSnapshot(client, { dek, machine, snapshotId });

      const localTree = await browser.bookmarksApi.getTree();
      const localRoot = Array.isArray(localTree) ? localTree[0] : localTree;
      const snapshotBookmarks = dl.snapshot.payload.bookmarks;
      const scope = flattenScoped(localRoot, snapshotBookmarks);
      const diff = diffBookmarks(localRoot, snapshotBookmarks, { scope });

      const sourceBrowser = dl.snapshot.browser ?? 'unknown';
      const targetBrowser = platform.platform ?? 'unknown';

      return {
        machine,
        snapshotId,
        strategy,
        diff,
        scopeCount: scope.length,
        bookmarksInSnapshot: countPayloadBookmarks(snapshotBookmarks),
        sourceBrowser,
        targetBrowser,
        crossBrowser: sourceBrowser !== 'unknown' && targetBrowser !== 'unknown' && sourceBrowser !== targetBrowser,
        snapshotCreatedAt: dl.snapshot.created_at ?? null,
        snapshotMachine: dl.snapshot.machine ?? machine,
        settingsCount: Object.keys(dl.snapshot.payload.settings ?? {}).length,
        settingsUnavailable: dl.snapshot.payload.settings_unavailable ?? [],
        platformNote: dl.snapshot.payload.settings_platform_note ?? null,
        snapshot: dl.snapshot,
      };
    },

    /**
     * 还原。**先备份当前本地状态**，再写入。
     * 返回 { report, settingsResult, localBackup }。
     */
    async restore({ machine, snapshotId, strategy = RestoreStrategy.REPLACE, snapshot }) {
      if (!dek) throw new Error('尚未解锁');
      const cfg = await loadConfig();
      const client = requireClient(cfg);

      let snap = snapshot;
      if (!snap) {
        const dl = await downloadSnapshot(client, { dek, machine, snapshotId });
        snap = dl.snapshot;
      }

      // 1) 先把当前本地书签存一份（防还原本身搞坏数据）
      let localBackup = null;
      try {
        const { bookmarks } = await collectBookmarks(browser.bookmarksApi);
        localBackup = await saveLocalBackup(browser.storageApi, snapshotId, bookmarks);
      } catch (e) {
        // 备份失败不应阻止还原，但必须让上层知道
        localBackup = { error: e.message };
        log('还原前本地备份失败', { error: e.message });
      }

      // 2) 还原书签
      const report = await restoreBookmarks(browser.bookmarksApi, {
        bookmarks: snap.payload.bookmarks,
        strategy,
        platform: platform.platform === 'chromium' ? 'chromium' : 'firefox',
      });

      // 3) 还原设置
      const settingsResult = await restoreSettings({
        browserSettings: browser.browserSettings,
        settings: snap.payload.settings,
      });

      // 4) 记录本机当前状态的来源，让下载界面的来源标签保持连贯
      const nextMachine = machine || machineName;
      await config.write({ current_source: nextMachine });
      machineName = nextMachine;

      log('还原完成', { strategy, report });
      return { report, settingsResult, localBackup };
    },

    /** 取回最近一次"还原前本地备份"，用于万一还原错了能救回来 */
    async getLocalBackup() {
      return readLocalBackup(browser.storageApi);
    },

    /** 从"还原前本地备份"恢复 */
    async recoverFromLocalBackup() {
      const backup = await readLocalBackup(browser.storageApi);
      if (!backup?.bookmarks) throw new Error('没有可用的还原前备份');
      const report = await restoreBookmarks(browser.bookmarksApi, {
        bookmarks: backup.bookmarks,
        strategy: RestoreStrategy.REPLACE,
        platform: platform.platform === 'chromium' ? 'chromium' : 'firefox',
      });
      log('已从还原前备份恢复', { report });
      return { report, savedAt: backup.saved_at, restoredFrom: backup.restored_from };
    },

    /** 退出解锁状态（清掉内存里的 DEK 与会话缓存；保留"信任此设备"） */
    async lock() {
      dek = null;
      if (session) { try { await session.remove(SESSION_KEY); } catch { /* 忽略 */ } }
    },

    // 暴露给测试
    _setDek(d) { dek = d; },
    _getDek() { return dek; },
    _machineDirFor: (m) => machineDir(m),
    _snapshotPathFor: (m, id) => snapshotPath(m, id),
    _formatSnapshotId: formatSnapshotId,
    _keyfilePath: KEYFILE,
    _errors: { CollectError },
  };

  return app;
}
