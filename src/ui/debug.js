/**
 * 诊断页 —— 直接打印扩展实际存储的内容
 *
 * 用途：当"保存配置"看起来成功、但状态仍显示缺少令牌时，
 * 这一页能立刻区分三种原因：
 *   1. 键写进去了、但读的键名不一致（代码 bug）
 *   2. 根本没写进去（保存流程 bug）
 *   3. 写进去了、但读写用的不是同一个存储区
 *
 * 令牌会**打码**显示（只露前 4 位与长度），避免诊断页本身泄露凭据。
 */

import { getApi, configStore, sessionAdapter, describeCapabilities, detectPlatform } from '../lib/platform.js';
import { STORE_KEYS } from '../lib/constants.js';

const api = getApi();
const out = document.getElementById('out');

const mask = (v) => {
  if (v == null) return String(v);
  const s = String(v);
  if (s.length <= 8) return `(长度 ${s.length}) ${s.slice(0, 2)}***`;
  return `(长度 ${s.length}) ${s.slice(0, 4)}***${s.slice(-2)}`;
};

async function buildReport() {
  const lines = [];
  const line = (k, v) => lines.push(`${k.padEnd(28)} ${v}`);

  if (!api) {
    lines.push('❌ 取不到扩展 API：本页必须在扩展环境里打开。');
    return lines.join('\n');
  }

  line('时间', new Date().toLocaleString());
  line('扩展版本', api.runtime?.getManifest?.()?.version ?? '(未知)');
  line('平台', describeCapabilities(api).platform);
  line('storage.session 可用', api.storage?.session ? '是' : '否');

  // ---- 1) storage.local 的**原始内容**（键名与类型，值做打码）
  lines.push('', '=== storage.local 原始内容 ===');
  let raw = {};
  try {
    raw = (await api.storage.local.get(null)) ?? {};
  } catch (e) {
    line('读取失败', e.message);
  }
  const keys = Object.keys(raw).sort();
  if (keys.length === 0) {
    lines.push('(空 —— 存储里什么都没有)');
  } else {
    for (const k of keys) {
      const v = raw[k];
      let shown;
      if (k === STORE_KEYS.pat) shown = mask(v);
      else if (v instanceof Object && !Array.isArray(v) && !(v instanceof Date)) {
        try { shown = JSON.stringify(v).slice(0, 160); } catch { shown = '(无法序列化)'; }
      } else shown = String(v);
      line(k, `${shown}   [${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}]`);
    }
  }

  // ---- 2) 代码读取配置时实际拿到的值（走 configStore，与界面同一路径）
  lines.push('', '=== configStore.read() 的返回（界面用的就是它）===');
  let cfg = {};
  try {
    cfg = await configStore(api).read();
    for (const k of Object.keys(cfg).sort()) {
      line(k, k === STORE_KEYS.pat ? mask(cfg[k]) : String(cfg[k]));
    }
  } catch (e) {
    line('读取失败', e.message);
  }

  // ---- 3) 关键判定：键名是否与代码期望的一致
  lines.push('', '=== 关键判定 ===');
  const expect = {
    owner: [STORE_KEYS.giteeOwner, 'gitee_owner'],
    repo: [STORE_KEYS.giteeRepo, 'gitee_repo'],
    pat: [STORE_KEYS.pat, 'pat'],
    machineName: [STORE_KEYS.machineName, 'machine_name'],
    rememberDays: [STORE_KEYS.rememberDays, 'remember_days'],
    autoBackup: [STORE_KEYS.autoBackup, 'auto_backup'],
  };
  for (const [label, [key, literal]] of Object.entries(expect)) {
    const keyOk = key === literal;
    const has = raw[key] !== undefined;
    line(`${label}`, `${keyOk ? '✅' : '❌'} 键名=${key}  存在=${has ? '是' : '否'}`);
  }

  const hasOwner = Boolean(cfg[STORE_KEYS.giteeOwner] ?? cfg.gitee_owner);
  const hasRepo = Boolean(cfg[STORE_KEYS.giteeRepo] ?? cfg.gitee_repo);
  const hasToken = Boolean(cfg[STORE_KEYS.pat] ?? cfg.pat);
  lines.push('');
  line('界面会认为"已配置"', hasOwner && hasRepo && hasToken ? '✅ 是' : '❌ 否');
  line('  缺 owner', hasOwner ? '否' : '**是**');
  line('  缺 repo', hasRepo ? '否' : '**是**');
  line('  缺令牌', hasToken ? '否' : '**是**');

  // ---- 4) 会话与设备信任
  lines.push('', '=== 会话 / 设备信任 ===');
  const sess = sessionAdapter(api);
  if (!sess) lines.push('storage.session 不可用');
  else {
    try {
      const r = await sess.get('session_password');
      line('会话缓存的口令', r?.session_password ? '有' : '无');
    } catch (e) { line('会话读取失败', e.message); }
  }
  line('信任此设备(天)', String(raw[STORE_KEYS.rememberDays] ?? 0));
  line('设备密钥已生成', raw[STORE_KEYS.deviceKey] ? '是' : '否');

  // ---- 5) 写入自测：真的能写能读吗
  lines.push('', '=== 写入自测（写一个临时键再读回）===');
  const probeKey = '__upbookmarks_probe__';
  const probeVal = `probe-${Date.now()}`;
  try {
    await api.storage.local.set({ [probeKey]: probeVal });
    const back = (await api.storage.local.get(probeKey))?.[probeKey];
    line('写入→读回', back === probeVal ? `✅ 一致 (${probeVal})` : `❌ 不一致: 写 ${probeVal} / 读 ${back}`);
    await api.storage.local.remove(probeKey);
    line('清理临时键', '已完成');
  } catch (e) {
    line('写入失败', e.message);
  }

  return lines.join('\n');
}

