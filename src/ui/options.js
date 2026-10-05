/**
 * 选项页 —— 唯一把 src/lib 各模块接到真实浏览器 API 上的地方
 *
 * 这里**只做三件事**：读 DOM、调 app 的方法、把结果显示出来。
 * 所有判断逻辑都在 src/lib/app.js 里（那一层已被 tests/app-flow.test.mjs 端到端覆盖）。
 *
 * DEK 只存在于本页内存中；关闭标签页即失效，没有"记住我"。
 */

import {
  getApi, detectPlatform, bookmarksAdapter, settingsAdapter, storageAdapter,
  configStore, httpFetch, describeCapabilities, sessionAdapter, persistentSessionAdapter,
} from '../lib/platform.js';
import { createApp } from '../lib/app.js';
import { describePasswordStrength, passwordRequirementText, joinPasswordSegments } from '../lib/crypto.js';
import { ALL_STORE_KEYS } from '../lib/constants.js';

const $ = (id) => document.getElementById(id);
const api = getApi();

if (!api) {
  document.body.innerHTML = '<p class="err">取不到扩展 API：本页必须在扩展环境里打开。</p>';
  throw new Error('no extension API');
}

const capabilities = describeCapabilities(api);

/**
 * 口令默认可见，按钮用来隐藏；令牌另有「显示 / 复制」。
 *
 * 为什么令牌需要「复制」：Gitee 的令牌只在创建时显示一次，
 * 换浏览器（例如 Firefox → Chrome）时用户手上往往已经没有明文了。
 * 没有这个按钮，用户只能开 DevTools 手敲 `storage.local.get('pat')` —— 门槛太高且容易出错。
 */
function initPasswordToggles() {
  for (const btn of document.querySelectorAll('.pw-toggle')) {
    btn.hidden = false;
    const input = document.getElementById(btn.dataset.target);
    if (input?.value) btn.textContent = input.type === 'password' ? '显示' : '隐藏';
    btn.addEventListener('click', () => {
      if (!input) return;
      const nowHidden = input.type === 'text';
      input.type = nowHidden ? 'password' : 'text';
      btn.textContent = nowHidden ? '显示' : '隐藏';
    });
  }
}
initPasswordToggles();

function showCopyButtonIfTokenExists(hasToken) {
  const btn = $('btn-copy-pat');
  btn.hidden = !hasToken;
  btn.onclick = async () => {
    try {
      const cfg = await configStore(api).read();
      if (!cfg.pat) throw new Error('存储里没有令牌');
      await navigator.clipboard.writeText(cfg.pat);
      setState($('config-state'), '令牌已复制到剪贴板。可粘贴到另一台机器；用完请从剪贴板清除。', 'ok');
    } catch (e) {
      setState($('config-state'), `复制失败：${e.message}（可点「显示」后手动选中复制）`, 'err');
    }
  };
}

