/**
 * 后台脚本（Firefox 走 event page，Chromium 走 service worker）
 *
 * 职责：
 *   1. 自动备份 —— 定时 + 书签/设置变化触发（**必须**先有可用密钥，见下）；
 *   2. 点图标打开选项页。
 *
 * ⚠️ 关于"密钥从哪来"这个关键约束：
 *   后台拿不到选项页内存里的密钥。所以自动备份**只能**在下面任一条件下工作：
 *     - 用户启用了「信任此设备」（口令被设备密钥加密后落盘，后台可解）；
 *     - 或本次浏览器会话里用户已经解锁过（内存会话存储里有）。
 *   两者都没有时，后台**什么都不做**，只在控制台记一条日志 ——
 *   而不是偷偷把密钥落盘。这是刻意的取舍：自动备份的便利，
 *   以用户明确启用「信任此设备」为前提。
 */

import {
  getApi, configStore, bookmarksAdapter, settingsAdapter, storageAdapter,
  httpFetch, detectPlatform, describeCapabilities, sessionAdapter, persistentSessionAdapter,
} from './lib/platform.js';
import { createApp } from './lib/app.js';
import { STORE_KEYS } from './lib/constants.js';

const ALARM_NAME = 'upbookmarks-auto';
/** 书签/设置变化后的静默期：避免连续编辑时反复上传 */
const QUIET_MS = 5 * 60 * 1000;

const api = getApi();

if (api) {
  const platform = detectPlatform(api);
  const capabilities = describeCapabilities(api);

  let app = null;
  let cachedConfig = null;

  function buildApp() {
    if (app) return app;
    app = createApp({
      config: configStore(api),
      httpFetch: httpFetch(),
      session: sessionAdapter(api),
      persistent: persistentSessionAdapter(api),
      browser: {
        bookmarksApi: bookmarksAdapter(api),
        browserSettings: settingsAdapter(api).browserSettings,
        privacy: settingsAdapter(api).privacy,
        storageApi: storageAdapter(api),
      },
      platform: {
        platform,
        browserName: capabilities.platform,
        appVersion: api.runtime?.getManifest?.()?.version ?? '0.0.0',
      },
      onLog: (m, e) => console.info('[upbookmarks]', m, e ?? ''),
    });
    return app;
  }

  async function readAutoConfig() {
    const c = await configStore(api).read();
    cachedConfig = c;
    return {
      enabled: c[STORE_KEYS.autoBackup] === true,
      minutes: Number(c[STORE_KEYS.autoBackupMinutes] ?? 60) || 60,
    };
  }

  /** 确保 DEK 可用；不可用则返回 false（不静默落盘密钥） */
  async function ensureUnlocked() {
    const a = buildApp();
    if (a.unlocked) return true;
    try {
      return await a.tryRestoreSession();
    } catch {
      return false;
    }
  }

  /** 执行一次自动上传 */
  async function runAutoBackup(reason) {
    const cfg = await readAutoConfig();
    if (!cfg.enabled) return { skipped: 'disabled' };

    if (!(await ensureUnlocked())) {
      console.info('[upbookmarks] 自动备份跳过：没有可用密钥（未启用「信任此设备」，且本次会话未解锁）');
      return { skipped: 'locked' };
    }

    const a = buildApp();
    try {
      const r = await a.upload();
      await configStore(api).write({ [STORE_KEYS.lastAutoBackupAt]: new Date().toISOString() });
      console.info(`[upbookmarks] 自动备份完成（${reason}）`, { snapshotId: r.snapshotId, bookmarks: r.stats?.bookmarks });
      return { ok: true, snapshotId: r.snapshotId };
    } catch (e) {
      console.warn('[upbookmarks] 自动备份失败', e.message);
      return { error: e.message };
    }
  }

  /** 重建定时器：间隔由配置决定 */
  async function rescheduleAlarm() {
    const cfg = await readAutoConfig();
    if (api.alarms) {
      await api.alarms.clear(ALARM_NAME);
      if (cfg.enabled) {
        api.alarms.create(ALARM_NAME, { periodInMinutes: cfg.minutes });
      }
    }
  }

  if (api.alarms) {
    api.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_NAME) void runAutoBackup('定时');
    });
  }

  // ---- 书签变化：去抖动后上传
  let pendingTimer = null;
  function scheduleAfterChange() {
    if (!api.alarms) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    // 静默期结束后再上传：连续编辑书签时不会产生一堆快照
    pendingTimer = setTimeout(() => { pendingTimer = null; void runAutoBackup('书签变化'); }, QUIET_MS);
  }

  if (api.bookmarks) {
    for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) {
      const target = api.bookmarks[ev];
      if (target?.addListener) target.addListener(() => { void scheduleAfterChange(); });
    }
  }

  // ---- 设置变化（Firefox 有 BrowserSetting.onChange；Chrome 无此 API）
  // 注意：通过 about:config 改的设置不会触发，这是平台限制。
  if (api.browserSettings) {
    for (const name of Object.keys(api.browserSettings)) {
      const setting = api.browserSettings[name];
      if (setting?.onChange?.addListener) setting.onChange.addListener(() => { void scheduleAfterChange(); });
    }
  }

  // ---- 配置变化（选项页保存后立即按新间隔生效）
  if (api.storage?.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (STORE_KEYS.autoBackup in changes || STORE_KEYS.autoBackupMinutes in changes) {
        void rescheduleAlarm();
      }
    });
  }

  if (api.runtime?.onInstalled) {
    api.runtime.onInstalled.addListener((details) => {
      console.info('[upbookmarks] 已安装', { reason: details.reason, ...capabilities });
      void rescheduleAlarm();
    });
  }
  if (api.runtime?.onStartup) {
    api.runtime.onStartup.addListener(() => { void rescheduleAlarm(); });
  }

  // 启动时就建立定时器（后台被唤醒时也会跑到这里）
  void rescheduleAlarm();

  if (api.action?.onClicked) {
    api.action.onClicked.addListener(() => {
      if (api.runtime?.openOptionsPage) api.runtime.openOptionsPage();
    });
  }
}