async function refresh() {
  out.textContent = await buildReport();
}

document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(out.textContent);
    alert('报告已复制（令牌已打码）');
  } catch {
    alert('复制失败，请手动选中复制');
  }
});

/**
 * 关键对照实验：用**和选项页完全相同**的代码路径写一次，然后再读回。
 *
 * - 如果这一步成功、而选项页那边失败 → 问题在选项页自己的状态
 * - 如果这一步也失败 → 问题在 configStore / storageAdapter 这一层
 */
document.getElementById('write-config').addEventListener('click', async () => {
  const lines = ['', '=== 用 configStore 写一次测试配置 ==='];
  try {
    const cs = configStore(api);
    const patch = {
      gitee_owner: 'DEBUG-OWNER',
      gitee_repo: 'DEBUG-REPO',
      pat: 'DEBUG-TOKEN-0123456789',
      machine_name: 'DEBUG-MACHINE',
    };
    lines.push(`写入内容: ${JSON.stringify(patch)}`);
    await cs.write(patch);
    lines.push('write() 已 resolve（没抛异常）');

    const raw = (await api.storage.local.get(null)) ?? {};
    lines.push(`直接读 storage.local: ${JSON.stringify(Object.keys(raw))}`);
    lines.push(`  gitee_owner = ${raw.gitee_owner}`);

    const back = await cs.read();
    lines.push(`configStore.read(): ${JSON.stringify(Object.keys(back))}`);
    lines.push(`  gitee_owner = ${back.gitee_owner}`);

    const ok = raw.gitee_owner === 'DEBUG-OWNER' && back.gitee_owner === 'DEBUG-OWNER';
    lines.push(ok ? '✅ 这一层是好的 —— 问题在选项页' : '❌ 这一层就坏了 —— 问题在 configStore/storageAdapter');
  } catch (e) {
    lines.push(`❌ 抛异常：${e.name}: ${e.message}`);
  }
  out.textContent += lines.join('\n');
  setTimeout(refresh, 1500);
});

/** 对照：完全绕开所有封装，直接用 api.storage.local.set */
document.getElementById('raw-write').addEventListener('click', async () => {
  try {
    await api.storage.local.set({ raw_probe: `raw-${Date.now()}` });
    const back = (await api.storage.local.get('raw_probe'))?.raw_probe;
    alert(back ? `✅ 直接写也成功：${back}` : '❌ 直接写失败');
    await api.storage.local.remove('raw_probe');
  } catch (e) {
    alert(`❌ 直接写抛异常：${e.message}`);
  }
  await refresh();
});

document.getElementById('wipe-token').addEventListener('click', async () => {
  if (!confirm('清空存储里的令牌？（用于测试保存流程）')) return;
  await api.storage.local.remove(STORE_KEYS.pat);
  await refresh();
});

refresh();