/** 日志面板：让每一步都可见，尤其是失败原因 */
const logEl = $('log');
function log(msg, extra) {
  const t = new Date().toLocaleTimeString();
  const tail = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  logEl.textContent += `[${t}] ${msg}${tail}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
function setState(el, text, cls = 'muted') {
  el.className = cls;
  el.textContent = text;
}
function reportError(where, err) {
  setState($('op-state'), `${where}失败：${err.message}`, 'err');
  log(`${where}失败`, err.message);
}

const app = createApp({
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
    platform: detectPlatform(api),
    browserName: capabilities.platform,
    appVersion: api.runtime?.getManifest?.()?.version ?? '0.0.0',
    capabilities,
  },
  onLog: (m, e) => log(m, e),
});

// ---------------------------------------------------------------- 初始化

async function init() {
  // 能力边界如实展示
  if (capabilities.note) {
    $('capabilities').hidden = false;
    $('capabilities-text').textContent = capabilities.note;
  }

  const status = await app.getStatus();
  $('owner').value = status.owner ?? '';
  $('repo').value = status.repo ?? '';
  $('machine').value = status.machineName ?? '';
  if (status.hasToken) $('pat').placeholder = '（已保存，留空则不修改）';
  showCopyButtonIfTokenExists(status.hasToken);
  await loadRememberSettings();
  await loadAutoSettings();

  // 先试会话自动解锁；失败再走正常的状态检查
  if (!(await tryAutoUnlock())) await refreshVaultState();
}

async function refreshVaultState() {
  const status = await app.getStatus();
  if (!status.configured) {
    // 明确告知**缺哪一项**：只说"请填写配置"会让用户反复猜（曾经踩过）
    const missing = [];
    if (!status.owner) missing.push('仓库所有者');
    if (!status.repo) missing.push('仓库名');
    if (!status.hasToken) missing.push('个人访问令牌');
    setState($('vault-state'),
      `配置不完整，还缺：${missing.join('、')}。填好第 1 段后点「保存配置」。`
      + (missing.includes('个人访问令牌')
        ? '　⚠ 令牌只存在本机浏览器里、不会同步；重载扩展可能把它清掉，需要重新粘贴。'
        : ''),
      'err');
    $('setup-block').hidden = true;
    $('unlock-block').hidden = true;
    $('ops').hidden = true;
    log('配置不完整', { 缺少: missing });
    return;
  }

  try {
    const initialized = await app.isVaultInitialized();
    $('setup-block').hidden = initialized;
    $('unlock-block').hidden = !initialized;
    setState($('vault-state'), initialized
      ? (status.unlocked ? '已解锁。' : '仓库已初始化，请输入主口令或恢复码解锁。')
      : '仓库尚未初始化：可以建立新仓库。');
    if (status.unlocked) await showOps();
  } catch (e) {
    setState($('vault-state'), `检查仓库状态失败：${e.message}`, 'err');
    log('检查仓库状态失败', e.message);
  }
}

/**
 * 页面加载时先尝试用会话缓存的口令自动解锁 —— 这样刷新或重开选项页都不用再输。
 * 只在浏览器支持会话存储（内存、不落盘）时可用。
 */
async function tryAutoUnlock() {
  if (!sessionAdapter(api)) return false;
  try {
    const ok = await app.tryRestoreSession();
    if (ok) {
      $('btn-lock').hidden = false;
      setState($('vault-state'), '已用本次会话缓存的口令自动解锁。', 'ok');
      $('unlock-block').hidden = true;
      await showOps();
    }
    return ok;
  } catch (e) {
    log('会话自动解锁失败（需手动输入）', e.message);
    return false;
  }
}

// ---------------------------------------------------------------- 配置

$('save-config').addEventListener('click', async () => {
  const owner = $('owner').value.trim();
  const repo = $('repo').value.trim();
  const pat = $('pat').value.trim();
  const machine = $('machine').value.trim();

  if (!owner || !repo) return setState($('config-state'), '请填写仓库所有者与仓库名', 'err');

  const patch = { gitee_owner: owner, gitee_repo: repo };
  if (pat) patch.pat = pat;
  if (machine) patch.machine_name = machine;

  try {
    // 先把"将要写入的内容"记下来（令牌打码），方便与"实际存进去的内容"对照
    const shown = { ...patch };
    if (shown.pat) shown.pat = `(长度 ${shown.pat.length})`;
    log('准备保存', shown);
    log('令牌那一格是否为空', pat ? '否' : '**是 —— 空的不会被写入**');

    await app.saveConfig(patch);
    $('pat').value = '';
    setState($('config-state'), '已保存', 'ok');

    // 保存后立刻用**已证实可用**的按具体键读取回验（不用 get(null)，它在这个版本坏了）
    const keys = ['gitee_owner', 'gitee_repo', 'pat', 'machine_name'];
    const back = (await api.storage.local.get(keys)) ?? {};
    const hits = keys.filter((k) => back[k] !== undefined);
    log('保存后回验（按具体键读）', `${hits.length}/${keys.length} 命中：${hits.join(', ') || '(无)'}`);
    log('  pat 是否在存储里', back.pat !== undefined ? '是' : '**否**');
    log('  gitee_owner =', JSON.stringify(back.gitee_owner));
    log('配置已保存', { owner, repo, machine: machine || '(未变)', 令牌长度: pat ? pat.length : 0 });

    await refreshVaultState();
  } catch (e) {
    setState($('config-state'), `保存失败：${e.message}`, 'err');
    log('保存抛异常', `${e.name}: ${e.message}`);
  }
});

// ---------------------------------------------------------------- 首次建立

// 条件常驻显示（数字从 crypto.js 取，避免文档与实现再次不一致）
$('setup-requirement').textContent = passwordRequirementText();

const segInputs = [...document.querySelectorAll('#setup-segs input')];

/** 读取分段输入，拼成主口令；若用了"手工整串"则以它为准 */
function readSetupPassword() {
  const manual = $('setup-password-manual').value.trim();
  if (manual) return manual;
  return joinPasswordSegments(segInputs.map((i) => i.value));
}

function refreshSetupHint() {
  for (const i of segInputs) i.classList.toggle('filled', i.value.trim().length > 0);

  const password = readSetupPassword();
  const el = $('setup-strength');
  if (!password) { setState(el, '填完前 6 段后这里会显示是否达标。'); return; }
  const s = describePasswordStrength(password);
  setState(el, s.text, s.ok ? 'ok' : 'err');
}

for (const input of segInputs) input.addEventListener('input', refreshSetupHint);
$('setup-password-manual').addEventListener('input', refreshSetupHint);

$('btn-setup').addEventListener('click', async () => {
  const password = readSetupPassword();
  if (!password) return setState($('vault-state'), '请至少填满前 6 段', 'err');

  $('btn-setup').disabled = true;
  setState($('vault-state'), '正在建立…（主口令派生需要约一秒）');
  try {
    const r = await app.setupVault({ password, machineName: $('machine').value.trim() });
    for (const i of segInputs) i.value = '';
    $('setup-password-manual').value = '';

    $('recovery-card').hidden = false;
    $('recovery-code').textContent = r.recoveryCode;
    log('仓库已建立', { snapshotId: r.snapshotId });
    setState($('vault-state'), '仓库已建立。请先保存恢复码。', 'ok');
  } catch (e) {
    reportError('建立仓库', e);
  } finally {
    $('btn-setup').disabled = false;
  }
});

$('btn-copy-recovery').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('recovery-code').textContent);
    setState($('vault-state'), '恢复码已复制。请粘贴到安全的地方（不要放进 Gitee 仓库）。', 'ok');
  } catch (e) {
    setState($('vault-state'), '复制失败，请手动抄写。', 'err');
  }
});

$('btn-confirm-recovery').addEventListener('click', async () => {
  $('recovery-card').hidden = true;
  log('用户确认已保存恢复码');
  await refreshVaultState();
});

// ---------------------------------------------------------------- 解锁

const unlockSegInputs = [...document.querySelectorAll('#unlock-segs input')];

/** 读取解锁用主口令：手工整串优先，否则拼分段 */
function readUnlockPassword() {
  const manual = $('unlock-password').value.trim();
  if (manual) return manual;
  return joinPasswordSegments(unlockSegInputs.map((i) => i.value));
}

for (const i of unlockSegInputs) {
  i.addEventListener('input', () => i.classList.toggle('filled', i.value.trim().length > 0));
}

$('btn-unlock').addEventListener('click', async () => {
  const recoveryCode = $('unlock-recovery').value.trim();
  const password = readUnlockPassword();
  if (!password && !recoveryCode) return setState($('vault-state'), '请填写主口令或恢复码', 'err');

  $('btn-unlock').disabled = true;
  setState($('vault-state'), '正在解锁…（主口令派生需要约一秒）');
  try {
    await app.unlock(password ? { password } : { recoveryCode });
    for (const i of unlockSegInputs) i.value = '';
    $('unlock-password').value = '';
    $('unlock-recovery').value = '';
    $('btn-lock').hidden = false;
    setState($('vault-state'), '已解锁。', 'ok');
    await showOps();
  } catch (e) {
    reportError('解锁', e);
  } finally {
    $('btn-unlock').disabled = false;
  }
});

// 「信任此设备」：勾选即启用（默认 3 天不活动过期）；取消即清除已记住的口令
function refreshRememberNote() {
  const on = $('remember-enabled').checked;
  const days = Number($('remember-days').value) || 3;
  setState($('remember-note'),
    on
      ? `已启用：口令会用**不可导出的设备密钥**加密后写入本机磁盘，不活动超过 ${days} 天需重新输入。`
        + '注意：这挡得住"读文件"，挡不住"以本扩展身份执行代码"（那种情况下浏览器会替它解密）。'
      : '未启用：口令只在内存里，关掉浏览器后需重新输入。',
    on ? 'muted' : 'muted');
}

async function loadRememberSettings() {
  const c = await configStore(api).read();
  const days = Number(c.remember_days ?? 0);
  $('remember-enabled').checked = days > 0;
  if (days > 0) $('remember-days').value = String(days);
  refreshRememberNote();
}

$('remember-enabled').addEventListener('change', async (e) => {
  const days = e.target.checked ? (Number($('remember-days').value) || 3) : 0;
  await app.setRememberDays(days);
  refreshRememberNote();
});

$('remember-days').addEventListener('change', async () => {
  const days = Number($('remember-days').value) || 3;
  $('remember-days').value = String(days);
  if ($('remember-enabled').checked) {
    await app.setRememberDays(days);
    refreshRememberNote();
  }
});

$('btn-lock').addEventListener('click', async () => {
  await app.lock();
  $('btn-lock').hidden = true;
  $('ops').hidden = true;
  setState($('vault-state'), '已锁定（内存中的密钥已清除）。'
    + ($('remember-enabled').checked ? '「信任此设备」仍然有效，重新打开本页会自动解锁。' : ''));
  log('已锁定');
});

// ---------------------------------------------------------------- 上传与快照列表

async function showOps() {
  $('ops').hidden = false;
  await refreshSnapshots();
  await refreshBackupState();
}

$('btn-upload').addEventListener('click', async () => {
  $('btn-upload').disabled = true;
  setState($('op-state'), '正在采集并加密上传…');
  try {
    const r = await app.upload();
    setState($('op-state'),
      `已上传快照 ${r.snapshotId}（书签 ${r.stats.bookmarks} 条，密文 ${r.ciphertextBytes} 字节）。` +
      (r.pruned?.length ? ` 已清理 ${r.pruned.length} 份旧快照。` : ''), 'ok');
    await refreshSnapshots();
  } catch (e) {
    reportError('上传', e);
  } finally {
    $('btn-upload').disabled = false;
  }
});

$('btn-refresh').addEventListener('click', () => refreshSnapshots());

async function refreshSnapshots() {
  const tbody = $('snapshots').querySelector('tbody');
  tbody.replaceChildren();
  try {
    const { machines, thisMachine, collisions } = await app.listSnapshots();
    const rows = [];
    for (const m of machines) {
      for (const s of m.snapshots ?? []) {
        rows.push({ machine: m.machine, browser: m.browser ?? null, snapshot: s, isThis: m.machine === thisMachine });
      }
    }
    rows.sort((a, b) => (a.snapshot.id < b.snapshot.id ? 1 : -1));

    // 机器名冲突提示 —— 名字是给人看的，冲突靠 machine_id 发现
    const warn = $('collision-warning');
    if (collisions?.length) {
      warn.hidden = false;
      $('collision-text').textContent = collisions
        .map((c) => `「${c.machine}」这个机器名下存在两台不同的机器（本机标识 ${short(c.localId)}，云端那份 ${short(c.remoteId)}）`)
        .join('；');
      log('检测到机器名冲突', collisions);
    } else {
      warn.hidden = true;
    }

    $('snapshots-empty').hidden = rows.length > 0;
    for (const r of rows) {
      const tr = document.createElement('tr');

      const tdM = document.createElement('td');
      tdM.textContent = r.machine + (r.isThis ? '（本机）' : '');

      const tdBrowser = document.createElement('td');
      tdBrowser.textContent = browserLabel(r.browser);

      const tdS = document.createElement('td');
      tdS.textContent = r.snapshot.id;

      const tdN = document.createElement('td');
      tdN.textContent = r.snapshot.bookmarks == null ? '—' : `${r.snapshot.bookmarks} 条`;

      const tdSize = document.createElement('td');
      tdSize.textContent = r.snapshot.bytes == null ? '—' : `${r.snapshot.bytes} B`;

      const tdA = document.createElement('td');
      const btn = document.createElement('button');
      btn.textContent = '预览还原';
      btn.addEventListener('click', () => previewRestore(r.machine, r.snapshot.id));
      tdA.append(btn);

      tr.append(tdM, tdBrowser, tdS, tdN, tdSize, tdA);
      tbody.append(tr);
    }
    log('已刷新云端快照', { 机器数: machines.length, 快照数: rows.length });
  } catch (e) {
    reportError('读取快照列表', e);
  }
}

const short = (id) => (id ? String(id).slice(0, 8) : '(未知)');
const browserLabel = (b) => (b === 'firefox' ? 'Firefox' : b === 'chromium' ? 'Chrome/Edge' : (b ?? '未知'));

// ---------------------------------------------------------------- 还原

let pending = null;

async function previewRestore(machine, snapshotId) {
  const strategy = $('strategy').value;
  setState($('op-state'), '正在取回并解密预览…');
  try {
    const p = await app.previewRestore({ machine, snapshotId, strategy });
    pending = { machine, snapshotId };
    $('preview-block').hidden = false;

    const lines = [
      `来源：${p.snapshotMachine} · ${snapshotId}（${browserLabel(p.sourceBrowser)}）`,
      `书签：当前 ${p.diff.current.bookmarks} 条 → 目标 ${p.diff.target.bookmarks} 条`
        + `（新增 ${p.diff.addedCount}，将被删除 ${p.diff.removedCount}）`,
      `设置：将写回 ${p.settingsCount} 项`
        + (p.settingsUnavailable?.length ? `（快照中另有 ${p.settingsUnavailable.length} 项当时就读不到）` : ''),
    ];

    // 跨浏览器提示：结构不同，不能保证一一对应
    if (p.crossBrowser) {
      lines.push(
        `⚠ 跨浏览器还原：快照来自 ${browserLabel(p.sourceBrowser)}，当前是 ${browserLabel(p.targetBrowser)}。`,
        '两个浏览器的书签结构不同（例如 Chrome 没有「书签菜单」，Firefox 的「书签菜单」会合并到工具栏）。',
        '书签内容不会丢，但文件夹层级可能被重新归置。',
      );
    }
    if (p.targetBrowser === 'chromium') {
      lines.push('注意：Chromium 没有浏览器设置接口，设置项无法还原（会被如实报告为未还原）。');
    }
    if (p.platformNote) lines.push(`快照记录的平台说明：${p.platformNote}`);

    $('preview-text').textContent = lines.join('\n');
    setState($('op-state'), '预览完成，确认后再执行还原。', 'ok');
    log('还原预览', { added: p.diff.addedCount, removed: p.diff.removedCount, crossBrowser: p.crossBrowser });
  } catch (e) {
    reportError('还原预览', e);
  }
}

$('strategy').addEventListener('change', () => {
  if (pending) previewRestore(pending.machine, pending.snapshotId);
});

$('btn-cancel-preview').addEventListener('click', () => {
  $('preview-block').hidden = true;
  pending = null;
});

$('btn-restore').addEventListener('click', async () => {
  if (!pending) return;
  const { machine, snapshotId } = pending;
  const strategy = $('strategy').value;
  if (strategy === 'replace' && !confirm(
    '整树替换会清掉目标文件夹里现有的书签，只保留快照里的内容。\n'
    + '（本机当前书签已自动另存一份，可随时用「从还原前备份恢复」找回）\n\n确定继续？',
  )) return;

  $('btn-restore').disabled = true;
  setState($('op-state'), '正在还原…');
  try {
    const res = await app.restore({ machine, snapshotId, strategy });
    setState($('op-state'),
      `还原完成：写入书签 ${res.report.created.bookmarks} 条、文件夹 ${res.report.created.folders} 个，`
      + `清理 ${res.report.removed} 项。设置成功 ${res.settingsResult.applied.length} 项、`
      + `未还原 ${res.settingsResult.failed.length} 项。`, 'ok');
    $('preview-block').hidden = true;
    pending = null;
    log('还原完成', res.report);
    await refreshBackupState();
  } catch (e) {
    reportError('还原', e);
  } finally {
    $('btn-restore').disabled = false;
  }
});

// ---------------------------------------------------------------- 自动备份

function refreshAutoNote() {
  const on = $('auto-backup').checked;
  const min = Number($('auto-minutes').value) || 60;
  const canRun = $('remember-enabled').checked;
  if (!on) { setState($('auto-note'), '未启用自动备份。'); return; }
  setState($('auto-note'),
    canRun
      ? `已启用：每 ${min} 分钟检查一次；书签或设置变化后约 5 分钟自动上传。`
        + '注意：通过 about:config 改的设置不会触发变化事件（平台限制），只能等定时那一次。'
      : '⚠ 已勾选，但未启用「信任此设备」→ 后台拿不到密钥，自动备份不会执行。',
    canRun ? 'muted' : 'err');
}

async function loadAutoSettings() {
  const c = await configStore(api).read();
  $('auto-backup').checked = c.auto_backup === true;
  const min = Number(c.auto_backup_minutes ?? 60);
  $('auto-minutes').value = String(min || 60);
  const last = c.last_auto_backup_at;
  if (last) {
    log('上次自动备份', new Date(last).toLocaleString());
  }
  refreshAutoNote();
}

$('auto-backup').addEventListener('change', async (e) => {
  await configStore(api).write({ auto_backup: e.target.checked });
  refreshAutoNote();
  log(e.target.checked ? '已启用自动备份' : '已关闭自动备份');
});

$('auto-minutes').addEventListener('change', async () => {
  const min = Math.max(5, Number($('auto-minutes').value) || 60);
  $('auto-minutes').value = String(min);
  await configStore(api).write({ auto_backup_minutes: min });
  refreshAutoNote();
});

// ---------------------------------------------------------------- 还原前备份

async function refreshBackupState() {
  try {
    const b = await app.getLocalBackup();
    setState($('backup-state'), b
      ? `最近一次还原前备份：${new Date(b.saved_at).toLocaleString()}（来源 ${b.restored_from}）`
      : '本机还没有「还原前备份」。');
  } catch {
    setState($('backup-state'), '');
  }
}

$('btn-recover').addEventListener('click', async () => {
  if (!confirm('用「还原前备份」覆盖当前书签？\n这会清掉目标文件夹里现有的书签。')) return;
  try {
    const r = await app.recoverFromLocalBackup();
    setState($('op-state'), `已从备份恢复（保存于 ${new Date(r.savedAt).toLocaleString()}）。`, 'ok');
    log('从还原前备份恢复', r.report);
  } catch (e) {
    reportError('从备份恢复', e);
  }
});

// ---------------------------------------------------------------- 换主口令

$('btn-change-password').addEventListener('click', async () => {
  const currentPassword = $('cur-password').value;
  const newPassword = $('new-password').value;
  if (!currentPassword || !newPassword) {
    return setState($('op-state'), '请填写当前口令与新口令', 'err');
  }
  try {
    await app.changePassword({ currentPassword, newPassword });
    $('cur-password').value = '';
    $('new-password').value = '';
    setState($('op-state'), '主口令已轮换。历史快照无需重加密，仍然可读。', 'ok');
  } catch (e) {
    reportError('轮换主口令', e);
  }
});

// ---------------------------------------------------------------- 页内诊断

/**
 * 在**本页**读一次存储并把关键结论打进日志。
 *
 * 为什么不跳转到独立诊断页：独立页面可能是**另一个扩展实例**
 * （每次临时载入都会得到新 UUID，而 storage.local 按实例隔离），
 * 于是"存储是空的"这个结论可能是假的。在同一个页面里查，不存在这个歧义。
 */
$('btn-diag').addEventListener('click', async () => {
  const mask = (v) => (v == null ? String(v) : `(长度 ${String(v).length}) ${String(v).slice(0, 4)}***`);
  try {
    const raw = (await api.storage.local.get(null)) ?? {};
    const keys = Object.keys(raw).sort();
    log(`存储键（${keys.length} 个）`, keys.join(', ') || '(空)');
    for (const k of keys) {
      log(`  ${k} = ${k === 'pat' ? mask(raw[k]) : JSON.stringify(raw[k]).slice(0, 120)}`);
    }

    const cfg = await app.getStatus();
    log('app.getStatus()', {
      configured: cfg.configured,
      owner: cfg.owner,
      repo: cfg.repo,
      hasToken: cfg.hasToken,
      machine: cfg.machineName,
    });
    log(`扩展 URL（用来判断是不是同一个实例）`, location.origin);

    // 写入自测：确认本页能不能写
    const probe = `probe-${Date.now()}`;
    await api.storage.local.set({ __opt_probe__: probe });
    const back = (await api.storage.local.get('__opt_probe__'))?.__opt_probe__;
    log('本页写入自测', back === probe ? `✅ 通过 (${probe})` : `❌ 失败：写 ${probe} 读 ${back}`);
    await api.storage.local.remove('__opt_probe__');

    // ---- 逐步记录：看存储是"一开始就写不进"还是"写了几次之后失效"
    log('—— 逐步写入（每次写完立刻回读）——');
    for (let i = 1; i <= 4; i++) {
      const k = `__step_${i}__`;
      const v = `step${i}-${Date.now()}`;
      let err = null;
      try {
        await api.storage.local.set({ [k]: v });
      } catch (e) {
        err = `${e.name}: ${e.message}`;
      }
      const single = err ? null : (await api.storage.local.get(k))?.[k];
      const allKeys = err ? [] : Object.keys((await api.storage.local.get(null)) ?? {});
      log(`第 ${i} 次写入 ${k}`,
        err ? `❌ set 抛异常：${err}`
          : `写=${v} 单独回读=${single} 全量键=[${allKeys.join(', ')}]`);
    }

    // 反向验证：先写一组三个键，再回读，看是否与键的数量有关
    log('—— 批量写三个键 ——');
    const batch = { __b1__: 'a', __b2__: 'b', __b3__: 'c' };
    try {
      await api.storage.local.set(batch);
      const got = await api.storage.local.get(null);
      log('批量写三键后', JSON.stringify(Object.keys(got ?? {})));
      log('三个键的值', JSON.stringify(got));
    } catch (e) {
      log('批量写抛异常', `${e.name}: ${e.message}`);
    }

    // ---- 定位：是不是 `get(null)` 这种"读取全部"的调用在这个版本里失效
    log('—— 测试各种"读取全部"的写法 ——');
    const probeKey2 = '__enum_probe__';
    await api.storage.local.set({ [probeKey2]: 'here' });
    const variants = [
      ['get(null)', () => api.storage.local.get(null)],
      ['get(undefined)', () => api.storage.local.get(undefined)],
      ['get()', () => api.storage.local.get()],
      ['get([])', () => api.storage.local.get([])],
      ['get(probeKey2)', () => api.storage.local.get(probeKey2)],
      ['get({})', () => api.storage.local.get({})],
    ];
    for (const [label, fn] of variants) {
      try {
        const r = await fn();
        const keys = r && typeof r === 'object' ? Object.keys(r) : [];
        log(`  ${label}`, `返回类型=${typeof r} 键数=${keys.length} 键=[${keys.slice(0, 6).join(', ')}]`);
      } catch (e) {
        log(`  ${label}`, `❌ 抛异常 ${e.name}: ${e.message}`);
      }
    }
    await api.storage.local.remove(probeKey2);

    await api.storage.local.remove(['__step_1__', '__step_2__', '__step_3__', '__step_4__', '__b1__', '__b2__', '__b3__']);

    // ---- 决定性测试：用**已证实可用**的按具体键读取，去读配置的那几个键
    log('—— 用"按具体键读取"去读配置键（这条路径已被证实可用）——');
    const CONFIG_KEYS = ['gitee_owner', 'gitee_repo', 'pat', 'machine_name', 'machine_id', 'remember_days', 'auto_backup'];
    const got = (await api.storage.local.get(CONFIG_KEYS)) ?? {};
    for (const k of CONFIG_KEYS) {
      const v = got[k];
      log(`  ${k}`, v === undefined ? '❌ 不存在' : `✅ 存在 = ${k === 'pat' ? mask(v) : JSON.stringify(v).slice(0, 60)}`);
    }
    log('配置键命中数', `${Object.keys(got).filter((k) => got[k] !== undefined).length} / ${CONFIG_KEYS.length}`);

    // ---- 顺带看"我们自己的全部键"清单能读出什么
    const allOurs = (await api.storage.local.get(ALL_STORE_KEYS)) ?? {};
    log('ALL_STORE_KEYS 命中', Object.keys(allOurs).filter((k) => allOurs[k] !== undefined).join(', ') || '(无)');
    log('ALL_STORE_KEYS 长度', String(ALL_STORE_KEYS.length));

    // ---- 关键：一次读全部 13 个 vs 逐个读，看是否与"一次读几个键"有关
    log('—— 一次读 N 个键的行为 ——');
    for (const n of [1, 2, 4, 8, 13]) {
      const subset = ALL_STORE_KEYS.slice(0, n);
      try {
        const r = (await api.storage.local.get(subset)) ?? {};
        const hit = Object.keys(r).filter((k) => r[k] !== undefined);
        log(`  一次读 ${String(n).padStart(2)} 个键`, `命中 ${hit.length} 个 ${hit.length ? '[' + hit.slice(0, 4).join(', ') + ']' : ''}`);
      } catch (e) {
        log(`  一次读 ${n} 个键`, `❌ 抛异常 ${e.name}: ${e.message}`);
      }
    }
    log('—— 逐个读取（每次只读 1 个键）——');
    const oneByOne = {};
    for (const k of ALL_STORE_KEYS) {
      try {
        const r = (await api.storage.local.get(k)) ?? {};
        if (r[k] !== undefined) oneByOne[k] = r[k];
      } catch { /* 跳过 */ }
    }
    log('  逐个读取命中', `${Object.keys(oneByOne).length} / ${ALL_STORE_KEYS.length}：${Object.keys(oneByOne).join(', ') || '(无)'}`);

    // ---- 修正结论：按证据说话，不要再断言"存储是空的"
    const hits = Object.keys(got).filter((k) => got[k] !== undefined).length;
    if (hits === 0) {
      log('结论', '配置键确实不在存储里 → 写入没有生效（不是读取问题）');
    } else if (hits < CONFIG_KEYS.length) {
      log('结论', `存储里有 ${hits} 个配置键 → 写入部分成功，缺的是没被保存过的那几个`);
    } else {
      log('结论', '配置键都在存储里 → 之前的"空"是 get(null) 的问题，界面读取已修复');
    }
  } catch (e) {
    log('诊断失败', `${e.name}: ${e.message}`);
  }
});

// ---------------------------------------------------------------- 启动

init().catch((e) => {
  setState($('vault-state'), `初始化失败：${e.message}`, 'err');
  log('初始化失败', e.message);
});
